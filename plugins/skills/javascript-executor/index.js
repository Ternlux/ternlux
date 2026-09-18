/**
 * JavaScript Executor Skill Plugin for Ternlux
 *
 * Two-stage flow inside buildSkillPrompt:
 *
 *   Stage 1 — planning (internal AI call via params.helpers.callAI):
 *     The AI decides one of (exactly two — it either builds or it asks):
 *       • ask_questions       — request is ambiguous, informational, or cannot
 *                               be done; clarify in plain language
 *       • plan_complete       — return the connections + tables it will need,
 *                               which AI/embedding provider to use, and the
 *                               output destination (duckdb | lancedb)
 *
 *   Stage 2 — function generation (renderer's AI call via the returned prompt):
 *     For plan_complete the skill fetches the planned tables' columns +
 *     sample data and includes that context in the function prompt.
 *     For ask_questions the skill returns a small "echo" prompt so
 *     processSkillResponse just passes the planner's question back.
 *
 * Helpers (callAI, runQuery, getTables, getColumns, vectorize, axios, ...)
 * all come from
 * params.helpers — the bundle injected by electron.js. The skill imports
 * nothing from outside its own directory.
 */

const path = require('path');
const { app } = require('electron');

const { buildContext, scrubSecrets } = require('./lib/sandbox');

module.exports = {
  type: 'skill',
  id: 'javascript-executor',
  name: 'JavaScript Executor',
  category: 'transformer',
  icon: './icon.svg',
  supportsInteraction: true,

  // ---------------------------------------------------------------------------
  // Description / discovery
  // ---------------------------------------------------------------------------

  getDescription: () => ({
    name: 'JavaScript Executor',
    description: 'Run an AI-generated async JavaScript function for complex transformations that need to query other connections, call AI, generate embeddings, or hit external APIs.',
    capabilities: [
      'Single async transform(records, ctx) function over the source data',
      'Query any saved connection (ctx.runQuery / getTables / getColumns)',
      'Call any configured AI provider (ctx.askAi)',
      'Generate embeddings (ctx.vectorize)',
      'Local DuckDB tables / files and LanceDB via ctx.runQuery(dbType, query, dbPath)',
      'External HTTP via ctx.axios',
      'Write results to a local DuckDB table or LanceDB'
    ],
    inputFormat: 'Array of objects from the source node',
    outputFormat: 'Array of objects (DuckDB) or array with a vector field (LanceDB)',
    executionEnvironment: 'local (Electron main process)'
  }),

  getTransformPrompts: () => ({
    systemContext: `
# JavaScript Executor Skill

Use this skill when the transformation needs to:
- Cross-reference data from another saved connection (SQL or NoSQL)
- Call an AI model on each record (classify, extract, summarize)
- Custom logic for creating embeddings where Vector Database Executor can't perform
- Hit an external HTTP API (axios)
- Combine several of the above

Skip it for plain SQL/NoSQL — the standard flow handles those.
Output is written to a local DuckDB table (default) or LanceDB (when records carry a vector).
`,
    responseFormat: `
When this skill fits, return:
{
  "usesSkill": true,
  "skillId": "javascript-executor",
  "skillExplanation": "Why a JavaScript function is needed"
}
`
  }),

  // ---------------------------------------------------------------------------
  // Stage 1 + stage 2 prompt construction
  // ---------------------------------------------------------------------------

  buildSkillPrompt: async (params) => {
    const {
      userRequest,
      sourceTableSchema = {},
      sourceConnection = {},
      operationType,
      chatHistory = [],
      helpers
    } = params;

    if (!helpers || typeof helpers.callAI !== 'function') {
      throw new Error('javascript-executor requires helpers.callAI (electron must inject helpers).');
    }

    const sourceId = sourceConnection.id || sourceConnection._id;
    const otherConnections = (helpers.connections || [])
      .filter((c) => (c.id || c._id) !== sourceId);

    // ---------- Stage 1: planning AI call (internal) ----------
    const planningPrompt = buildPlanningPrompt({
      userRequest,
      sourceConnection,
      sourceTableSchema,
      otherConnections,
      aiProviders: helpers.aiProviders || [],
      embeddingProviders: helpers.embeddingProviders || []
    });

    
    let plan;
    try {
      const planningResponse = await helpers.callAI(planningPrompt, {
        maxTokens: 1024,
        chatHistory
      });
      plan = parseJson(planningResponse);
    } catch (err) {
      return preResolved(
        { action: 'ask_questions', questionsNeeded: { setup: `Planning step failed: ${err.message}` } },
        { stage: 'failed', error: err.message }
      );
    }
    console.log('plan: ', String(plan))
    // Stage 1 short-circuit: planner asked for more information instead of
    // planning. No second AI call needed; return the validated result so the
    // renderer can render it without going through processSkillResponse.
    if (plan.action === 'ask_questions') {
      return preResolved(validateResult(plan), { stage: 'short_circuit', plan });
    }

    if (plan.action !== 'plan_complete') {
      return preResolved(
        {
          action: 'ask_questions',
          questionsNeeded: { request: 'I could not understand the request. Please describe what transformation you need.' }
        },
        { stage: 'invalid_plan', plan }
      );
    }

    // ---------- Stage 2: schema fetch + function-generation AI call ----------
    const schemaContext = await fetchSchemaContext({
      connectionsNeeded: plan.connectionsNeeded || [],
      helpers
    });

    const functionPrompt = buildFunctionPrompt({
      userRequest,
      plan,
      schemaContext,
      sourceConnection,
      sourceTableSchema
    });

    let functionResult;
    try {
      const functionResponse = await helpers.callAI(functionPrompt, {
        maxTokens: 4096,
        chatHistory
      });
      functionResult = parseJson(functionResponse);
    } catch (err) {
      return preResolved(
        { action: 'ask_questions', questionsNeeded: { setup: `Function generation step failed: ${err.message}` } },
        { stage: 'failed', error: err.message }
      );
    }

    return preResolved(
      validateResult(functionResult),
      { stage: 'function_generation', plan, schemaContext, raw: functionResult }
    );
  },

  // ---------------------------------------------------------------------------
  // Response parsing — kept as a thin wrapper around validateResult for any
  // legacy caller that still routes through processSkillResponse. The
  // happy-path two-stage flow above doesn't need this.
  // ---------------------------------------------------------------------------

  processSkillResponse: (aiResponse) => {
    let parsed;
    try {
      parsed = parseJson(aiResponse);
    } catch (err) {
      return {
        action: 'ask_questions',
        message: `Could not parse response: ${err.message}`,
        questionsNeeded: { request: 'Could you rephrase the transformation you want?' }
      };
    }
    return validateResult(parsed);
  },

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  execute: async (params) => {
    const startTime = Date.now();
    const {
      sourceConnection,
      sourceTableSchema,
      transformFunction,
      outputType = 'duckdb',
      helpers,
      nodeId,
      sourceNodeId,
      sourceNodeLabel,
      sourceConnectionName,
      sourceConnectionType,
      userRequest,
      targetLocalPath,
      // The table the BUILDER named for this node — see the note where it is
      // used. The workflow executor sends it as `targetTable`; an ad-hoc run
      // from the node chat does not.
      targetTable = null,
      // 'new_table' | 'in_place'. Only the workflow executor sends it; an
      // ad-hoc run leaves it undefined and keeps the append behaviour.
      operationMode = null
    } = params;

    if (!helpers) {
      return { success: false, message: 'helpers bundle missing (electron injection failed)' };
    }
    if (!transformFunction) {
      return { success: false, message: 'transformFunction is required' };
    }

    try {
      // 1. Load source records.
      const records = await loadSourceRecords({ sourceConnection, sourceTableSchema, helpers });

      // 2. Compile and run the AI-generated function.
      let fn;
      try {
        // eslint-disable-next-line no-eval
        fn = eval(`(${transformFunction})`);
      } catch (err) {
        return { success: false, message: `Failed to compile transform function: ${err.message}` };
      }
      if (typeof fn !== 'function') {
        return { success: false, message: 'Compiled transform is not a function' };
      }

      // `secrets` collects any credential ctx.apiCredentials resolved, so it
      // can be stripped back out of whatever the function returns.
      const secrets = new Set();
      const ctx = buildContext(helpers, secrets);
      const result = await fn(records, ctx);
      const output = scrubSecrets(Array.isArray(result) ? result : [result], secrets);

      // 3. Write to the workflow's DuckDB database, or LanceDB.
      //
      // The name the BUILDER chose wins. It is what the node records as
      // `targetTableName`, what its preview SQL selects from, and what every
      // downstream node reads — so deriving a different one here (from the node
      // id) wrote the rows somewhere nothing else knew to look. The node-id
      // name remains the fallback for an ad-hoc run with no target settled yet.
      const targetTableName = (typeof targetTable === 'string' && targetTable.trim())
        ? targetTable.trim()
        : (nodeId || `js_${Date.now()}`).replace(/-/g, '_').toLowerCase();
      let savedConfig;
      let localPath;

      if (outputType === 'lancedb') {
        const dbPath = targetLocalPath || path.join(app.getPath('userData'), 'data', 'lancedb');
        const prepared = output.map((row) => {
          // A vector reaches here as a plain array from generated code, or as a
          // Float32Array when the function passed a LanceDB row straight
          // through. Both are vectors; only the first survives Array.isArray,
          // so normalise rather than reject.
          const v = toNumericVector(row.vector)
            || toNumericVector(row.values)
            || toNumericVector(row.embedding);
          if (!v) {
            throw new Error('LanceDB output requires each record to include a numeric `vector` array');
          }
          const clean = { ...row, vector: v };
          delete clean.values;
          delete clean.embedding;
          return clean;
        });
        const lanceResult = await helpers.runQuery(
          'lancedb',
          {
            operation: 'upsert',
            tableName: targetTableName,
            data: prepared,
            // A "new table" node produces its table afresh each run, so replace
            // it rather than appending — the same rule vector-db-executor
            // applies, and what the DuckDB branch below does with mode
            // 'replace'. Appending re-ran rows in on top of the last run's and
            // fails outright when the batch's shape has changed since.
            overwrite: operationMode === 'new_table',
          },
          dbPath
        );
        if (lanceResult && lanceResult.success === false) {
          return { success: false, message: `LanceDB write failed: ${lanceResult.message}` };
        }
        localPath = dbPath;
        savedConfig = buildConfig({
          outputType: 'lancedb', targetTableName, targetLocalPath: dbPath,
          sourceConnection, sourceTableSchema, sourceNodeId, sourceNodeLabel,
          sourceConnectionName, sourceConnectionType, userRequest, transformFunction,
          recordCount: output.length
        });
      } else {
        // Honor an explicit destination path when the caller provides one — the
        // workflow builder records targetLocalPath as the workflow's own
        // database (workflow-data/<workflowId>.duckdb), so the result becomes a
        // table there like any other node's output. Ad-hoc runs with no path
        // fall back to a standalone Parquet file.
        localPath = targetLocalPath
          || path.join(app.getPath('userData'), 'workflow-data', `${targetTableName}.parquet`);
        await helpers.runQuery(
          'duckdb',
          { operation: 'insert', mode: 'replace', tableName: targetTableName, docs: output },
          localPath
        );
        savedConfig = buildConfig({
          outputType: 'duckdb', targetTableName, targetLocalPath: localPath,
          sourceConnection, sourceTableSchema, sourceNodeId, sourceNodeLabel,
          sourceConnectionName, sourceConnectionType, userRequest, transformFunction,
          recordCount: output.length
        });
      }

      return {
        success: true,
        data: output,
        recordCount: output.length,
        message: `JavaScript transformation produced ${output.length} record(s) → ${outputType}`,
        executionTime: Date.now() - startTime,
        localPath,
        config: savedConfig
      };
    } catch (err) {
      console.error('[javascript-executor] Execution failed:', err);
      return {
        success: false,
        message: err.message,
        error: err.stack,
        executionTime: Date.now() - startTime
      };
    }
  },

  metadata: {
    displayName: 'JavaScript Executor',
    description: 'Run an AI-generated JavaScript function with helpers for connectors, AI, embeddings, and HTTP',
    version: '1.0.0',
    author: 'Ternlux'
  }
};

// ---------------------------------------------------------------------------
// Helpers (file-local)
// ---------------------------------------------------------------------------

function parseJson(text) {
  if (typeof text !== 'string') return text;
  const fenced = text.match(/```json?\n?([\s\S]*?)\n?```/);
  const body = fenced ? fenced[1] : (text.match(/{[\s\S]*}/) || [text])[0];
  return JSON.parse(body);
}

/**
 * Validate an AI response against the contract the renderer expects.
 * Returns a flat object with { action, ... } that handleSkillFlow can switch on.
 */
function validateResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      action: 'ask_questions',
      questionsNeeded: { request: 'Could not understand the response. Please rephrase the transformation.' }
    };
  }

  if (parsed.action === 'ask_questions') return parsed;

  if (parsed.action === 'execute') {
    if (!parsed.transformFunction || !parsed.transformFunction.includes('function transform')) {
      return {
        action: 'ask_questions',
        message: 'Function missing. It must be named `transform(records, ctx)`.',
        questionsNeeded: { transformFunction: 'Please describe what the function should do.' }
      };
    }
    const outputType = (parsed.outputType || 'duckdb').toLowerCase();
    if (!['duckdb', 'lancedb'].includes(outputType)) {
      return {
        action: 'ask_questions',
        message: `Unsupported outputType "${parsed.outputType}". Choose "duckdb" or "lancedb".`,
        questionsNeeded: { outputType: 'Where should the result be written: duckdb or lancedb?' }
      };
    }
    return {
      action: 'execute',
      readyToExecute: true,
      transformFunction: parsed.transformFunction,
      outputType,
      // The output shape the model declared. The builder records it as the
      // node's targetTableSchema when it cannot describe the result for real,
      // so downstream nodes see what this function produces rather than what
      // it consumed.
      targetColumns: parsed.targetColumns ?? null,
      explanation: parsed.explanation || ''
    };
  }

  return parsed;
}

/**
 * Shape a pre-resolved buildSkillPrompt return so the renderer can use it
 * directly. We deliberately omit `prompt` so the renderer's branch
 * `if (promptResult.prompt) ... else result = promptResult` skips the AI
 * roundtrip and processSkillResponse.
 */
function preResolved(result, context) {
  return { ...result, context };
}


function buildPlanningPrompt({ userRequest, sourceConnection, sourceTableSchema, otherConnections, aiProviders, embeddingProviders }) {
  const columns = sourceTableSchema?.columns || [];
  const columnsList = columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(unknown)';
  const sample = (sourceTableSchema?.sampleData || []).slice(0, 3);

  const otherList = otherConnections.length
    ? otherConnections
        .map((c) => `- "${c.name}" (id: ${c.id || c._id}, dbType: ${c.dbType}, category: ${c.dbCategory || 'n/a'})`)
        .join('\n')
    : '(no other connections configured)';

  return `You are PLANNING a JavaScript-based transformation in Ternlux.

User's request: "${userRequest}"

Source data:
- Connection: ${sourceConnection?.name || 'Unknown'} (dbType: ${sourceConnection?.dbType || 'unknown'})
- Table/Collection: ${sourceTableSchema?.tableName || 'unknown'}
- Columns: ${columnsList}
- Sample (first 3): ${JSON.stringify(sample)}

Other available connections (the function may query any of these):
${otherList}

AI providers configured: ${aiProviders.join(', ') || 'none'}
Embedding providers configured: ${embeddingProviders.join(', ') || 'none'}

Decide ONE of:

1. **ask_questions** — Request is ambiguous, informational (what columns exist, explain prior work), or something you cannot do. Ask plain-language clarifying questions; answer what they asked inside the question if they asked something. You are a builder, not a chat partner — this is the ONLY way to reply without writing code.
2. **plan_complete** — Ready to write a transformation. List the OTHER connections + tables the function will need (do NOT list the source — it's loaded automatically), and pick providers + output destination.

Return JSON in EXACTLY one of these shapes (no markdown, no commentary):

{
  "action": "ask_questions",
  "questionsNeeded": { "topic": "Plain-language question" }
}

{
  "action": "plan_complete",
  "connectionsNeeded": [
    { "connection": "<connection name>", "tables": ["table1"] }
  ],
  "aiProvider": "openai" | "claude" | "gemini" | null,
  "embeddingProvider": "openai" | null,
  "outputType": "duckdb" | "lancedb",
  "summary": "Brief description of the planned transformation"
}

connectionsNeeded must be [] if no extra connections are required.
Choose providers ONLY from the configured lists; null if not needed.
outputType is "lancedb" only when the function will produce records with a numeric vector field; otherwise "duckdb".

WHERE THE RESULT IS WRITTEN IS ALREADY DECIDED — never ask about it. Your
function RETURNS rows; this skill persists them to the workflow's own database
by itself. There is no destination, path, folder, filename or file format for
you to choose or confirm, so a question about one cannot be answered and only
costs a round. Plan the transformation and nothing else.`;
}

async function fetchSchemaContext({ connectionsNeeded, helpers }) {
  const out = [];
  for (const item of connectionsNeeded || []) {
    let conn;
    try {
      conn = helpers.getConnection(item.connection);
    } catch (e) {
      out.push({ connection: item.connection, error: e.message });
      continue;
    }

    const tables = [];
    for (const table of item.tables || []) {
      try {
        const columns = await helpers.getColumns(conn.name || conn.id, table, conn.dbConfig?.schema || null);
        let sample = [];
        try {
          sample = await helpers.runQuery(conn.name || conn.id, {
            query: `SELECT * FROM ${table} LIMIT 3`,
            tableName: table,
            collection: table,
            filter: {},
            limit: 3
          });
        } catch (e) { /* sample is best-effort */ }
        tables.push({ table, columns, sample: (sample || []).slice(0, 3) });
      } catch (err) {
        tables.push({ table, error: err.message });
      }
    }

    out.push({
      connection: conn.name,
      dbType: conn.dbType,
      dbCategory: conn.dbCategory,
      tables
    });
  }
  return out;
}

function buildFunctionPrompt({ userRequest, plan, schemaContext, sourceConnection, sourceTableSchema }) {
  const columns = sourceTableSchema?.columns || [];
  const columnsList = columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(unknown)';
  const sample = (sourceTableSchema?.sampleData || []).slice(0, 3);

  const schemaText = (schemaContext || []).map((c) => {
    if (c.error) return `Connection "${c.connection}" — ERROR: ${c.error}`;
    const tbls = (c.tables || []).map((t) => {
      if (t.error) return `  - ${t.table}: ERROR (${t.error})`;
      const cols = (t.columns || []).map((col) => `${col.name} (${col.type || col.dataType || '?'})`).join(', ');
      const sm = JSON.stringify((t.sample || []).slice(0, 2));
      return `  - ${t.table}\n      columns: ${cols}\n      sample: ${sm}`;
    }).join('\n');
    return `Connection "${c.connection}" (${c.dbType})\n${tbls}`;
  }).join('\n\n') || '(no extra connections needed)';

  const outputType = plan.outputType || 'duckdb';

  // Only mention the local-file dbPath rule when this run actually touches a
  // local DuckDB / LanceDB target — keeps the prompt short and avoids
  // confusing the AI when there is no local connection in play.
  const sourceIsLocal = !!(sourceConnection?.localPath);
  const outputIsLocal = outputType === 'duckdb' || outputType === 'lancedb';
  const includeLocalNote = sourceIsLocal || outputIsLocal;

  return `You are writing a JavaScript transformation function for Ternlux.

User's request: "${userRequest}"

Plan summary: ${plan.summary || ''}

Source data (already loaded for you):
- Connection: ${sourceConnection?.name || 'Unknown'} (dbType: ${sourceConnection?.dbType || 'unknown'})
- Table: ${sourceTableSchema?.tableName || 'unknown'}
- Columns: ${columnsList}
- Sample (first 3): ${JSON.stringify(sample)}

Schema for the connections you said you'd need:

${schemaText}

AI provider for ctx.askAi: ${plan.aiProvider || 'first available'}
Embedding provider for ctx.vectorize: ${plan.embeddingProvider || 'first available'}
Output destination: ${outputType}

# Function contract

Write ONE async function with this exact signature:

  async function transform(records, ctx) {
    // ... your logic ...
    return outputRecords; // array of objects
  }

\`records\` is the source data already loaded as an array of objects. Return
an array of objects to write downstream. Keep the function small — every
ctx helper is a single async call so you almost never need to wrap or guard them.
${isVectorSource(sourceConnection) ? `
This source is a VECTOR store, read as plain rows: each record is its \`id\`
plus its metadata fields promoted to top level, with the vector itself dropped.
When the task is a search rather than a pass over these rows — "the N most
similar to X" — ignore \`records\` and query the store through ctx.runQuery,
embedding the probe text with ctx.vectorize first.
` : ''}

# ctx helpers (all simple, single-call)

- ctx.connections                 -> [{ id, name, dbType, dbCategory }]
- ctx.aiProviders                 -> available providers, e.g. ['openai']
- await ctx.runQuery(connection, queryStringOrObject, dbPath?)
    Saved connection (dbPath omitted):
      SQL:    ctx.runQuery('warehouse', 'SELECT id, email FROM users')
      NoSQL:  ctx.runQuery('mongo-prod', { collection: 'users', filter: {}, limit: 100 })
      Vector: ctx.runQuery('pinecone', { operation: 'queryVectors', indexName: 'products-index',
                                         namespace: 'products', queryVector: v, topK: 5 })
              Matches come back as { id, score, values, metadata, namespace } —
              \`values\` is the stored vector, \`metadata\` the record's own fields.
    Returns an array of rows.
- await ctx.getTables(connection, dbPath?)
- await ctx.getColumns(connection, table, schema?, dbPath?)
- await ctx.askAi(prompt, { provider?, model?, systemPrompt?, maxTokens? })
    Returns the model's text response.
- await ctx.vectorize(['text', ...], { provider?, model? })
    Returns an array of vectors aligned with the input texts.
- ctx.axios                                     -> axios module for arbitrary HTTP
- await ctx.apiCredentials(connection)
    Credentials for a saved API connection: { baseUrl, params }.
    \`params\` is an object keyed by the EXACT key names the user saved on that
    connection, e.g. { 'api key': '...', 'X-Tenant-Id': '...' }.
- ctx.log(...args)                              -> console log

\`connection\` accepts either the saved connection's name/id, OR — when reading
local data — the dbType string ('duckdb' | 'lancedb').

# Calling an authenticated API

Credentials are decrypted only while your function runs. You never see their
values and MUST NOT put a literal key, token, or password in the code you
write. Read them at run time from \`ctx.apiCredentials\` and pass them wherever
that API expects them — a query parameter, a header, or a body field:

  const { baseUrl, params } = await ctx.apiCredentials('fixer trading API');
  const res = await ctx.axios.get(baseUrl + 'api/latest', {
    params: { access_key: params['api key'], base: 'EUR' },
  });

Index \`params\` with the exact key name as saved — including spaces and case.
That name identifies the value; it is not where the value goes. Which header,
query parameter or body field carries it is the API's contract, not the
connection's — take it from the endpoint you are calling. A saved name is free
text and may be something no header or parameter would accept.

Never log, return, or embed a credential value in your output rows.

Let a failed call throw. Catching an error to return a row of nulls or a status
field reports success for a call that did not work, and every reader downstream
believes it.
${includeLocalNote ? `

# Local data (duckdb / lancedb)

This run touches local data, so you MUST pass the absolute path as the
trailing \`dbPath\` argument. Saved connections aren't used for these — pass
the dbType string in place of the connection name.

A \`.duckdb\` path is a workflow's database, and every node's result is a table
in it — query those tables by name. Any other path is a single data file
(csv / json / parquet), addressable by its own filename without the extension.

  ctx.runQuery('duckdb', { query: 'SELECT * FROM orders_clean LIMIT 1000' }, '/abs/path/wf_x.duckdb')
  ctx.runQuery('duckdb', { query: 'SELECT * FROM customers' },                '/abs/path/customers.parquet')
  ctx.runQuery('duckdb', { operation: 'insert', mode: 'replace', tableName: 'scratch', docs: rows }, '/abs/path/wf_x.duckdb')
  ctx.runQuery('lancedb', { operation: 'queryVectors', tableName: 'docs', queryVector: v, topK: 5 }, '/abs/path/lancedir')
  ctx.runQuery('lancedb', { operation: 'upsert',  tableName: 'docs', data: records },          '/abs/path/lancedir')

DuckDB speaks PostgreSQL-flavoured SQL. Reads are ordinary SELECTs; there is
no filter-object form.

\`getTables('duckdb' | 'lancedb', dbPath)\` and
\`getColumns(dbType, table, null, dbPath)\` work the same way.
` : ''}

# Output destination

"${outputType}":
${outputType === 'lancedb'
  ? `- Each output record MUST include a numeric \`vector\` array. Either carry one
  you already have — a vector search returns the stored vector as \`values\` —
  or embed the text yourself with \`await ctx.vectorize([...])\`. A record
  without one fails the write.`
  : `- Plain JSON records, no vector field required. They are written as a
  DuckDB table, so give every record the same keys — a key that appears on
  only some records becomes a column that is NULL for the rest.`}

# Response format

Return JSON in one of these shapes (no markdown, no commentary):

Ready to execute:
{
  "action": "execute",
  "transformFunction": "async function transform(records, ctx) { /* ... */ return outputRecords; }",
  "outputType": "${outputType}",
  "targetColumns": [{"name": "col", "type": "TYPE"}],
  "explanation": "Short description"
}

\`targetColumns\` is every key present on the records your function RETURNS — the
output shape, not the input's. Nodes downstream of this one are configured from
it, so a key listed here that the function never sets becomes a reference to a
column that does not exist. Use "*" only when the records pass through with their
keys unchanged.

If still unclear (rare at this stage):
{
  "action": "ask_questions",
  "questionsNeeded": { "topic": "..." }
}

Keep the function concise. Use only the ctx helpers listed above.`;
}

/** A vector store, whichever way the connection records it. */
const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);
const isVectorSource = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType));

/**
 * A vector as a plain numeric array, or null when the value is not one.
 *
 * Generated code produces a real array. A function that passed a row straight
 * through produces whatever the read yielded: a Float32Array, or — for a
 * LanceDB source — an Apache Arrow `Vector`, which is neither an array nor a
 * typed array and whose dimensions are not index-accessible (`v[0]` is
 * undefined). Both are vectors; convert rather than reject.
 *
 * An empty array is rejected here rather than sent on to fail inside the Arrow
 * writer with a less obvious message.
 */
function toNumericVector(value) {
  if (value == null || typeof value === 'string') return null;
  const v = (!Array.isArray(value) && !ArrayBuffer.isView(value) && typeof value.toArray === 'function')
    ? value.toArray()
    : value;
  if (Array.isArray(v)) return v.length > 0 ? v : null;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return v.length > 0 ? Array.from(v, Number) : null;
  }
  if (typeof v[Symbol.iterator] === 'function') {
    const arr = Array.from(v, Number);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

/**
 * Rows from a vector source (LanceDB or Pinecone).
 *
 * A vector store answers neither of the two shapes below: it has no SQL and no
 * Mongo-style collection query. Without this branch a Pinecone source fell
 * through to the SQL form and reached the connector as
 * `{ query: 'SELECT * FROM products-index' }` — no `indexName`, no `operation`
 * — which comes back as "Index name is required", so the node died before the
 * transform function ever ran. LanceDB failed the same way with `dbType` set
 * but no `localPath` reaching the reader.
 *
 * The pull itself is vector-db-executor's `fetchVectorSourceRecords` — the same
 * function the JOIN executor uses (NodeExecution.pullJoinSourceRows), so a
 * vector source reads identically whether it feeds a join or a transformer.
 * It flattens id + metadata to top-level columns and drops the vector, which is
 * the row shape `transform(records, ctx)` expects.
 */
async function loadVectorSourceRecords({ sourceConnection, sourceTableSchema, helpers }) {
  const pm = helpers.pluginManager;
  const skill = pm && pm.hasSkill && pm.hasSkill('vector-db-executor')
    ? pm.getSkill('vector-db-executor')
    : null;
  if (!skill || typeof skill.fetchVectorSourceRecords !== 'function') {
    throw new Error('vector-db-executor skill not available; cannot read from a vector source');
  }

  // Index coordinates live in different places depending on whether the node
  // was authored by the AI builder or wired from a saved connection. Same
  // fallback order as pullJoinSourceRows, for the same reason.
  const tableName = sourceTableSchema?.tableName
    || sourceConnection.dbConfig?.tableName
    || sourceConnection.indexName;
  if (!tableName) {
    throw new Error('Vector source: no tableName/indexName on the schema or the connection');
  }
  const indexName = sourceTableSchema?.indexName
    || sourceConnection.indexName
    || sourceConnection.dbConfig?.indexName
    || tableName;
  const namespace = sourceTableSchema?.namespace
    || sourceTableSchema?.schema
    || sourceConnection.namespace
    || sourceConnection.dbConfig?.namespace
    || '';

  return skill.fetchVectorSourceRecords({
    sourceConnection: {
      ...sourceConnection,
      localPath: sourceConnection.localPath
        || sourceConnection.dbConfig?.dbPath
        || sourceTableSchema?.localPath
        || null,
    },
    // Merged, not `||`: the resolved coordinates must survive a source that
    // already has a schema, which is every source in a built workflow.
    sourceTableSchema: { ...(sourceTableSchema || {}), tableName, indexName, namespace },
    // No search text — a transformer reads its source, it does not search it.
    // Similarity search belongs inside the function, via ctx.runQuery.
    vectorFetchOperation: { useEmbeddingSearch: false, filter: sourceConnection.dbType === 'pinecone' ? {} : '', topK: 10000 },
    // This is a full read of the source, not a join key lookup: the function
    // is free to pass the vector through to a new vector table, and several
    // do. The join default drops the dimensions, which left the generated
    // function with no `vector` field to preserve and the LanceDB write below
    // rejecting every row it produced.
    includeVector: true,
    pluginManager: pm,
    getFullConfig: helpers.getFullConfig,
    helpers,
  });
}

/**
 * Load source data using the same pattern as handleTransformSQL/NoSQL.
 * Local files are read directly; remote connections go through the connector
 * via helpers.runQuery; vector stores go through vector-db-executor.
 */
async function loadSourceRecords({ sourceConnection, sourceTableSchema, helpers }) {
  if (!sourceConnection) return [];

  // Before the local/remote split: a LanceDB source is local and a Pinecone one
  // is remote, but neither is readable by the query forms below.
  if (isVectorSource(sourceConnection)) {
    return loadVectorSourceRecords({ sourceConnection, sourceTableSchema, helpers });
  }

  const isLocal = !!sourceConnection.localPath;

  if (isLocal && sourceConnection.dbType === 'duckdb') {
    // A workflow database holds the upstream node's result as a named table.
    // A plain data file is addressable by its own basename — the name
    // public/lib/duckdb.js registers it under. A WORKBOOK is the exception:
    // it registers a view per sheet, so the recorded table name is what picks
    // the sheet, and the file's basename would name only the first.
    const localPath = sourceConnection.localPath;
    const recorded = sourceTableSchema.originalTableName || sourceTableSchema.tableName;
    const isWorkbook = /\.(xlsx|xlsm)$/i.test(localPath);
    const tableName = (/\.duckdb$/i.test(localPath) || isWorkbook)
      ? recorded
      : path.basename(localPath, path.extname(localPath));
    if (!tableName) throw new Error('No table recorded for the local source');
    return helpers.runQuery('duckdb', { query: `SELECT * FROM "${tableName}"` }, localPath);
  }

  if (isLocal && sourceConnection.dbType === 'sqlite') {
    const tableName = sourceTableSchema.originalTableName || sourceTableSchema.tableName;
    return helpers.runQuery('sqlite', { query: `SELECT * FROM ${tableName}` }, sourceConnection.localPath);
  }

  // Remote connection — dispatch via helpers.runQuery (no need to look up
  // connectors or credentials in the skill).
  const isNoSQL = sourceConnection.dbType === 'mongodb';
  const tableName = isNoSQL
    ? (sourceTableSchema.originalTableName || sourceTableSchema.tableName)
    : sourceTableSchema.tableName;

  // NoSQL connectors (MongoDB) expect a structured { collection, filter }
  // query and JSON.parse any `query` string they receive — so never hand them a
  // SQL string. SQL connectors get the SELECT form.
  //
  // No `limit`. The transform function is handed its source as one array and
  // that is not changing, but it must be the WHOLE source: a million-row cap
  // here meant a transform over a larger table quietly ran on part of it and
  // returned an answer that looked complete.
  const queryObj = isNoSQL
    ? {
        collection: tableName,
        filter: {}
      }
    : {
        query: `SELECT * FROM ${sourceTableSchema.tableName}`,
        tableName,
        schema: sourceTableSchema.schema || sourceConnection.dbConfig?.schema,
        sheetName: sourceTableSchema.sheetName
      };
  return helpers.runQuery(sourceConnection.name || sourceConnection.id, queryObj);
}

/**
 * Compile and run a transform(records, ctx) function INLINE and return its
 * output array — WITHOUT loading source records or persisting anything.
 * Mirrors the compile/run half of `execute`, but is meant for callers (e.g.
 * the chat assistant's run_javascript tool) that just want the computed result
 * data back so they can answer or visualise it. Caller supplies `records`.
 */
async function runTransformFunction({ transformFunction, records = [], helpers }) {
  if (!helpers) throw new Error('helpers bundle is required');
  if (!transformFunction) throw new Error('transformFunction is required');

  let fn;
  try {
    // eslint-disable-next-line no-eval
    fn = eval(`(${transformFunction})`);
  } catch (err) {
    throw new Error(`Failed to compile transform function: ${err.message}`);
  }
  if (typeof fn !== 'function') throw new Error('Compiled transform is not a function');

  const secrets = new Set();
  const ctx = buildContext(helpers, secrets);
  const result = await fn(Array.isArray(records) ? records : [], ctx);
  // Credentials the function was handed never travel out with its rows — see
  // scrubSecrets. This path feeds the chat, where the rows go to the model.
  return scrubSecrets(Array.isArray(result) ? result : [result], secrets);
}

function buildConfig({
  outputType,
  targetTableName,
  targetLocalPath,
  sourceConnection,
  sourceTableSchema,
  sourceNodeId,
  sourceNodeLabel,
  sourceConnectionName,
  sourceConnectionType,
  userRequest,
  transformFunction,
  recordCount
}) {
  const isVector = outputType === 'lancedb';
  return {
    nodeType: 'transformer',
    sourceNodeId,
    sourceNodeLabel,
    sourceConnectionId: sourceConnection?.id,
    sourceConnectionName,
    sourceConnectionType,
    sourceDbType: sourceConnection?.dbType,
    sourceDbConfig: sourceConnection?.dbConfig,
    sourceLocalPath: sourceConnection?.localPath,
    sourceTableName: sourceTableSchema?.originalTableName || sourceTableSchema?.tableName,
    sourceSchema: sourceTableSchema?.schema,
    sourceTableSchema,
    storageLocation: 'local',
    targetConnectionId: isVector ? 'local-lancedb' : 'local-duckdb',
    targetConnectionName: isVector ? 'Local LanceDB' : 'Local file',
    targetConnectionType: 'file',
    targetDbType: outputType,
    targetDbCategory: isVector ? 'Vector' : 'SQL',
    targetDbConfig: isVector ? { dbPath: targetLocalPath, tableName: targetTableName } : {},
    targetLocalPath,
    // A DuckDB result is a table, addressed by name — the same shape every
    // other local node writes, so previews and downstream nodes need no
    // special case for skill output.
    targetTableName,
    targetPreviewSql: isVector ? null : `SELECT * FROM ${targetTableName} LIMIT 100`,
    transformationRequest: userRequest || 'JavaScript transformation',
    transformFunction,
    skillId: 'javascript-executor',
    usesSkill: true,
    skillExecution: {
      skillId: 'javascript-executor',
      outputType,
      recordCount
    },
    needsSchemaLoad: true
  };
}

// Expose the stage-2 prompt builder, the source loader, and the inline runner
// so other callers (notably public/chat/chatAssistant.js's run_javascript
// tool) can drive the same "build function prompt → callAI → execute" flow
// without going through the full buildSkillPrompt two-stage planner.
module.exports.buildFunctionPrompt   = buildFunctionPrompt;
module.exports.loadSourceRecords     = loadSourceRecords;
module.exports.runTransformFunction  = runTransformFunction;
