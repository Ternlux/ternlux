/**
 * Vector Database Executor Skill Plugin
 * Handles vector operations with embedding generation for LanceDB and Pinecone
 */

const path = require('path');
const { app } = require('electron');
const { generateId, prepareVectorRecords, formatVectorResults, sanitizeTableName } = require('./lib/utils');
const joinHandler = require('./joinHandler');

// Load source data helpers (similar to python-executor)
const Datastore = require('@seald-io/nedb');
const fs = require('fs');

// Vector libs (embeddings + lancedb) live at host level (public/lib) and
// arrive via params.helpers. They're bound to module-locals once at the
// start of each lifecycle method so internal call sites stay unchanged.
let generateEmbeddings, estimateOpenAICost, getEmbeddingDimension;
let executeLanceDBOperation, listLanceTables, getLanceDBConnection;

function bindLibs(helpers) {
  if (!helpers || !helpers.embeddings || !helpers.lancedb) {
    throw new Error('vector-db-executor requires helpers.embeddings and helpers.lancedb (electron must inject helpers).');
  }
  ({ generateEmbeddings, estimateOpenAICost, getEmbeddingDimension } = helpers.embeddings);
  ({ executeLanceDBOperation, listTables: listLanceTables, getLanceDBConnection } = helpers.lancedb);
}

// Normalize a vector value into a PLAIN number array. Vectors read back from
// LanceDB arrive as a Float32Array / Arrow vector (NOT a JS Array), so the old
// `Array.isArray(v) ? v : [v]` wrapped a 1536-element typed array into a
// length-1 array — which made Pinecone auto-create the index with dimension 1
// and then reject the real 1536-dim vectors ("dimension 1536 does not match the
// dimension of the index 1"). Array.from() unwraps typed arrays / iterables to
// real numbers; only a genuine scalar is wrapped as a single-element vector.
const toVectorArray = (v) => {
  if (v == null) return v;
  if (Array.isArray(v)) return v;
  if (typeof v.toArray === 'function') return Array.from(v.toArray()); // Arrow vector
  if (ArrayBuffer.isView(v) || typeof v.length === 'number') return Array.from(v); // TypedArray / array-like
  return [v]; // genuine scalar
};

const replaceNulls = (value) => {
  if (value === null) return '';

  if (Array.isArray(value)) {
    return value.map(replaceNulls);
  }

  if (typeof value === 'object' && value !== null) {
    const result = {};
    for (const key in value) {
      result[key] = replaceNulls(value[key]);
    }
    return result;
  }

  return value;
}

module.exports = {
  type: 'skill',
  id: 'vector-db-executor',
  name: 'Vector Database Executor',
  category: 'both',
  icon: './icon.svg',
  supportsInteraction: true,


  /**
   * Get skill description and capabilities
   */
  getDescription: () => ({
    name: 'Vector Database Executor',
    description: 'Perform embedding or vector operations with automatic embedding generation',
    capabilities: [
      'Generate embeddings using OpenAI or HuggingFace',
      'Embed column using OpenAI or HuggingFace',
      'Upsert vectors to LanceDB (local) or Pinecone (cloud)',
      'Query similar vectors with semantic search',
      'Delete vectors by ID or filter',
      'Update vector metadata',
      'Support for both local and cloud vector databases'
    ],
    inputFormat: 'Array of objects with text/vector fields',
    outputFormat: 'Array of vector records with metadata and similarity scores',
    executionEnvironment: 'local with external API calls for embeddings',
    providers: {
      embedding: ['OpenAI', 'HuggingFace'],
      vectorDB: ['LanceDB (local)', 'Pinecone (cloud)']
    },
    models: {
      openai: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
      huggingface: ['sentence-transformers/all-MiniLM-L6-v2', 'BAAI/bge-small-en-v1.5']
    }
  }),

  /**
   * Get prompts for AI to understand when/how to use this skill
   */
  getTransformPrompts: (context = {}) => {
    const { operationType, sourceSchema } = context;

    return {
      systemContext: `
        # Vector Database Executor Skill

        Use this skill for vector database operations that require:
        - Embedding text data into vectors
        - Storing vectors in LanceDB (local) or Pinecone (cloud)
        - Semantic search / similarity queries
        - Vector CRUD operations

        **When to use:**
        - User wants to embed text and store in vector database
        - User wants to perform semantic search
        - Source or target is a vector database (Pinecone)
        - User mentions "embeddings", "vectors", "similarity search"

        **Vector DB Types:**
        - LanceDB: Local vector database (default, no setup required)
        - Pinecone: Cloud vector database (requires API key and existing index)

        **Embedding Providers:**
        - OpenAI: text-embedding-3-small (1536 dim), text-embedding-3-large (3072 dim)
        - HuggingFace: sentence-transformers/all-MiniLM-L6-v2 (384 dim)
      `,

      responseFormat: `
        When using vector-db-executor skill, return JSON:
        {
          "usesSkill": true,
          "skillId": "vector-db-executor",
          "skillParams": {
            "vectorDbType": "lancedb" | "pinecone",
            "operation": "upsert" | "query" | "delete" | "update",
            "embeddingProvider": "openai" | "huggingface",
            "embeddingModel": "text-embedding-3-small",
            "columnToEmbed": "column_name",
            "targetTable": "table_name"
          },
          "explanation": "Why this skill is needed"
        }
      `
    };
  },

  /**
   * Build skill-specific prompt for AI interaction
   */
  buildSkillPrompt: async (params) => {
    bindLibs(params.helpers);
    // console.log('params: ', params)
    const {
      userRequest,
      sourceTableSchema,
      sourceConnection,
      operation,
      operationType,
      apiKeys,
      vectorConnectors,
      pluginManager,
      getFullConfig
    } = params;

    // Fetch available connections from the database (using same pattern as electron.js getDb)
    const connectionsDbPath = path.join(app.getPath('userData'), 'ternlux-connections.db');
    const connectionsDb = new Datastore({ filename: connectionsDbPath, autoload: true });

    const availableConnections = await new Promise((resolve, reject) => {
      connectionsDb.find({}, (err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // console.log('availableConnections: ', availableConnections)
    const columns = sourceTableSchema?.columns || [];
    const columnsList = columns.map(c => `${c.name} (${c.type})`).join(', ');

    // Check if we have any embedding API keys
    // OpenAI embeddings use the 'chatgpt' key (same as ChatGPT API)
    // HuggingFace has its own key
    const hasOpenAI = apiKeys && apiKeys.chatgpt;
    const hasHuggingFace = apiKeys && apiKeys.huggingface;
    const hasAnyEmbeddingKey = hasOpenAI || hasHuggingFace;

    // If no embedding keys, return error
    if (!hasAnyEmbeddingKey) {
      return {
        prompt: `Error: No embedding API keys configured.

To use vector operations, you need to set up an embedding provider API key:
- OpenAI API key (for OpenAI embeddings)
- HuggingFace API key (for HuggingFace embeddings)

Please configure an embedding API key in settings before proceeding.`,
        context: { error: true, missingKeys: true }
      };
    }

    // Determine available embedding providers
    const availableProviders = [];
    if (hasOpenAI) {
      availableProviders.push({
        name: 'OpenAI',
        id: 'openai',
        models: [
          'text-embedding-3-small (1536 dim, $0.02/1M tokens)',
          'text-embedding-3-large (3072 dim, $0.13/1M tokens)',
          'text-embedding-ada-002 (1536 dim, $0.10/1M tokens)'
        ]
      });
    }
    if (hasHuggingFace) {
      availableProviders.push({
        name: 'HuggingFace',
        id: 'huggingface',
        models: [
          'sentence-transformers/all-MiniLM-L6-v2 (384 dim)',
          'BAAI/bge-small-en-v1.5 (384 dim)',
          'BAAI/bge-base-en-v1.5 (768 dim)'
        ]
      });
    }

    // Determine available vector databases and their connections
    const vectorDbConnections = []; // Map dbType -> array of connections

    // Always include LanceDB (local, no plugin needed)
    vectorDbConnections.push({
      name: 'LanceDB',
      id: 'lancedb',
      dbType: 'LanceDB',
      cloud: 'Local'
    });

    // Add installed vector database plugins and find their connections
    if (vectorConnectors && vectorConnectors.length > 0) {
      vectorConnectors.forEach(connector => {

        // Find all connections for this vector database type
        if (availableConnections && availableConnections.length > 0) {
          const connectionsForType = availableConnections.filter(conn =>
            conn.dbType === connector.id || conn.dbCategory === 'Vector'
          );

          if (connectionsForType.length > 0) {
            connectionsForType.map(conn => vectorDbConnections.push({
              id: conn._id || conn.id,
              name: conn.name,
              dbType: conn.dbType
            }));
          }
        }
      });
    }
    // console.log('vectorConnectors; ', vectorConnectors, vectorDbConnections)

    // Check if source is already a vector database
    const isSourceVector = sourceConnection?.dbCategory === 'Vector';
    const sourceVectorDbType = isSourceVector ? sourceConnection?.dbType : null;

    // Fetch sample data from vector source if applicable
    let sampleData = [];
    let sampleDataFormatted = '';
    if (isSourceVector) {

      sampleData = await fetchVectorSampleData({
        sourceConnection,
        sourceTableSchema,
        pluginManager,
        getFullConfig,
        sampleSize: 2
      });
      // console.log('sampleData: ', sampleData)
      if (sampleData.length > 0) {
        sampleDataFormatted = sampleData.map((record, idx) => {
          const recordCopy = { ...record };

          // For Pinecone, show id, metadata, and vector dimension
          if (sourceVectorDbType === 'pinecone') {
            const vectorDim = record.values?.length || record.vector?.length || 0;
            return `Record ${idx + 1}:
  - id: ${record.id}
  - vector: [${vectorDim} dimensions]
  - metadata: ${JSON.stringify(record.metadata || {}, null, 4).split('\n').join('\n    ')}${record.namespace ? `\n  - namespace: ${record.namespace}` : ''}`;
          } else {
            // For LanceDB, show all fields directly
            const vectorDim = record.vector?.length || record.values?.length || 0;
            if (recordCopy.vector) delete recordCopy.vector;
            if (recordCopy.values) delete recordCopy.values;

            return `Record ${idx + 1}:
  - id: ${record.id}
  - vector: [${vectorDim} dimensions]
  - fields: ${JSON.stringify(recordCopy, null, 4).split('\n').join('\n    ')}`;
          }
        }).join('\n\n');
      }
    }

    // If source is vector DB, this is a transformation operation (like NeDB)
    // If source is regular data, this is an embedding+insert operation
    const prompt = isSourceVector ? `
You are a ${sourceVectorDbType} expert helping transform vectors in-place.

**Database Type:** ${sourceVectorDbType} (vector database)
**User's request:** "${params.userRequest}"

**Source Vector Database:**
- Type: ${sourceVectorDbType}
- Index/Table: ${sourceTableSchema?.tableName || 'Unknown'}
${sourceVectorDbType === 'pinecone' ? `- Available metadata fields: ${columnsList || 'None'}\n` : ''}
${sampleDataFormatted ? `**Sample Data:**\n${sampleDataFormatted}\n` : ''}
How Vector Transformations Work:

1. Search/Filter: Find vectors using either:
   - **Embedding Search** (semantic similarity): Set useEmbeddingSearch=true and provide searchQuery text
   - **Metadata Filter**: Set useEmbeddingSearch=false and provide filter

2. **Transform Each Record**: For each found vector, apply a JavaScript function:
   - Return modified record → **UPDATE** it in database
   - Return null → **DELETE** it from database
   - Return unchanged record → **SKIP** (no operation)

**Search Methods for ${sourceVectorDbType}:**
${sourceVectorDbType === 'pinecone' ? `
- **Embedding Search**: useEmbeddingSearch=true, searchQuery="your text"
  - Finds semantically similar vectors
  - Example: searchQuery="technical documentation"
- **Metadata Filter**: useEmbeddingSearch=false, filter={ "category": "tech" }
  - JSON object for Pinecone metadata filtering
  - Supports operators: { "year": { "$gte": 2020 } }
- **All Records**: useEmbeddingSearch=false, filter={}
` : `
- **Embedding Search**: useEmbeddingSearch=true, searchQuery="your text"
  - Finds semantically similar vectors
  - Example: searchQuery="technical documentation"
- **SQL Filter**: useEmbeddingSearch=false, filter="category = 'tech'"
  - SQL WHERE clause for LanceDB
  - Example: "status = 'active' AND year >= 2020"
- **All Records**: useEmbeddingSearch=false, filter=""
`}

**Transform Function:**
- Signature: \`function transformRecord(record, state) { return { record, state }; }\`
- **Input:**
  - record.id (unique identifier)
  - record.vector (embedding array)
${sourceVectorDbType === 'pinecone' ? `  - record.metadata (all metadata fields as object)
  - record.namespace (Pinecone namespace)` : `  - record fields (all data fields directly on record object, not in metadata)`}
  - state (shared object across ALL records - use to maintain state)
    - State persists between records during the loop
    - make sure that the variable types are consistent within the function and in the state
    - Useful for: counting, grouping, tracking changes across records
- **Output:** Must return object with { record, state }
  - record = modified object → UPDATE in database
  - record = null → DELETE from database
  - record = unchanged → SKIP (no operation)
  - state = updated state object → passed to next record
- **Initial State:**
  - Optionally provide initialState object to set initial values
  - Default: {} (empty object)

**Response Format:**

**For Questions** (user asking about the data):
{
  "action": "answer_directly",
  "directAnswer": "Your answer to their question"
}

**For Clarification** (need more info):
IMPORTANT: Ask SIMPLE, user-friendly questions. DO NOT use technical terms like "embedding search", "metadata filter", "useEmbeddingSearch", etc.
Instead, ask about WHAT the user wants to accomplish in plain language.
{
  "action": "ask_questions",
  "questionsNeeded": {
    "criteria": "Which records should be affected? All records or only specific ones?",
    "changes": "What specific changes should be made to each record?"
  }
}

**For Execution** (ready to transform):
{
  "action": "execute",
  "useEmbeddingSearch": true | false,
  "searchQuery": "text to search" | null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{ \\"field\\": \\"value\\" }" | "{}"' : '"SQL WHERE" | ""'},
  "transformFunction": "function transformRecord(record, state) { /* your code */ return { record, state }; }",
  "initialState": {},  // Optional: initial state values
  "explanation": "Brief description of what this does"
}

**Examples:**

Answer a question:
{
  "action": "answer_directly",
  "directAnswer": "This vector database contains ${sourceTableSchema?.sampleData?.length || 0} vectors with metadata fields: ${columnsList}. Each vector represents embedded content from your documents."
}

Ask for clarification (simple user-friendly questions):
{
  "action": "ask_questions",
  "questionsNeeded": {
    "scope": "Should I update all records or only specific ones?",
    "changes": "What field should I update and what should the new value be?"
  }
}

Update with embedding search:
{
  "action": "execute",
  "useEmbeddingSearch": true,
  "searchQuery": "product documentation",
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { ${sourceVectorDbType === 'pinecone' ? 'r.metadata.category = \'docs\'; r.metadata.updated_at = new Date().toISOString();' : 'r.category = \'docs\'; r.updated_at = new Date().toISOString();'} return { record: r, state }; }",
  "initialState": {},
  "explanation": "Find vectors similar to 'product documentation' and categorize them as docs"
}

Delete with metadata filter:
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{ \\"status\\": \\"archived\\" }"' : '"status = \'archived\'"'},
  "transformFunction": "function transformRecord(r, state) { return { record: null, state }; }",
  "initialState": {},
  "explanation": "Delete all archived vectors"
}

Conditional update/delete:
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { ${sourceVectorDbType === 'pinecone' ? 'if (r.metadata.views < 10) return { record: null, state }; r.metadata.popular = true;' : 'if (r.views < 10) return { record: null, state }; r.popular = true;'} return { record: r, state }; }",
  "initialState": {},
  "explanation": "Delete low-view records (<10), mark others as popular"
}

Using state (counting updates):
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { state.count = (state.count || 0) + 1; ${sourceVectorDbType === 'pinecone' ? 'r.metadata.batch_number' : 'r.batch_number'} = Math.floor(state.count / 100); return { record: r, state }; }",
  "initialState": { count: 0 },
  "explanation": "Add batch_number to metadata based on processing order"
}

Provide working ${sourceVectorDbType} transformations that answer questions OR execute transformations.
` : `
You are helping embed regular data into a vector database.

**Source Data (Non-Vector):**
- Connection: ${sourceConnection?.name || 'Unknown'}
- Table: ${sourceTableSchema?.tableName || 'Unknown'}
- Columns: ${columnsList || 'None'}
- Total Records: ${sourceTableSchema?.sampleData?.length || 'Unknown'}

**User's Request:** "${params.userRequest || 'Embed and store in vector database'}"

**Important — No source filtering:** This skill does NOT filter the data
imported from the source. ALL records from the source are embedded and
included in the import; there is currently no option to narrow down,
filter, or exclude rows on the way in. If the user asks to import only a
subset of the data, explain that filtering is not supported here and that
they should filter the data upstream (e.g. with a transformer) before it
reaches this step.

**Available Embedding Providers (you have API keys for):**
${availableProviders.map((p, idx) => `
${idx + 1}. **${p.name}** (${p.id})
   Models:
${p.models.map(m => `   - ${m}`).join('\n')}
`).join('\n')}

**Available Vector Connections:**
${vectorDbConnections.map((value) =>  `\n- connectionName: "${value.name}", connectionId: "${value.id}", "dbType: "${value.dbType}"`
)}


**Your Task:**
Determine the configuration for embedding this data based on chat history and users input:
1. Which column contains the text to embed (REQUIRED)
2. Which embedding provider to use (based on available keys above)
3. Which embedding model to use
4. Which vector database to store in (based on available databases above)
5. For cloud vector databases: which connection to use (if multiple available)
6. Target table/index name

**Important Decision Rules:**
- Only use embedding providers that have API keys configured (listed above)
- If only one embedding provider is available, use it by default
- If no vector database plugins are installed, default to LanceDB
- For cloud vector databases (non-LanceDB):
  - If only ONE connection exists for that database type, use it automatically
  - If MULTIPLE connections exist, ask the user which connection to use (by connection name)
  - Return the connection name in "targetConnectionName" field
- If multiple choices exist, ask the user to clarify
- MUST determine which column to embed

**Response Format:**

**Action Type**: Determine what to do:
- "answer_directly": User is asking a question that doesn't require embedding/transformation
- "ask_questions": Need to ask clarifying questions before proceeding
- "execute": Ready to execute the embedding operation

If answering directly:
{
  "action": "answer_directly",
  "directAnswer": "Your answer to the user's question"
}

If you need to ask questions:
{
  "action": "ask_questions",
  "questionsNeeded": {
    "columnToEmbed": "Which column should be embedded? (only if not specified by user)",
    "embeddingProvider": "Which embedding provider? (only if multiple available and user didn't specify)",
    "vectorDbType": "Which vector database? (only if multiple available and user didn't specify)",
    "targetConnectionName": "Which connection should be used? Options: [connection names] (only if cloud vector DB with multiple connections)",
    "targetTable": "What should the target table/index be named? (only if user didn't specify)",
    "indexName": "Which index to use? (only if applicable and user didn't specify)"
  }
}

If ready to execute:
{
  "action": "execute",
  "vectorDbType": "lancedb" | "pinecone" | "other_vector_db",
  "operation": "upsert",
  "embeddingProvider": "${availableProviders.map(p => p.id).join('" | "')}",
  "embeddingModel": "model_name",
  "columnToEmbed": "column_name",
  "targetTable": "vectors_table_name",
  "targetConnectionName": "connection_name",  // REQUIRED for cloud vector DBs, omit for LanceDB
  "indexName": "index_name",  // For databases that use indexes (Pinecone, etc.)
  "namespace": "optional_namespace",  // For databases that use namespaces
  "explanation": "Explanation of what will happen"
}

IMPORTANT:
- For LanceDB: Do NOT include "targetConnectionName", "indexName", or "namespace"
- For cloud vector DBs: MUST include "targetConnectionName" (use the connection name from available connections list)
- If only one connection exists for a cloud vector DB, use that connection's name automatically
- For Pinecone indexName: MUST use lowercase letters, numbers, and hyphens only (no underscores, no uppercase)
  - Good: "my-index-name", "embeddings-2024", "user-vectors"
  - Bad: "My_Index", "root_test_embeddings" (has underscores), "UserVectors" (has uppercase)
`;

    // Close the conditional prompt

    return {
      prompt,
      context: {
        sourceTableSchema,
        sourceConnection,
        operation,
        isSourceVector,
        sourceVectorDbType,
        vectorDbConnections,
        availableConnections
      }
    };
  },

  /**
   * Process AI response for skill execution
   */
  processSkillResponse: (aiResponse, operationType, currentState = {}, availableConnections = []) => {
    try {
      let parsed;
      if (typeof aiResponse === 'string') {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = aiResponse.match(/```json?\n?([\s\S]*?)\n?```/) || aiResponse.match(/{[\s\S]*}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } else {
          return {
            action: 'answer_directly',
            message: aiResponse
          };
        }
      } else {
        parsed = aiResponse;
      }
      console.log('parsed: ', parsed)
      // Check if this is a vector source transformation
      const isSourceVector = currentState.isSourceVector === true;

      // Validate required fields
      if (parsed.action === 'execute') {
        if (isSourceVector) {
          // For vector source transformations
          if (!parsed.transformFunction) {
            return {
              action: 'ask_questions',
              message: 'I need to know how to transform the data',
              questionsNeeded: { transformLogic: 'What changes should I make to each record?' }
            };
          }

          // Validate search method
          if (parsed.useEmbeddingSearch && !parsed.searchQuery) {
            return {
              action: 'ask_questions',
              message: 'I need to know which records to find',
              questionsNeeded: { searchCriteria: 'What should I search for to find the relevant records?' }
            };
          }

          // Warn if no filter and no embedding search
          if (!parsed.useEmbeddingSearch && (!parsed.filter || parsed.filter === '' || parsed.filter === '{}')) {
            console.warn('No filter or search query - transformation will affect ALL vectors');
          }

        } else {
          // For regular embedding operations
          const required = ['vectorDbType', 'operation'];
          for (const field of required) {
            if (!parsed[field]) {
              return {
                action: 'ask_questions',
                message: `Missing required field: ${field}`,
                questionsNeeded: { [field]: true }
              };
            }
          }

          // For upsert/query operations, embeddings are usually needed
          if (['upsert', 'query'].includes(parsed.operation)) {
            if (!parsed.embeddingProvider || !parsed.columnToEmbed) {
              return {
                action: 'ask_questions',
                message: 'Missing embedding configuration',
                questionsNeeded: {
                  embeddingProvider: !parsed.embeddingProvider,
                  columnToEmbed: !parsed.columnToEmbed
                }
              };
            }
          }
        }

        // Map targetConnectionName to targetConnectionId for cloud vector databases
        if (parsed.vectorDbType && parsed.vectorDbType !== 'lancedb') {
          const connectionsForType = availableConnections.filter(conn =>
            conn.dbType === parsed.vectorDbType || conn.dbCategory === 'Vector'
          );

          // If targetConnectionName provided, map it to ID
          if (parsed.targetConnectionName) {
            const connection = connectionsForType.find(conn =>
              conn.name === parsed.targetConnectionName
            );
            // console.log('connectionsForType: ', availableConnections, connectionsForType, connection, parsed.targetConnectionName)
            if (connection) {
              parsed.targetConnectionId = connection.id;
              console.log(`Mapped connection "${parsed.targetConnectionName}" to ID: ${connection.id}`);
            } else {
              return {
                action: 'ask_questions',
                message: `Connection "${parsed.targetConnectionName}" not found for ${parsed.vectorDbType}`,
                questionsNeeded: {
                  targetConnectionName: `Which connection should be used? Available: ${
                    connectionsForType.map(c => c.name).join(', ')
                  }`
                }
              };
            }
          }
          // If no connection name provided, check if we can auto-select
          else if (connectionsForType.length === 1) {
            // Only one connection exists, use it automatically
            parsed.targetConnectionId = connectionsForType[0].id;
            parsed.targetConnectionName = connectionsForType[0].name;
            console.log(`Auto-selected connection "${parsed.targetConnectionName}" (ID: ${parsed.targetConnectionId})`);
          }
          else if (connectionsForType.length > 1) {
            // Multiple connections, need to ask user
            return {
              action: 'ask_questions',
              message: `Multiple ${parsed.vectorDbType} connections available. Which one should be used?`,
              questionsNeeded: {
                targetConnectionName: `Which connection should be used? Available: ${
                  connectionsForType.map(c => c.name).join(', ')
                }`
              }
            };
          }
          else {
            // No connections found
            return {
              action: 'ask_questions',
              message: `No ${parsed.vectorDbType} connections found. Please create a connection first.`,
              questionsNeeded: {}
            };
          }
        }

        return {
          action: 'execute',
          skillParams: parsed,
          readyToExecute: true,
          // Include these at top level for UI display
          transformFunction: parsed.transformFunction,
          initialState: parsed.initialState,
          explanation: parsed.explanation,
          useEmbeddingSearch: parsed.useEmbeddingSearch,
          searchQuery: parsed.searchQuery,
          filter: parsed.filter
        };
      }

      return parsed;
    } catch (error) {
      console.error('Failed to process skill response:', error);
      return {
        action: 'answer_directly',
        message: `I need more information to proceed. ${error.message}`
      };
    }
  },

  /**
   * Main execution function
   * Similar to python-executor's execute method
   */
  execute: async (params) => {
    bindLibs(params.helpers);
    const startTime = Date.now();

    try {
      const {
        sourceConnection,
        sourceTableSchema,
        vectorDbType,
        operation,
        embeddingProvider,
        embeddingModel,
        embeddingApiKey,
        columnToEmbed,
        targetTable,
        targetConnectionId,
        pineconeConfig,
        lancedbConfig,
        queryText,
        queryVector,
        topK = 10,
        filter,
        transformFunction,
        initialState,
        useEmbeddingSearch,
        searchQuery,
        operationType,
        nodeId,
        sourceNodeId,
        pluginManager,
        getFullConfig,
        appSqliteDbPath,
        sqlitePool,
        targetLocalPath, // Path for local LanceDB storage
        storageLocation,
        operationMode
      } = params;
      console.log('params: ', params)
      // Check if this is a vector source transformation (UPDATE/DELETE with JavaScript)
      const isSourceVector = sourceConnection?.dbCategory === 'Vector' || sourceConnection?.sourceDbCategory  === 'Vector';

      if (isSourceVector) {
        console.log(`\n=== Vector Source Transformation ===`);
        console.log(`Source Vector DB: ${sourceConnection.dbType}`);
        console.log(`Search method: ${useEmbeddingSearch ? 'Embedding search' : 'Filter'}`);

        // Handle JavaScript transformations for vector sources
        return await executeVectorSourceTransformation({
          sourceConnection,
          sourceTableSchema,
          transformFunction,
          initialState,
          useEmbeddingSearch,
          searchQuery,
          filter,
          embeddingProvider,
          embeddingModel,
          embeddingApiKey,
          pluginManager,
          getFullConfig,
          appSqliteDbPath,
          sqlitePool,
          nodeId,
          sourceNodeId,
          startTime,
          targetLocalPath, // Pass targetLocalPath for potential local storage
          storageLocation,
          operationMode
        });
      }

      console.log(`\n=== Vector DB Executor: ${operation} operation ===`);
      console.log(`Vector DB: ${vectorDbType}`);
      console.log(`Embedding Provider: ${embeddingProvider} (${embeddingModel})`);

      let sourceData = [];
      let embeddedData = [];
      let result;

      // Step 1: Load source data (for upsert/update operations)
      if (['upsert', 'update'].includes(operation)) {
        console.log('Loading source data...');
        sourceData = await loadSourceData({
          sourceConnection,
          sourceTableSchema,
          operationType,
          pluginManager,
          getFullConfig,
          sqlitePool,
          appSqliteDbPath
        });

        console.log(`Loaded ${sourceData.length} records from source`);

        if (sourceData.length === 0) {
          return {
            success: false,
            message: 'No data found in source table'
          };
        }

        // Step 2: Generate embeddings
        console.log(`Generating embeddings for column: ${columnToEmbed}...`);

        // Estimate cost for OpenAI
        if (embeddingProvider === 'openai') {
          const texts = sourceData.map(row => row[columnToEmbed]).filter(t => t);
          const { tokens, estimatedCost } = estimateOpenAICost(texts, embeddingModel);
          console.log(`Estimated cost: $${estimatedCost.toFixed(4)} (${tokens.toLocaleString()} tokens)`);

          if (estimatedCost > 1.0) {
            console.warn(`⚠️  High embedding cost: $${estimatedCost.toFixed(2)}`);
          }
        }

        embeddedData = await generateEmbeddings({
          data: sourceData,
          columnToEmbed,
          provider: embeddingProvider,
          model: embeddingModel,
          apiKey: embeddingApiKey
        });

        console.log(`Generated ${embeddedData.length} embeddings`);

        // Step 2.5: Check for duplicates before inserting (upsert operation only)
        if (operation === 'upsert') {
          console.log('Checking for existing records to avoid duplicates...');
          // let newRecords;

          // if (vectorDbType === 'lancedb') {
          //   // Use LanceDB's filterDuplicates function
          //   newRecords = await filterDuplicatesLanceDB({
          //     embeddedData,
          //     targetTable: targetTable || sanitizeTableName(sourceTableSchema?.tableName || 'vectors')
          //   });
          // } else {
          //   // Use connector's filterDuplicates method
          //   const fullConfig = await getFullConfig(targetConnectionId);
          //   const connector = pluginManager.getConnector(vectorDbType);

          //   if (connector && typeof connector.filterDuplicates === 'function') {
          //     newRecords = await connector.filterDuplicates(
          //       fullConfig,
          //       targetConnectionId,
          //       {
          //         embeddedData,
          //         indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
          //         namespace: params.namespace || ''
          //       }
          //     );
          //   } else {
          //     console.warn(`${vectorDbType} does not support duplicate filtering, proceeding with all records`);
          //     newRecords = embeddedData;
          //   }
          // }

          // const duplicateCount = embeddedData.length - newRecords.length;
          // if (duplicateCount > 0) {
          //   console.log(`Filtered out ${duplicateCount} duplicate records`);
          // }

          // embeddedData = newRecords;

          if (embeddedData.length === 0) {
            return {
              success: true,
              message: 'All records already exist in the database (duplicates filtered)',
              recordCount: 0,
              duplicatesFiltered: duplicateCount
            };
          }
        }
      }

      // Step 3: Execute vector operation
      if (vectorDbType === 'lancedb') {
        // Build LanceDB config with targetLocalPath if provided
        const lancedbConfigToUse = {
          ...(lancedbConfig || {}),
          // Use targetLocalPath if provided (for transformer nodes with local storage)
          ...(targetLocalPath ? { dbPath: targetLocalPath } : {})
        };

        result = await executeLanceDB({
          operation,
          data: embeddedData,
          queryText,
          queryVector,
          topK,
          filter,
          targetTable: targetTable || sanitizeTableName(sourceTableSchema?.tableName || 'vectors'),
          lancedbConfig: lancedbConfigToUse,
          embeddingProvider,
          embeddingModel,
          embeddingApiKey,
          columnToEmbed,
          // A new_table embed is a fresh write — overwrite so re-runs don't
          // accumulate duplicate rows (and don't drift the column schema).
          overwrite: operationMode === 'new_table'
        });
      } else {
        // For cloud vector databases (Pinecone, etc.), use connector's executeVectorOperation
        if (!targetConnectionId) {
          throw new Error(`${vectorDbType} requires a target connection ID`);
        }

        const fullConfig = await getFullConfig(targetConnectionId);
        // console.log('fullConfig: ', fullConfig);

        if (!fullConfig || !fullConfig.apiKey) {
          throw new Error(`Unable to load credentials for connection: ${targetConnectionId}`);
        }

        const connector = pluginManager.getConnector(vectorDbType);
        if (!connector) {
          throw new Error(`${vectorDbType} connector not found`);
        }

        if (typeof connector.executeVectorOperation !== 'function') {
          throw new Error(`${vectorDbType} connector does not support executeVectorOperation`);
        }

        // Prepare data for vector operation
        const vectorData = embeddedData.map(record => ({
          id: record.id || generateId(),
          vector: record.vector,
          metadata: (() => {
            const meta = { ...record };
            delete meta.vector;
            delete meta._embedded_column;
            delete meta._embedding_provider;
            delete meta._embedding_model;
            delete meta._embedded_at;
            return meta;
          })()
        }));

        result = await connector.executeVectorOperation(
          fullConfig,
          targetConnectionId,
          {
            operation,
            indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
            namespace: params.namespace || '',
            data: vectorData,
            queryVector,
            topK,
            filter
          }
        );
      }

      // Bail out before saving if the operation itself failed — otherwise we'd
      // wrap a failed result in a success envelope.
      if (!result || result.success === false) {
        return {
          success: false,
          message: result?.message || `${vectorDbType} ${operation} operation failed`,
          error: result?.error,
          data: result?.data || [],
          recordCount: result?.recordCount || 0,
          executionTime: Date.now() - startTime
        };
      }

      // Step 4: Save results to local storage
      const savedConfig = await saveVectorResults({
        result,
        operation,
        vectorDbType,
        targetTable: targetTable || sourceTableSchema?.tableName || 'vectors',
        nodeId,
        sourceNodeId,
        sourceConnection,
        sourceTableSchema,
        appSqliteDbPath,
        sqlitePool,
        targetConnectionId,
        namespace: params.namespace || '',
        indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
        targetLocalPath,
        targetConnectionName: sourceConnection?.name,
        embeddingProvider,
        embeddingModel,
        columnToEmbed,
        embeddedData
      });

      const executionTime = Date.now() - startTime;

      console.log(`=== Vector operation completed in ${executionTime}ms ===\n`);

      return {
        success: true,
        data: result.data || [],
        recordCount: result.recordCount || 0,
        config: savedConfig,
        message: result.message,
        executionTime
      };

    } catch (error) {
      console.error('Vector DB execution failed:', error);

      return {
        success: false,
        message: `Vector database operation failed: ${error.message}`,
        error: error.stack,
        executionTime: Date.now() - startTime
      };
    }
  },

  /**
   * Query vector database for preview (first 10 records)
   * Called from DataPreview component
   */
  queryVectorPreview: async (params) => {
    bindLibs(params.helpers);
    try {
      const {
        vectorDbType,
        tableName,
        namespace = '',
        dbConfig,
        connectionId,
        pluginManager,
        getFullConfig,
        targetLocalPath
      } = params;

      // console.log(`Querying ${vectorDbType} for preview: ${tableName}`);
      // console.log('queryVectorPreview: ', params)
      if (vectorDbType === 'lancedb') {
        // Use targetLocalPath first, then dbConfig.dbPath, then default
        const dbPath = targetLocalPath || dbConfig?.dbPath || path.join(
          require('electron').app.getPath('userData'),
          'data',
          'lancedb'
        );

        const db = await getLanceDBConnection({ dbPath });
        const table = await db.openTable(tableName);

        // Get table info
        const count = await table.countRows();
        console.log('dbPath: ', dbPath, tableName, table, count)

        // Fetch first 10 vectors using query (not search which requires a vector)
        const iterator = await table.query().limit(10).toArray();

        // Format for display - compact vector representation
        const formattedResults = iterator.map(row => ({
          ...row,
          vector: `[${row.vector?.length || 0} dims]`
        }));

        return {
          success: true,
          data: formattedResults,
          recordCount: formattedResults.length,
          totalRows: count,
          isJson: true,
          storageType: 'LanceDB'
        };

      } else if (vectorDbType === 'pinecone') {
        // For Pinecone, use the connector to fetch first 10 vectors
        if (!pluginManager || !getFullConfig) {
          return {
            success: false,
            message: 'Pinecone preview requires pluginManager and getFullConfig'
          };
        }

        const connector = pluginManager.getConnector('pinecone');
        if (!connector) {
          return {
            success: false,
            message: 'Pinecone connector not found'
          };
        }

        const fullConfig = await getFullConfig(connectionId);

        if (!fullConfig || !fullConfig.apiKey) {
          return {
            success: false,
            message: 'Unable to load Pinecone credentials'
          };
        }

        const result = await connector.fetchAllVectors(
          fullConfig,  // fullConfig is now { apiKey: 'key' } directly
          connectionId,
          {
            indexName: tableName,
            namespace: namespace,
            filter: {},
            includeValues: true,
            includeMetadata: true,
            limit: 10
          }
        );

        if (!result.success) {
          return {
            success: false,
            message: `Failed to fetch Pinecone vectors: ${result.message}`
          };
        }

        // Format for display - compact vector representation
        const formattedResults = (result.rows || []).map(row => ({
          ...row,
          values: `[${row.values?.length || 0} dims]`
        }));

        return {
          success: true,
          data: formattedResults,
          recordCount: formattedResults.length,
          isJson: true,
          storageType: 'Pinecone'
        };
      }

      return {
        success: false,
        message: `Unknown vector database type: ${vectorDbType}`
      };

    } catch (error) {
      console.error('Vector preview failed:', error);
      return {
        success: false,
        message: `Preview failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Execute data-to-vector transfer
   * Takes data from any source and inserts into vector database
   * Used by Output nodes to transfer data to vector databases
   */
  executeDataToVector: async (params) => {
    bindLibs(params.helpers);
    const {
      sourceData,
      targetConnection,
      targetIndexName,
      targetNamespace = '',
      pluginManager,
      getFullConfig
    } = params;

    try {
      const dbType = targetConnection.dbType;
      const startTime = Date.now();

      console.log(`[Vector Output] Starting data-to-vector transfer to ${dbType}`);
      console.log(`[Vector Output] Source data: ${sourceData.length} rows`);

      // Check if we have data to insert
      if (!sourceData || sourceData.length === 0) {
        return {
          success: false,
          message: 'No data to insert'
        };
      }

      // For now, we expect the source data to already contain vectors
      // Check if data has vector fields
      const hasVectors = sourceData.some(row =>
        row.vector || row.values || row.embedding
      );

      if (!hasVectors) {
        return {
          success: false,
          message: 'Source data does not contain vector fields (vector, values, or embedding). Please transform data to include embeddings before outputting to vector database.'
        };
      }

      // Prepare vector records
      const vectorRecords = sourceData.map((row, idx) => {
        const vector = row.vector || row.values || row.embedding;
        const id = row.id || row._id || generateId();

        if (dbType === 'pinecone') {
          // Pinecone: metadata structure
          // Check if source already has metadata field (from another vector DB)
          let metadata;
          if (row.metadata && typeof row.metadata === 'object') {
            // Source is already a vector DB with metadata - use it directly
            metadata = { ...row.metadata };
          } else {
            // Source is regular data - create metadata from all fields
            metadata = { ...row };
            delete metadata.vector;
            delete metadata.values;
            delete metadata.embedding;
            delete metadata.id;
            delete metadata._id;
            delete metadata.namespace;
            delete metadata.metadata; // In case it exists but is not an object
          }

          return {
            id,
            values: toVectorArray(vector),
            metadata,
            namespace: targetNamespace
          };
        } else {
          // LanceDB: flat structure
          const record = { ...row, id };
          record.vector = toVectorArray(vector);
          delete record.values;
          delete record.embedding;
          delete record._id;

          // Flatten metadata object if it exists (from Pinecone source)
          if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
            const metadataFields = { ...record.metadata };
            delete record.metadata;
            Object.assign(record, metadataFields);
          }

          // Replace null values with empty strings to avoid Arrow IPC dictionary issues
          Object.keys(record).forEach(key => {
            if (record[key] === null || record[key] === undefined) {
              record[key] = '';
            }
          });

          return record;
        }
      });

      console.log(`[Vector Output] Prepared ${vectorRecords.length} vector records`);

      // Insert vectors based on database type
      if (dbType === 'lancedb') {
        // LanceDB: Use embedded library
        const dbPath = targetConnection.localPath || targetConnection.dbConfig?.dbPath;
        if (!dbPath) {
          return {
            success: false,
            message: 'LanceDB path not found in connection config'
          };
        }

        const result = await executeLanceDBOperation({
          operation: 'upsert',
          data: vectorRecords,
          dbPath,
          tableName: targetIndexName
        });

        if (result.success) {
          return {
            success: true,
            message: `Successfully inserted ${vectorRecords.length} vectors into LanceDB table '${targetIndexName}'`,
            vectorsInserted: vectorRecords.length,
            executionTime: Date.now() - startTime
          };
        } else {
          return {
            success: false,
            message: `Failed to insert vectors into LanceDB: ${result.message}`
          };
        }

      } else {
        // All other vector DBs: use connector plugin with executeVectorOperation
        const fullConfig = await getFullConfig(targetConnection.id);
        const connector = pluginManager.getConnector(targetConnection.dbType);

        if (!connector) {
          return {
            success: false,
            message: `Connector not found for ${dbType}`
          };
        }

        if (!connector.executeVectorOperation) {
          return {
            success: false,
            message: `${dbType} connector does not support executeVectorOperation`
          };
        }

        // Use executeVectorOperation which handles index creation and upsert
        const result = await connector.executeVectorOperation(
          fullConfig,
          fullConfig.id,
          {
            operation: 'upsert',
            indexName: targetIndexName,
            namespace: targetNamespace,
            data: vectorRecords
          }
        );

        if (result.success) {
          return {
            success: true,
            message: `Successfully inserted ${vectorRecords.length} vectors into ${dbType} index '${targetIndexName}'${targetNamespace ? `/${targetNamespace}` : ''}`,
            vectorsInserted: vectorRecords.length,
            executionTime: Date.now() - startTime
          };
        } else {
          return {
            success: false,
            message: `Failed to insert vectors: ${result.message}`
          };
        }
      }

    } catch (error) {
      console.error('[Vector Output] Error:', error);
      return {
        success: false,
        message: `Vector insertion failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Export data to LanceDB as a local file
   * Used by Output nodes when exporting to local LanceDB
   */
  exportToLanceDB: async (params) => {
    bindLibs(params.helpers);
    const { sourceData, savePath } = params;

    try {
      const startTime = Date.now();

      console.log(`[LanceDB Export] Starting export to ${savePath}`);
      console.log(`[LanceDB Export] Source data: ${sourceData.length} rows`);

      // Check if data has vector fields
      const hasVectors = sourceData.some(row => row.vector || row.values || row.embedding);

      if (!hasVectors) {
        return {
          success: false,
          message: 'LanceDB export requires data to have vector fields (vector, values, or embedding). Transform your data to include embeddings first.'
        };
      }

      const path = require('path');

      // Parse directory and table name from savePath
      // Expected format: /path/to/lancedb-dir or /path/to/lancedb-dir/tablename
      let dbPath, tableName;

      if (savePath.endsWith('.lance')) {
        // User selected a .lance directory
        dbPath = path.dirname(savePath);
        tableName = path.basename(savePath, '.lance');
      } else {
        // Assume the last segment is the table name, rest is directory
        const parts = savePath.split(path.sep);
        tableName = parts.pop() || 'data';
        dbPath = parts.join(path.sep);
      }

      // Ensure directory exists
      const fs = require('fs');
      if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
      }

      // Prepare data - ensure vector field is properly formatted
      const processedData = sourceData.map(row => {
        const vector = row.vector || row.values || row.embedding;
        const record = { ...row };
        record.vector = toVectorArray(vector);
        delete record.values;
        delete record.embedding;
        delete record._id; // Remove NeDB/MongoDB internal ID

        // Flatten metadata object if it exists (from Pinecone source)
        if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
          const metadataFields = { ...record.metadata };
          delete record.metadata;
          Object.assign(record, metadataFields);
        }

        // Replace null values with empty strings to avoid Arrow IPC dictionary issues
        Object.keys(record).forEach(key => {
          if (record[key] === null || record[key] === undefined) {
            record[key] = '';
          }
        });

        return record;
      });

      console.log(`[LanceDB Export] Prepared ${processedData.length} vector records`);

      // Drop existing table if it exists, then create new one
      try {
        await executeLanceDBOperation({
          operation: 'delete',
          config: {
            dbPath,
            tableName,
            filter: '1=1' // Delete all records
          }
        });
      } catch (error) {
        // Table doesn't exist, that's fine
        console.log(`[LanceDB Export] Table doesn't exist, will create new one`);
      }

      // Create table with data
      const result = await executeLanceDBOperation({
        operation: 'upsert',
        data: processedData,
        config: {
          dbPath,
          tableName
        }
      });

      if (result.success) {
        return {
          success: true,
          message: `Successfully exported ${sourceData.length} vectors to LanceDB (${tableName})`,
          filePath: path.join(dbPath, `${tableName}.lance`),
          recordCount: sourceData.length,
          executionTime: Date.now() - startTime
        };
      } else {
        return {
          success: false,
          message: `Failed to export LanceDB: ${result.message}`
        };
      }

    } catch (error) {
      console.error('[LanceDB Export] Error:', error);
      return {
        success: false,
        message: `Failed to export LanceDB: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * List all tables in a LanceDB database
   */
  listLanceDBTables: async (params) => {
    bindLibs(params.helpers);
    const { dbPath } = params;

    try {
      if (!dbPath || !fs.existsSync(dbPath)) {
        return {
          success: false,
          message: 'LanceDB directory not found',
          tables: []
        };
      }

      // Use the listTables function from lancedb.js
      // Pass dbPath as config object
      console.log('dbPath: ', dbPath)
      const tables = await listLanceTables({ dbPath });
      console.log('tables: ', tables)
      return {
        success: true,
        tables: tables,
        message: `Found ${tables.length} table(s)`
      };
    } catch (error) {
      console.error('[LanceDB List Tables] Error:', error);
      return {
        success: false,
        message: `Failed to list LanceDB tables: ${error.message}`,
        tables: [],
        error: error.stack
      };
    }
  },

  // ─── Join hooks ──────────────────────────────────────────────────────────
  // Called by the standard join executor (handleExecuteJoin) when a source
  // is a vector DB, or when the destination is a vector DB. The skill is not
  // the orchestrator — these are narrow, side-effect-only hooks.

  isVectorConnection: joinHandler.isVectorConn,

  fetchVectorSourceRecords: async (params) => {
    bindLibs(params.helpers);
    return await joinHandler.fetchVectorSourceRecords(params);
  },

  embedAndUpsertJoinedRows: async (params) => {
    bindLibs(params.helpers);
    return await joinHandler.embedAndUpsertJoinedRows(params);
  },

  metadata: {
    displayName: 'Vector Database Executor',
    description: 'Generate embeddings and run vector operations on LanceDB or Pinecone — embed columns, upsert vectors, and run semantic search via OpenAI or HuggingFace.',
    version: '1.0.0',
    author: 'Ternlux'
  }
};

/**
 * Fetch sample data from vector source for prompt context
 */
async function fetchVectorSampleData({
  sourceConnection,
  sourceTableSchema,
  pluginManager,
  getFullConfig,
  sampleSize = 2
}) {
  try {
    const dbType = sourceConnection.dbType;
    const tableName = sourceTableSchema.tableName;
    const indexName = sourceTableSchema.indexName || sourceConnection.indexName;
    const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

    let sampleRecords = [];

    if (dbType === 'lancedb') {
      // LanceDB: embedded library
      const dbPath = sourceConnection.localPath || sourceConnection.dbConfig?.dbPath;
      if (!dbPath) {
        return [];
      }

      const db = await require('@lancedb/lancedb').connect(dbPath);
      try {
        const table = await db.openTable(tableName);
        const query = table.query().limit(sampleSize);
        sampleRecords = await query.toArray();
      } catch (error) {
        console.warn('Failed to fetch LanceDB sample data:', error.message);
        return [];
      }

    } else {
      console.log('sourceConnection.id: ', sourceConnection)
      // All other vector DBs: use connector plugin
      const fullConfig = await getFullConfig(sourceConnection.id);
      const connector = pluginManager.getConnector(sourceConnection.dbType);
      console.log('fullConfig: ', fullConfig)
      if (!connector || !connector.queryVectors) {
        return [];
      }
      console.log('fullConfig: ', {
        fullConfig,
        indexName: indexName,
        namespace: namespace,
        topK: sampleSize,
    })
      const result = await connector.queryVectors(
        fullConfig,
        sourceConnection.id,
        {
          indexName: indexName,
          namespace: namespace,
          queryVector: null,
          filter: {},
          topK: sampleSize,
          includeValues: true,
          includeMetadata: true
        }
      );

      if (result.success) {
        sampleRecords = result.rows || [];
      }
    }

    return sampleRecords;
  } catch (error) {
    console.warn('Failed to fetch vector sample data:', error.message);
    return [];
  }
}

/**
 * Execute JavaScript transformation on vector source data
 * Similar to NeDB transformations but for vector databases
 */
async function executeVectorSourceTransformation({
  sourceConnection,
  sourceTableSchema,
  transformFunction,
  initialState,
  useEmbeddingSearch,
  searchQuery,
  filter,
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  pluginManager,
  getFullConfig,
  appSqliteDbPath,
  sqlitePool,
  nodeId,
  sourceNodeId,
  startTime,
  targetLocalPath,
  storageLocation,
  operationMode
}) {
  try {
    const dbType = sourceConnection.dbType || sourceConnection.sourceDbType;

    // For Pinecone, use indexName instead of tableName
    const tableName = sourceTableSchema.tableName;
    const indexName = sourceTableSchema.indexName || sourceConnection.indexName

    // For Pinecone, the namespace is stored in the schema field
    const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

    console.log(`Loading vectors from ${dbType}...`);
    if (dbType === 'pinecone') {
      console.log(`Pinecone index: '${tableName}', namespace: '${namespace}'`);
    }

    // Step 1: Handle embedding search if requested
    let queryVector = null;
    if (useEmbeddingSearch && searchQuery) {
      console.log(`Embedding search query: "${searchQuery}"`);

      // Generate embedding for the search query
      const embeddedQuery = await generateEmbeddings({
        data: [{ query: searchQuery }],
        columnToEmbed: 'query',
        provider: embeddingProvider,
        model: embeddingModel,
        apiKey: embeddingApiKey
      });

      queryVector = embeddedQuery[0].vector;
      console.log(`Generated query embedding (${queryVector.length} dimensions)`);
    }

    // Step 2: Fetch vectors from source using search or filter
    let vectors = [];
    let fullConfig = null;
    let connector = null;

    if (dbType === 'lancedb') {
      // LanceDB: embedded library, no connector needed
      const dbPath = sourceConnection.localPath || sourceConnection.sourceLocalPath || sourceConnection.dbConfig?.dbPath;
      if (!dbPath) {
        throw new Error('LanceDB path not found in connection config');
      }

      const db = await require('@lancedb/lancedb').connect(dbPath);

      try {
        const table = await db.openTable(tableName);

        let query;
        if (queryVector) {
          // Embedding search
          query = table.search(queryVector).limit(100);
        } else {
          // Regular query
          query = table.query().limit(10000);
        }

        // Apply SQL filter if provided
        if (filter && typeof filter === 'string' && filter.trim() !== '') {
          query = query.where(filter);
        }

        vectors = await query.toArray();
      } catch (error) {
        if (error.message.includes('does not exist')) {
          throw new Error(`Table '${tableName}' does not exist in LanceDB`);
        }
        throw error;
      }

    } else {
      // All other vector DBs: use connector plugin
      fullConfig = await getFullConfig(sourceConnection.id);
      const dbType = sourceConnection.dbType || sourceConnection.sourceDbType
      connector = pluginManager.getConnector(dbType);

      if (!connector) {
        throw new Error(`Connector not found: ${dbType}`);
      }

      if (!connector.queryVectors) {
        throw new Error(`${dbType} connector does not support queryVectors method`);
      }
      const id = sourceConnection.id || sourceConnection.connectionId
      const result = await connector.queryVectors(
        fullConfig,
        id,
        {
          indexName: indexName,
          namespace: namespace,
          queryVector: queryVector,
          filter: filter || {},
          topK: queryVector ? 100 : 10000, // Limit results for embedding search
          includeValues: true,
          includeMetadata: true
        }
      );

      if (!result.success) {
        throw new Error(`Failed to query vectors: ${result.message}`);
      }

      vectors = result.rows || [];
    }

    console.log(`Found ${vectors.length} vectors from ${useEmbeddingSearch ? 'embedding search' : 'filter'}`);

    if (vectors.length === 0) {
      return {
        success: true,
        message: 'No vectors found matching the search criteria',
        recordCount: 0,
        executionTime: Date.now() - startTime
      };
    }

    // Step 3: Apply transform function to each record
    if (!transformFunction) {
      throw new Error('transformFunction is required');
    }

    // Create the transform function from string
    const transformFn = eval(`(${transformFunction})`);

    // Initialize state (defaults to empty object)
    let state = initialState || {};

    // Apply transformation to each vector and collect results
    const toUpdate = [];
    const toDelete = [];

    for (const record of vectors) {
      try {
        // Deep clone record before passing to transform function to prevent mutation
        const clonedRecord = JSON.parse(JSON.stringify(record));
        const result = transformFn(clonedRecord, state);
        // console.log('vectors: ', record, result)
        // Handle different return formats for backward compatibility
        let transformedRecord;
        let newState;

        if (result && typeof result === 'object' && 'record' in result) {
          // New format: { record, state }
          transformedRecord = result.record;
          newState = result.state;
        }

        // Update state for next iteration
        state = newState;

        if (transformedRecord === null || transformedRecord === undefined) {
          // Return null → DELETE this record
          toDelete.push(record.id);
        } else if (JSON.stringify(transformedRecord) !== JSON.stringify(record)) {
          // Return modified record → UPDATE it
          if(dbType ==='lancedb'){
            toUpdate.push(replaceNulls(transformedRecord))
          }else{
            toUpdate.push({
              id: transformedRecord.id || record.id,
              vector: transformedRecord.vector || transformedRecord.values || record.vector || record.values,
              metadata: transformedRecord.metadata || record.metadata,
              namespace: namespace
            });
          }
        }
        // If returned same record → SKIP (no operation)
      } catch (error) {
        console.error(`Error transforming record ${record.id}:`, error);
        throw new Error(`Transformation failed for record ${record.id}: ${error.message}`);
      }
    }

    console.log(`Final state:`, toUpdate);

    console.log(`Transform results: ${toUpdate.length} updates, ${toDelete.length} deletes, ${vectors.length - toUpdate.length - toDelete.length} skipped`);

    // Step 4: Execute updates and deletes
    let totalOperations = 0;

    if (dbType === 'lancedb') {
      // LanceDB: embedded library
      const dbPath = sourceConnection.localPath ||
                     sourceConnection.dbConfig?.dbPath ||
                     targetLocalPath ||
                     sourceTableSchema.localPath;

      if (!dbPath) {
        throw new Error('LanceDB path not found in connection config, targetLocalPath, or sourceTableSchema');
      }

      const db = await require('@lancedb/lancedb').connect(dbPath);
      const table = await db.openTable(tableName);

      try {
        // Try normal update/delete flow first
        // Delete records first
        if (toDelete.length > 0) {
          const idList = toDelete.map(id => `'${id}'`).join(', ');
          const deleteFilter = `id IN (${idList})`;
          await table.delete(deleteFilter);
          console.log(`Deleted ${toDelete.length} records from LanceDB`);
        }

        // Update records (delete old + add new)
        if (toUpdate.length > 0) {
          const updateIds = toUpdate.map(v => v.id);
          const idList = updateIds.map(id => `'${id}'`).join(', ');
          const deleteFilter = `id IN (${idList})`;

          // Delete old versions
          await table.delete(deleteFilter);

          // Add updated versions
          await table.add(toUpdate);
          console.log(`Updated ${toUpdate.length} records in LanceDB`);
        }

        totalOperations = toUpdate.length + toDelete.length;

      } catch (error) {
        // If schema mismatch (new fields added), recreate entire table
        if (error.message && error.message.includes('schema')) {
          console.log('[LanceDB] Schema changed, recreating table with new schema...');

          // Reopen table (it might have been partially modified)
          const freshTable = await db.openTable(tableName);

          // Get all records except the ones being deleted or updated
          const idsToExclude = [...toDelete, ...toUpdate.map(v => v.id)];
          const excludeFilter = idsToExclude.length > 0
            ? `id NOT IN (${idsToExclude.map(id => `'${id}'`).join(', ')})`
            : null;

          let unchangedRecords = [];
          if (excludeFilter) {
            unchangedRecords = await freshTable.query().where(excludeFilter).limit(1000000).toArray();
          } else {
            unchangedRecords = await freshTable.query().limit(1000000).toArray();
          }

          // Combine unchanged + updated records (excluding deleted ones)
          const allRecords = [...unchangedRecords, ...toUpdate];

          // Drop and recreate table
          await db.dropTable(tableName);
          await db.createTable(tableName, allRecords);

          console.log(`Recreated table with ${allRecords.length} records (${unchangedRecords.length} unchanged + ${toUpdate.length} updated, ${toDelete.length} deleted)`);

          totalOperations = toUpdate.length + toDelete.length;
        } else {
          throw error;
        }
      }

    } else {
      // All other vector DBs: use connector plugin
      if (!connector.updateAndDeleteVectors) {
        throw new Error(`${dbType} connector does not support updateAndDeleteVectors method`);
      }

      const result = await connector.updateAndDeleteVectors(
        fullConfig,
        fullConfig.id,
        {
          indexName: indexName,
          namespace: namespace,
          toUpdate: toUpdate,
          toDelete: toDelete
        }
      );

      if (!result.success) {
        throw new Error(`Failed to update/delete vectors: ${result.message}`);
      }

      totalOperations = toUpdate.length + toDelete.length;
    }

    // Build config using helper function.
    // toUpdate holds the just-written transformed records — use them as the sample.
    const config = buildVectorConfig({
      operation: 'transform',
      vectorDbType: dbType,
      targetTable: tableName,
      sourceNodeId,
      sourceConnection,
      sourceTableSchema,
      recordCount: totalOperations,
      namespace: namespace,
      indexName: indexName,
      targetLocalPath,
      transformFunction,
      initialState,
      filter,
      searchQuery,
      useEmbeddingSearch,
      sampleRecords: toUpdate
    });

    return {
      success: true,
      message: `Transformed ${vectors.length} vectors: ${toUpdate.length} updated, ${toDelete.length} deleted`,
      recordCount: totalOperations,
      updated: toUpdate.length,
      deleted: toDelete.length,
      skipped: vectors.length - toUpdate.length - toDelete.length,
      executionTime: Date.now() - startTime,
      config
    };

  } catch (error) {
    console.error('Vector source transformation failed:', error);
    return {
      success: false,
      message: `Vector transformation failed: ${error.message}`,
      error: error.stack,
      executionTime: Date.now() - startTime
    };
  }
}

/**
 * Filter out duplicate records in LanceDB
 * Checks both vector similarity and metadata equality
 */
// async function filterDuplicatesLanceDB({ embeddedData, targetTable }) {
//   try {
//     const newRecords = [];
//     const SIMILARITY_THRESHOLD = 0.99; // Very high threshold for exact match

//     const lancedb = require('@lancedb/lancedb');
//     const dbPath = path.join(
//       require('electron').app.getPath('userData'),
//       'data',
//       'lancedb'
//     );

//     const db = await lancedb.connect(dbPath);
//     const tableNames = await db.tableNames();

//     // If table doesn't exist, all records are new
//     if (!tableNames.includes(targetTable)) {
//       return embeddedData;
//     }

//     const table = await db.openTable(targetTable);

//     // Check each record
//     for (const record of embeddedData) {
//       const results = await table
//         .search(record.vector)
//         .limit(1)
//         .toArray();

//       // Check if exact match exists
//       let isDuplicate = false;
//       if (results.length > 0) {
//         const topResult = results[0];

//         // Check similarity score (LanceDB returns _distance, lower is better)
//         // For cosine similarity, distance = 1 - similarity
//         const similarity = 1 - (topResult._distance || 0);

//         if (similarity >= SIMILARITY_THRESHOLD) {
//           // Check metadata equality (excluding internal fields)
//           const recordMeta = { ...record };
//           delete recordMeta.vector;
//           delete recordMeta._embedded_column;
//           delete recordMeta._embedding_provider;
//           delete recordMeta._embedding_model;
//           delete recordMeta._embedded_at;

//           const resultMeta = { ...topResult };
//           delete resultMeta.vector;
//           delete resultMeta._distance;
//           delete resultMeta._embedded_column;
//           delete resultMeta._embedding_provider;
//           delete resultMeta._embedding_model;
//           delete resultMeta._embedded_at;

//           // Compare metadata
//           if (JSON.stringify(recordMeta) === JSON.stringify(resultMeta)) {
//             isDuplicate = true;
//           }
//         }
//       }

//       if (!isDuplicate) {
//         newRecords.push(record);
//       }
//     }

//     return newRecords;

//   } catch (error) {
//     console.warn(`Failed to check LanceDB duplicates: ${error.message}`);
//     // On error, return all records to avoid data loss
//     return embeddedData;
//   }
// }

/**
 * Load source data from various connection types
 * Similar to python-executor pattern (lines 378-462)
 */
async function loadSourceData({
  sourceConnection,
  sourceTableSchema,
  operationType,
  pluginManager,
  getFullConfig,
  sqlitePool,
  appSqliteDbPath
}) {
  const tableName = sourceTableSchema.tableName;

  // Local NeDB
  if (sourceConnection.dbType === 'nedb' || operationType === 'nosql') {
    if (sourceConnection.localPath) {
      return await loadFromNeDB(sourceConnection.localPath);
    }
  }

  // Local SQLite
  if (sourceConnection.dbType === 'sqlite') {
    // For local SQLite, check multiple sources for the path:
    // 1. sourceConnection.localPath (external SQLite file)
    // 2. appSqliteDbPath (app's internal SQLite database)
    // 3. sourceConnection.dbConfig.path (fallback)
    const dbPath = sourceConnection.localPath
      || appSqliteDbPath
      || sourceConnection.dbConfig?.path
      || sourceConnection.dbConfig?.database;

    return await loadFromSQLite(tableName, sqlitePool, { path: dbPath });
  }

  // Remote database via plugin
  if (pluginManager && sourceConnection.id) {
    const fullConfig = await getFullConfig(sourceConnection.id);
    const connector = pluginManager.getConnector(sourceConnection.dbType);

    if (connector) {
      // Different connectors expect different query shapes — runQuery is
      // intentionally polymorphic. SQL connectors take a SQL string;
      // MongoDB takes a JSON object with collection / filter / limit;
      // NeDB takes a similar JSON shape. Build the right shape per
      // dbType so we don't hand a SQL string to a doc store (which
      // would JSON.parse-throw inside the connector and return success:
      // false, surfacing here as "Unable to load data from source").
      const dbType = String(sourceConnection.dbType || '').toLowerCase();
      let queryPayload;
      if (dbType === 'mongodb') {
        queryPayload = { collection: tableName, filter: {}, limit: 10000 };
      } else if (dbType === 'nedb') {
        queryPayload = { operation: 'find', filter: {}, limit: 10000 };
      } else {
        // SQL-shaped connectors (Postgres, MySQL, MSSQL, Snowflake,
        // BigQuery, Redshift, …): keep the SELECT * the previous code
        // emitted. Tables with schemas are referenced as
        // "schema.table" by the planner so the literal form is fine.
        queryPayload = {
          query: `SELECT * FROM ${tableName}`,
          tableName: tableName,
          limit: 10000,
        };
      }

      // getFullConfig returns the merged connection config (with `uri`,
      // `database`, etc. at the top level — NOT nested under `.dbConfig`).
      // Every other call site in this codebase (electron.js handlers, the
      // executor helpers) passes `fullConfig` directly. Match that, or
      // the connector's getConnection reads `.uri` from undefined.
      const queryResult = await connector.runQuery(
        fullConfig,
        sourceConnection.id,
        queryPayload,
        10000,
      );

      if (queryResult && queryResult.success) {
        return queryResult.rows || [];
      }
      // Surface the connector's error message instead of the generic
      // "Unable to load data" — the caller wraps it with the dbType so
      // the user still sees that context.
      if (queryResult && queryResult.message) {
        throw new Error(`Source query failed on ${sourceConnection.dbType}: ${queryResult.message}`);
      }
    }
  }

  throw new Error(`Unable to load data from source: ${sourceConnection.dbType}`);
}

/**
 * Load data from NeDB file
 */
function loadFromNeDB(localPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(localPath)) {
      reject(new Error(`NeDB file not found: ${localPath}`));
      return;
    }

    const db = new Datastore({ filename: localPath });
    db.loadDatabase((err) => {
      if (err) {
        reject(err);
        return;
      }

      db.find({}, (findErr, docs) => {
        if (findErr) {
          reject(findErr);
        } else {
          resolve(docs);
        }
      });
    });
  });
}

/**
 * Load data from SQLite
 */
function loadFromSQLite(tableName, sqlitePool, dbConfig) {
  return new Promise((resolve, reject) => {
    const dbPath = dbConfig?.path || dbConfig?.database;

    if (!dbPath || !fs.existsSync(dbPath)) {
      reject(new Error(`SQLite database not found: ${dbPath}`));
      return;
    }

    const db = sqlitePool.getConnection(dbPath);

    db.all(`SELECT * FROM ${tableName} LIMIT 10000`, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

/**
 * Execute LanceDB operation
 */
async function executeLanceDB({
  operation,
  data,
  queryText,
  queryVector,
  topK,
  filter,
  targetTable,
  lancedbConfig,
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  columnToEmbed,
  overwrite = false
}) {
  const config = {
    ...lancedbConfig,
    tableName: targetTable,
    // Forwarded to upsertVectors — drop+recreate the table for new_table writes.
    overwrite: overwrite === true
  };

  if (operation === 'upsert') {
    // Prepare records for LanceDB
    const records = data.map(record => {
      const cleanRecord = {
        id: record.id || generateId(),
        vector: record.vector
      };

      // Flatten metadata object if it exists (from Pinecone or other sources)
      let flattenedRecord = { ...record };
      if (flattenedRecord.metadata && typeof flattenedRecord.metadata === 'object' && !Array.isArray(flattenedRecord.metadata)) {
        const metadataFields = { ...flattenedRecord.metadata };
        delete flattenedRecord.metadata;
        flattenedRecord = { ...flattenedRecord, ...metadataFields };
      }

      // Add other fields, replacing null/undefined with empty strings to avoid Arrow IPC dictionary issues
      for (const [key, value] of Object.entries(flattenedRecord)) {
        if (key === 'id' || key === 'vector') continue; // Already added

        // Skip object/array types (shouldn't happen after flattening, but safety check)
        if (typeof value === 'object' && value !== null) {
          continue;
        }

        // Replace null/undefined with empty string
        if (value === null || value === undefined) {
          cleanRecord[key] = '';
        } else {
          cleanRecord[key] = value;
        }
      }

      return cleanRecord;
    });

    console.log(`LanceDB: Processed ${records.length} records for upsert`);

    return await executeLanceDBOperation({ operation, data: records, config });
  }

  if (operation === 'query') {
    // If queryText provided, embed it first
    if (queryText && !queryVector) {
      const embeddedQuery = await generateEmbeddings({
        data: [{ query: queryText }],
        columnToEmbed: 'query',
        provider: embeddingProvider,
        model: embeddingModel,
        apiKey: embeddingApiKey
      });
      queryVector = embeddedQuery[0].vector;
    }

    config.queryVector = queryVector;
    config.limit = topK;
    config.filter = filter;

    const result = await executeLanceDBOperation({ operation, data: [], config });

    // Format results
    result.data = formatVectorResults(result.data);

    return result;
  }

  if (operation === 'delete') {
    config.filter = filter;
    return await executeLanceDBOperation({ operation, data: [], config });
  }

  if (operation === 'update') {
    config.filter = filter;
    config.updates = data;
    return await executeLanceDBOperation({ operation, data: [], config });
  }

  throw new Error(`Unsupported LanceDB operation: ${operation}`);
}

/**
 * Build vector database config for transformer node
 * Used by both embedding operations and vector source transformations
 */
function buildVectorConfig({
  operation,
  vectorDbType,
  targetTable,
  sourceNodeId,
  sourceConnection,
  sourceTableSchema,
  recordCount = 0,
  targetLocalPath = null,
  targetConnectionId = null,
  namespace = '',
  indexName = null,
  transformFunction = null,
  initialState = null,
  filter = null,
  searchQuery = null,
  useEmbeddingSearch = false,
  sampleRecords = null,
  // Parameters for saveVectorResults
  targetConnectionName = null,
  embeddingProvider = null,
  embeddingModel = null,
  columnToEmbed = null
}) {
  // Build sample data: compact vector arrays to '[N dims]' for display, drop embedding meta
  const formatSample = (records) => {
    if (!Array.isArray(records) || records.length === 0) return [];
    return records.slice(0, 5).map(record => {
      const formatted = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === '_embedded_column' || key === '_embedding_provider'
            || key === '_embedding_model' || key === '_embedded_at') continue;
        if ((key === 'vector' || key === 'values') && Array.isArray(value)) {
          formatted[key] = `[${value.length} dims]`;
        } else if (typeof value === 'string' && value.length > 100) {
          formatted[key] = value.substring(0, 100) + '...';
        } else {
          formatted[key] = value;
        }
      }
      return formatted;
    });
  };

  const sampleData = formatSample(sampleRecords);

  // Derive columns from the actual sample when available; otherwise fall back to the
  // generic id/vector/metadata layout.
  const inferType = (value) => {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string' && /^\[\d+ dims\]$/.test(value)) return 'VECTOR';
    if (typeof value === 'string') return 'TEXT';
    if (typeof value === 'object') return 'JSON';
    return 'unknown';
  };

  const columns = sampleData.length > 0
    ? Object.keys(sampleData[0]).map(name => ({
        name,
        type: inferType(sampleData[0][name]),
        nullable: name !== 'id',
        isPrimary: name === 'id'
      }))
    : [
        { name: 'id', type: 'TEXT', nullable: false, isPrimary: true },
        { name: 'vector', type: 'VECTOR', nullable: false, isPrimary: false },
        { name: 'metadata', type: 'JSON', nullable: true, isPrimary: false }
      ];

  // Build target table schema for vector databases
  const targetTableSchema = {
    tableName: targetTable,
    columns,
    sampleData
  };

  // Determine target connection ID
  let finalTargetConnectionId;
  if (targetConnectionId) {
    finalTargetConnectionId = targetConnectionId;
  } else if (vectorDbType === 'lancedb') {
    finalTargetConnectionId = 'local-lancedb';
  } else {
    // For Pinecone without explicit targetConnectionId, use sourceConnection (for vector transformations)
    finalTargetConnectionId = sourceConnection?.id;
  }

  const config = {
    nodeType: 'transformer',
    sourceNodeId,
    sourceConnectionId: sourceConnection?.id,
    sourceTableName: sourceTableSchema?.tableName,
    targetConnectionId: finalTargetConnectionId,
    targetDbType: vectorDbType,
    targetTableName: targetTable,
    targetTableSchema: targetTableSchema,
    targetPreviewSql: null,  // Vector DBs don't use SQL
    transformationRequest: `Vector ${operation} operation`,
    skillId: 'vector-db-executor',
    usesSkill: true,
    skillExecution: {
      operation,
      vectorDbType,
      recordCount
    },
    needsSchemaLoad: false,  // Schema already provided in targetTableSchema

    // Transformation function parameters (for vector source transformations)
    transformFunction: transformFunction,
    initialState: initialState,

    // Query parameters
    filter: filter,
    searchQuery: searchQuery,
    useEmbeddingSearch: useEmbeddingSearch,

    // Parameters for saveVectorResults (embedding operations)
    targetConnectionName: targetConnectionName,
    embeddingProvider: embeddingProvider,
    embeddingModel: embeddingModel,
    columnToEmbed: columnToEmbed,
    indexName: indexName,
    namespace: namespace
  };

  // Add type-specific configuration
  if (vectorDbType === 'lancedb') {
    // For LanceDB, include the database path
    const lancedbPath = targetLocalPath || path.join(
      require('electron').app.getPath('userData'),
      'data',
      'lancedb'
    );

    // Set targetLocalPath for LanceDB (it's a directory, will be handled by dbType check)
    config.targetLocalPath = lancedbPath;
    config.targetDbConfig = {
      dbPath: lancedbPath,
      tableName: targetTable
    };
    // Explicitly ensure targetDbType is set
    config.targetDbType = 'lancedb';
    config.storageLocation = 'local'

  } else if (vectorDbType === 'pinecone') {
    // For Pinecone, include connection type and ensure dbType is set
    config.targetConnectionType = 'pinecone';
    config.targetDbType = 'pinecone';
    config.storageLocation = 'database'
    // Store namespace and index name for preview queries
    config.targetNamespace = namespace;
    config.targetIndexName = indexName || targetTable;

    // If source schema has namespace (for Pinecone), preserve it in target
    if (sourceTableSchema?.schema) {
      config.targetTableSchema.schema = sourceTableSchema.schema;
    }
  }
  config.targetDbCategory = 'Vector'
  
  return config;
}

/**
 * Save vector results to local storage
 */
async function saveVectorResults({
  result,
  operation,
  vectorDbType,
  targetTable,
  nodeId,
  sourceNodeId,
  sourceConnection,
  sourceTableSchema,
  appSqliteDbPath,
  sqlitePool,
  targetConnectionId = null,
  namespace = '',
  indexName = null,
  targetLocalPath = null,
  targetConnectionName = null,
  embeddingProvider = null,
  embeddingModel = null,
  columnToEmbed = null,
  embeddedData = null
}) {
  // For query results, save to local NeDB
  if (operation === 'query' && result.data && result.data.length > 0) {
    const localDbPath = path.join(
      require('electron').app.getPath('userData'),
      'local-collections',
      `${targetTable}_query_results.db`
    );

    const localDbDir = path.dirname(localDbPath);
    if (!fs.existsSync(localDbDir)) {
      fs.mkdirSync(localDbDir, { recursive: true });
    }

    // Save query results to NeDB
    const db = new Datastore({ filename: localDbPath, autoload: true });

    await new Promise((resolve, reject) => {
      db.insert(result.data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    return {
      nodeType: 'transformer',
      sourceNodeId,
      sourceConnectionId: sourceConnection?.id,
      sourceTableName: sourceTableSchema?.tableName,
      targetConnectionId: 'local',
      targetDbType: 'nedb',
      targetTableName: `${targetTable}_query_results`,
      targetLocalPath: localDbPath,
      skillExecution: {
        skillId: 'vector-db-executor',
        operation,
        vectorDbType,
        executionTime: result.executionTime,
        recordCount: result.recordCount
      },
      needsSchemaLoad: true
    };
  }

  // For upsert/delete/update, use helper function.
  // Prefer the actual operation result rows; fall back to the embedded data we just wrote.
  const sampleRecords = (Array.isArray(result?.data) && result.data.length > 0)
    ? result.data
    : embeddedData;

  return buildVectorConfig({
    operation,
    vectorDbType,
    targetTable,
    sourceNodeId,
    sourceConnection,
    sourceTableSchema,
    recordCount: result.recordCount || 0,
    targetConnectionId,
    namespace,
    indexName,
    targetLocalPath,
    targetConnectionName,
    embeddingProvider,
    embeddingModel,
    columnToEmbed,
    sampleRecords
  });
}
