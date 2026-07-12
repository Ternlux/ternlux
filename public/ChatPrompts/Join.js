/** 
 * Chat Prompts for Join Node Configuration
 * Handles intelligent join analysis and query generation
 */

const JoinPrompts = {
  /**
   * Analyze join request to determine configuration needs
   */
  joinAnalysisRequest: (
    userRequest,
    sourcesInfo,
    availableDestinations,
    operationMode,
    availableSkills = [],
    vectorContext = {}
  ) => `
You are an expert data engineer helping configure a join operation between multiple data sources.

Current User Request: "${userRequest}"

Available Sources:
${sourcesInfo}

Available Destinations:
${availableDestinations}

${operationMode === 'new_table' ? 'Operation Mode: NEW TABLE (creating a new table/collection)\n' : ''}
${(vectorContext.hasVectorSource || vectorContext.hasVectorDestination) ? `
## Vector / embedding context detected
${vectorContext.hasVectorSource ? '- One or more SOURCES are vector databases (LanceDB / Pinecone).\n' : ''}${vectorContext.hasVectorDestination ? '- The DESTINATION is a vector database (LanceDB / Pinecone).\n' : ''}
You MUST decide which scenario applies and report it back via the \`vectorRequired\` flag in your response (true = Scenario B, false = Scenario A or no vector logic). Read the user's request literally — do not assume similarity search just because a vector DB is involved.

**Scenario A — Treat the vector DB as a regular database (\`vectorRequired: false\`).**
The user just wants to read records (id + metadata fields) and join them by equality on a normal key. No embeddings, no similarity search.
- The executor will fetch the vector source via its API (filter / metadata only) and flatten id + metadata into row-shaped objects — from then on treat it exactly like a NoSQL source.
- Right choice for: "join the article rows where category='news'", "read all records from the index", "use the metadata fields to join".

**Scenario B — Similarity search / embedding is part of the join (\`vectorRequired: true\`).**
The user wants embeddings or similarity search to participate in the join logic itself: "find rows similar to …", "for each customer match the most relevant article", "embed this column and upsert", "vectorize the bio column", "semantic match on the description".
- The actual embedding + similarity-search code runs **locally in Node**, inside an async \`javascriptFunction\` you'll emit at the next step. The function uses \`ctx.vectorize(texts, ...)\` to embed and \`ctx.runQuery(connection, { operation: 'queryVectors', queryVector, topK }, dbPath?)\` to search the vector source — per row, ad hoc, no SQL needed.
- Once the function returns, the executor inserts the rows it returned into the destination. The destination DB does NO compute here — it is only the place the final rows get written.
- This means **NeDB / MongoDB are perfectly valid destinations for Scenario B** even though they don't natively do SQL or vectors. **Do NOT ask the user to pick Postgres+pgvector / DuckDB / Snowflake / "a vector engine that can run the embedding"** — none of that matters; the embedding and search happen in the function before insert.
- Do not try to express the embedding/search as a fixed SQL search query or a one-shot \`searchQuery\` — emit a \`javascriptFunction\` instead.
- Confirm with the user only what's actually needed for their intent: which column to embed / search by, which vector source to query, an embedding provider/model if there's a choice, and the desired \`topK\`. The destination itself is fine as long as it's NoSQL or a vector DB.

Always handle vector cases inline — set \`usesSkill: false\`.
` : `
## Vector context
No vector source or destination is configured. If the user asks for embeddings, similarity search, or vectorising a column, set \`vectorRequired: true\`. The embedding / similarity-search code runs locally in Node inside the \`javascriptFunction\` (using \`ctx.vectorize\` and \`ctx.runQuery\`), and the destination DB is only used to store the final rows — so a NoSQL destination (Mongo / NeDB) is fine, and vector destinations are also fine. Ask the user to pick a NoSQL or vector destination if they haven't yet; do NOT ask them to switch to a SQL engine that can "execute embeddings" — that's not how this runs. If neither vector source nor destination is configured and the user does NOT mention embeddings/similarity, leave \`vectorRequired\` as false.
`}
${availableSkills.length > 0 ? `**Available Skills**:
You have access to these special join skills that can be used instead of standard SQL/NoSQL joins:

${availableSkills.map(skill => `
**${skill.name}** (${skill.id}):
${skill.description.description}

Capabilities:
${skill.description.capabilities.map(cap => `- ${cap}`).join('\n')}

${skill.prompts ? skill.prompts.systemContext : ''}
`).join('\n')}

**IMPORTANT**: If a skill is better suited for the join operation than standard SQL/NoSQL, you can specify "usesSkill": true and "skillId": "<skill-id>" in your response.
` : ''}

Analyze the user's request and conversation history to determine the next steps. Return JSON with the following structure:
{
  "action": "answer_directly" | "ask_questions" | "generate_join",
  "usesSkill": false | true,
  "skillId": "skill-id-here (only if usesSkill is true)",
  "skillExplanation": "Brief explanation of why this skill is being used (only if usesSkill is true)",
  "vectorRequired": false | true,   // true ONLY when this join needs runtime embedding / similarity search (Scenario B). Defaults to false. Read the user's intent — a vector source on its own does NOT imply vectorRequired.
  "inferredSettings": {
    "destinationSelection": "connection_id or local-sqlite or local-nedb or local-lancedb" (optional; use local-lancedb when the user wants the result stored as a LOCAL vector table — embeddings / a lancedb table / similarity-searchable — and named no saved vector connection. Do NOT downgrade a requested local vector table to local-sqlite),
    "operationMode": "new_table" | "merge_existing" (optional),
    "targetTableName": "table_name" ${operationMode === 'new_table' ? '(REQUIRED for new_table mode)' : '(optional)'},
    "joinType": "INNER" | "LEFT" | "FULL" (optional),
    "joinColumns": [{"source1": "col", "source2": "col"}] (optional),
    "selectedColumns": {"sourceLabel1": ["col1", "col2"], "sourceLabel2": ["col3"]} (optional)
  },
  "followUpQuestion": "Single clear question to ask the user" (only if action is "ask_questions"),
  "directAnswer": "answer if action is answer_directly" (optional),
  "reasoning": "explanation of decision"
}

CRITICAL RULES FOR JOINS:

1. When to answer_directly:
   - User is asking informational questions (not requesting a join)
   - Examples: "What columns are in source 1?", "How many sources?", "What join types are supported?"

2. When to ask_questions:
   - You are missing ANY of the following information needed to generate a join
   - Continue asking questions until you have ALL required information

   Required Information Checklist:
   a) Join Relationships: How each table connects to others (which columns match between tables)
      - NEVER assume relationships without asking
      - Ask: "Which column in [TableA] matches with which column in [TableB]?"
      - Get confirmation for EVERY table pair being joined

   b) Join Types: The type of join for each relationship
      - Ask: "Should this be an INNER join (only matching rows), LEFT join (all from TableA + matches from TableB), RIGHT join, or FULL OUTER join?"
      - For multiple sources: "How should [TableA] join to [TableB]? And how should the result join to [TableC]?"

   c) Column Selection: Which columns to include in the final output
      - Ask: "Which columns do you want in the final table? Please specify from each source."
      - Example: "From customers: customer_id, name; From orders: order_id, total"

   d) Table Names and Context: Understanding what each source represents
      - If table names are unclear, ask: "Can you describe what data each source contains?"
${operationMode === 'new_table' ? `
   e) Target Table Name: REQUIRED for new_table mode
      - If user hasn't specified a name for the new table/collection, ask: "What would you like to name the new table/collection?"
      - This is MANDATORY before generating the join
` : ''}
3. When to generate_join:
   - ONLY when you have explicitly confirmed ALL of:
     a) Join relationships (exact column mappings between ALL tables)
     b) Join types (INNER/LEFT/FULL for each join)
     c) Column selection (which columns from each source)${operationMode === 'new_table' ? '\n     d) Target table name (REQUIRED for new_table mode)' : ''}
   - User has explicitly stated this information in current or previous messages
   - NO ASSUMPTIONS about relationships even if column names look similar

4. Follow-up Question Guidelines:
   - Ask ONE clear, specific question at a time
   - Build on previous answers from chat history
   - Be specific: mention table names and column names you've seen
   - Examples of good questions:
     * "I see TableA has 'customer_id' and TableB has 'cust_id'. Should these be joined together? If not, how should TableA be joined with TableB?"
     * "For the join between Customers and Orders, do you want an INNER join (only customers with orders) or LEFT join (all customers, even without orders)?"
     * "Which columns would you like in the final result? For example, from Customers: [list columns], from Orders: [list columns]"

5. NoSQL Destination Joins:
   - If destination is MongoDB or NeDB (local-nedb), note that joins will be performed using JavaScript execution in the local environment
   - Data from all sources will be loaded locally, joined using JavaScript, then uploaded to the destination
   - This allows for complex join logic that MongoDB/NeDB don't natively support

5b. Vector / embedding scenarios (only when there is a vector source/destination or the user mentions embeddings, similarity, vectorising):
   - First, decide which scenario applies (see "Vector / embedding context detected" above): A) treat the vector DB as a regular DB, or B) do embedding/similarity search inside the join.
   - For Scenario A: ask only what's needed for a normal join (which metadata columns to match, join type, columns to keep). The vector source will be fetched with a metadata filter and treated like any NoSQL source.
   - For Scenario B: confirm with the user what should be embedded and against what (e.g. "for each customer, search the article index using customer.bio for the top 5 matches"), pick an embedding provider/model if there is choice, and pick a NoSQL or vector destination — the join must run as a \`javascriptFunction\`.
   - Do not invent the embedding/search logic in static SQL. The actual embedding & similarity-search code is generated as part of the \`javascriptFunction\` in the join-generation step.

6. Confidence Requirement:
   - If you have ANY doubt about relationships, join types, or column selection → ask_questions
   - Only use generate_join when 100% certain from explicit user statements

Examples:

Example 1 - Need to ask questions:
User: "Join these tables together"
→ action: "ask_questions", followUpQuestion: "I see you have [SourceA] with columns [cols] and [SourceB] with columns [cols]. Which column in SourceA should match with which column in SourceB?"

Example 2 - Still asking follow-ups:
Previous conversation established join columns
Current: "Use customer_id to join"
→ action: "ask_questions", followUpQuestion: "Should this be an INNER join (only matching customers) or a LEFT join (all customers from the first table)?"

Example 3 - Ready to generate:
Previous conversation established join columns, join types
Current: "Include all columns from both tables"
→ action: "generate_join" with all inferredSettings populated

Example 4 - Informational:
User: "What columns are available in the first source?"
→ action: "answer_directly", directAnswer: "The first source contains these columns: ..."

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. If you need to explain something or answer a question, put that text inside the "directAnswer" field and set "action" to "answer_directly" — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.
  `,

  /**
   * Generate join query for specific database type
   */
  generateJoinQuery: (dbType, sources, joinSettings, destinationConfig) => `
You are an expert in ${dbType} database systems. Generate a complete join query.

Sources to Join:
${JSON.stringify(sources, null, 2)}

Join Settings:
${JSON.stringify(joinSettings, null, 2)}

Destination Configuration:
${JSON.stringify(destinationConfig, null, 2)}

Source Requirements:
Each source has been analyzed to determine what fields are needed based on source type and destination type.

${sources.map((src, idx) => `
Source ${idx + 1}: ${src.sourceNodeLabel || src.sourceNodeId}
- Table/Index: ${src.tableName}
- Source Type: ${src.dbType || 'unknown'}${src.isSourceVector ? ' [VECTOR DB]' : ''}
- In Destination DB: ${src.isInDestinationDb ? 'Yes (no temp table needed)' : 'No (needs temp table)'}
- Required Fields: ${src.requiredFields.length > 0 ? src.requiredFields.join(', ') : 'None (reference existing table directly in joinSql)'}
`).join('')}

${sources.some((s) => s.isSourceVector) ? `
## Vector source(s) detected — Scenario A (treat as a regular DB)
For each vector source emit \`vectorFetchOperation\` instead of \`sql\`/\`nosqlOperation\`. The executor pulls the rows, flattens id + metadata into top-level columns (the vector itself is dropped), and from then on the rows are treated exactly like a NoSQL source — feed them into your \`joinSql\` via the temp-table contract for SQL destinations, or into your \`javascriptFunction\` for NoSQL / vector destinations.

\`vectorFetchOperation\` shape:
{
  "useEmbeddingSearch": false,
  "filter": "<LanceDB SQL WHERE>" | { /* Pinecone metadata filter */ } | "" | {},
  "topK": 10000
}
Do NOT emit \`searchQuery\` here. If the user wants similarity search instead, switch to Scenario B (a JS-function join with embedding / search done at runtime via \`ctx\`).
` : ''}
${destinationConfig.vectorRequired ? `
## Scenario B — embedding / similarity search inside the join (\`javascriptFunction\` + \`ctx\`)
When the user wants embeddings or similarity search to be part of the join logic (e.g. "for each customer, find the 5 most similar articles", "vectorize this column and upsert", "fuzzy match on text"), express the entire embedding/search/match flow inside the AI-written async \`javascriptFunction\`. The destination must be NoSQL or a vector DB so the executor runs the function instead of a SQL JOIN.

### How this actually runs (read this before generating anything)
The destination DB does NO compute here — it is only the place the final rows get written. Embedding, similarity search, joining, and any extra lookups all run **locally in Node**, inside the \`javascriptFunction\` you emit. Concretely the executor performs these steps in order:

  1. Load each source's rows into memory:
       • SQL source     → executor runs the \`sql\` you emit on that source
       • NoSQL source   → executor runs the \`nosqlOperation\` you emit
       • Vector source  → executor pulls rows via \`vectorFetchOperation\` (filter-only fetch — \`useEmbeddingSearch: false\` is fine; if you need similarity search at runtime, do it from inside the function instead, via \`ctx.runQuery(...)\`)
       • Local file source → executor pulls via the source's \`localPath\` automatically
  2. Call your function: \`const joinedRows = await joinData(source1Data, source2Data, /* …, */ ctx);\`
     Inside the function you may freely call \`await ctx.vectorize(...)\` to embed text and \`await ctx.runQuery(connection, query, dbPath?)\` to do per-row similarity searches, ad-hoc lookups, etc. None of this requires the destination to support SQL or vectors.
  3. Insert the array you return into the destination:
       • NoSQL destination → bulk insert into the target collection
       • Vector destination → embed the chosen column and upsert vectors (you also emit a \`vectorDestination\` block — see below)

So if the user picks NeDB / MongoDB as the destination, that's fine. NeDB doesn't need to "execute SQL" or "generate embeddings" — your function does, in Node, before the rows are inserted. Do NOT ask the user to switch to Postgres+pgvector / DuckDB / Snowflake / etc. for this reason; pick whichever destination they chose and put the embedding + search logic inside the function.

Function contract:

  async function joinData(source1Data, source2Data, /* …, */ ctx) {
    // ... your logic ...
    return joinedRows; // array of objects
  }

The \`ctx\` argument is appended after all source-data arrays. It exposes simple async helpers (same surface as the javascript-executor skill):

- ctx.connections                 -> [{ id, name, dbType, dbCategory }]
- ctx.aiProviders                 -> available providers, e.g. ['openai']
- ctx.embeddingProviders          -> available embedding providers
- await ctx.runQuery(connection, queryStringOrObject, dbPath?)
    Saved connection (dbPath omitted):
      SQL:    ctx.runQuery('warehouse', 'SELECT id, email FROM users')
      NoSQL:  ctx.runQuery('mongo-prod', { collection: 'users', filter: {}, limit: 100 })
- await ctx.getTables(connection, dbPath?)
- await ctx.getColumns(connection, table, schema?, dbPath?)
- await ctx.askAi(prompt, { provider?, model?, systemPrompt?, maxTokens? })
- await ctx.vectorize(['text', ...], { provider?, model? })   -> array of vectors aligned with the input texts
- ctx.axios                                                   -> axios module for arbitrary HTTP
- ctx.log(...args)

\`connection\` accepts either the saved connection's name/id, OR — when reading
a local file — the dbType string ('nedb' | 'sqlite' | 'lancedb'). Source data
arrays passed as the leading arguments are already loaded — use them as-is
unless you genuinely need fresh data.${destinationConfig.hasLocalConnection ? `

Local files are part of this join (one or more sources / the destination is a
local nedb / sqlite / lancedb file). For those, you MUST pass the absolute
\`dbPath\` as the trailing argument and use the dbType string in place of the
connection name. Each source's path is provided in the source list above as
\`localPath\` — copy that value verbatim. Examples:

  ctx.runQuery('nedb', { filter: {}, limit: 1000 }, '/abs/path/file.db')
  ctx.runQuery('nedb', { operation: 'insert', mode: 'replace', docs: rows }, '/abs/path/out.db')
  ctx.runQuery('sqlite', { query: 'SELECT * FROM customers' }, '/abs/path/store.db')
  ctx.runQuery('lancedb', { operation: 'queryVectors', tableName: 'docs', queryVector: v, topK: 5 }, '/abs/path/lancedir')
  ctx.runQuery('lancedb', { operation: 'upsert',  tableName: 'docs', data: records },          '/abs/path/lancedir')` : ''}

Pattern for similarity search joins (per-row, semantic match):

  async function joinData(customers, ctx) {
    // 1. Embed the driving column once per unique value.
    const queries = [...new Set(customers.map(c => c.bio).filter(Boolean))];
    const queryVectors = await ctx.vectorize(queries, { provider: 'openai', model: 'text-embedding-3-small' });
    const byQuery = new Map(queries.map((q, i) => [q, queryVectors[i]]));

    // 2. For each customer, search the vector connection for top-K neighbours.
    const results = [];
    for (const c of customers) {
      const v = byQuery.get(c.bio);
      if (!v) continue;
      const matches = await ctx.runQuery('article-index', {
        operation: 'queryVectors',
        queryVector: v,
        topK: 5,
        filter: {}
      });
      for (const m of matches) {
        results.push({ ...c, ...m, _score: m.score });
      }
    }
    return results;
  }

Notes:
- For Scenario B, do NOT emit \`vectorFetchOperation\` for the vector connection if you intend to run the search inside the function — instead reference it through \`ctx.runQuery(connectionName, { operation: 'queryVectors', ... })\` so each query happens at the right time with the right vector.
- For Scenario A (no embeddings), you SHOULD still emit \`vectorFetchOperation\` so the executor pre-loads the rows and you can use them like NoSQL data.
- The function must return an array of plain objects. Vector-destination joins also need a top-level \`vectorDestination\` block — see the "Vector destination" section.
` : ''}

${destinationConfig.isVectorDestination ? `
## Vector destination
The destination is a vector database. The executor will:
  1. Load every source into memory (using your \`sql\`/\`nosqlOperation\`/\`vectorFetchOperation\` per source).
  2. Run your \`javascriptFunction\` to produce an array of joined rows.
  3. Call the \`vector-db-executor\` skill to embed ONE column from the joined rows and upsert vectors into the destination.

You MUST emit a \`javascriptFunction\` (no SQL) plus these top-level vector destination fields:
  "vectorDestination": {
    "vectorDbType": "lancedb" | "pinecone" | "<other>",
    "targetTable": "<index/table name>",
    "columnToEmbed": "<column from the joined output>",
    "embeddingProvider": "openai" | "huggingface",
    "embeddingModel": "<provider-specific model id>",
    "indexName": "<lowercase-with-hyphens>",   // Pinecone only
    "namespace": "<optional>"                    // Pinecone only
  }
Do NOT emit \`targetDdl\`, \`joinSql\`, or \`previewSql\` — those are skipped for vector destinations.
` : ''}

Output Structure:
${destinationConfig.isVectorDestination ? `
FOR VECTOR DESTINATION:
All sources are loaded into memory and joined with JavaScript. The skill embeds a chosen column on the joined output and upserts vectors.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    {
      "sourceNodeId": "...",
      // Provide ONE of:
      "sql": "SELECT col1, col2 FROM table {LIMIT_OFFSET_HERE}",            // SQL source
      "nosqlOperation": "{ \\"collection\\": \\"users\\", \\"filter\\": {} }",  // NoSQL source
      "vectorFetchOperation": { "useEmbeddingSearch": false, "filter": "", "topK": 10000 } // Vector source
    }
  ],
  "javascriptFunction": "function joinData(source1Data, source2Data) { /* return joined rows */ }",
  "selectedColumns": {"sourceNodeId1": ["col1"], "sourceNodeId2": ["col2"]},
  "vectorDestination": {
    "vectorDbType": "lancedb",
    "targetTable": "${destinationConfig.tableName}",
    "columnToEmbed": "<column-from-joined-output>",
    "embeddingProvider": "openai",
    "embeddingModel": "text-embedding-3-small"
  }
}
` : (dbType === 'mongodb' || dbType === 'nedb' ? `
FOR NOSQL DESTINATION:
All sources are loaded into memory and joined using JavaScript.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    // For each source, include sourceNodeId and ONLY its required fields
    {
      "sourceNodeId": "...",
      "nosqlOperation": "..." // If source is NoSQL: JSON string like {\\"collection\\": \\"users\\", \\"filter\\": {}}
      // OR
      "sql": "..." // If source is SQL: SELECT statement to fetch data. MUST end with {LIMIT_OFFSET_HERE} placeholder
    }
  ],
  "javascriptFunction": "function joinData(source1Data, source2Data, ...) { /* join logic */ return results; }",
  "targetCollection": "${destinationConfig.tableName}",
  "selectedColumns": {"sourceNodeId1": ["col1", "col2"], "sourceNodeId2": ["col3"]}
}

Example (NoSQL source + SQL source):
{
  "explanation": "Join MongoDB users with PostgreSQL orders on user_id",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "nosqlOperation": "{\\"collection\\": \\"users\\", \\"filter\\": {}}"
    },
    {
      "sourceNodeId": "node-def-456",
      "sql": "SELECT order_id, user_id, total FROM orders {LIMIT_OFFSET_HERE}"
    }
  ],
  "javascriptFunction": "function joinData(usersData, ordersData) { const results = []; for (const user of usersData) { for (const order of ordersData) { if (user.user_id === order.user_id) { results.push({ user_id: user.user_id, name: user.name, order_id: order.order_id, total: order.total }); } } } return results; }",
  "targetCollection": "user_orders",
  "selectedColumns": {"node-abc-123": ["user_id", "name"], "node-def-456": ["order_id", "total"]}
}
` : `
FOR SQL DESTINATION:
External sources are loaded into temp tables. Sources already in destination are referenced directly.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    // For each source, include sourceNodeId and ONLY its required fields
    {
      "sourceNodeId": "...",
      "tempTableName": "temp_node_xxx" // Only if needs temp table. For databases with schemas (Snowflake, PostgreSQL, etc.), use fully-qualified name matching DDL
      "ddl": "CREATE TABLE temp_node_xxx (col1 TYPE, col2 TYPE, col3 TYPE)" // Columns in DDL MUST be in the SAME ORDER as selectedColumns. Table name MUST match tempTableName exactly
      "sql": "SELECT col1, col2, col3 FROM ... {LIMIT_OFFSET_HERE}" // CRITICAL: Must end with {LIMIT_OFFSET_HERE} placeholder. Columns in SELECT MUST be in the SAME ORDER as selectedColumns
      "nosqlOperation": "..." // If NoSQL source needing temp table: JSON string query
      "selectedColumns": ["col1", "col2", "col3"] // Array defining column order - DDL, SQL, and this array MUST all match
    }
  ],
  "targetDdl": "CREATE TABLE ..." // Only if operationMode is "new_table", else null. MUST be a SINGLE CREATE TABLE statement ONLY — the execution engine already DROPs the target table before running this DDL, so do NOT prepend "DROP TABLE ...;" or include any other statement (a multi-statement string only has its FIRST statement executed, which would run the DROP and skip the CREATE),
  "joinSql": "INSERT INTO target_table SELECT ... FROM temp_xxx t1 JOIN existing_table t2 ...",
  "previewSql": "SELECT * FROM ${destinationConfig.tableName} LIMIT 100",
  "joinColumns": [{"table1": "col", "table2": "col"}],
  "selectedColumns": {"sourceNodeId1": ["col1"], "sourceNodeId2": ["col2"]}
}

CRITICAL REQUIREMENTS for DDL, SQL, and selectedColumns order:
1. selectedColumns MUST be an array of column names: ["col1", "col2", "col3"]
2. DDL column order MUST match selectedColumns order exactly: CREATE TABLE (col1 TYPE, col2 TYPE, col3 TYPE)
3. SQL SELECT column order MUST match selectedColumns order exactly: SELECT col1, col2, col3 FROM ...
4. All three (DDL columns, SQL SELECT columns, selectedColumns array) MUST be in the SAME ORDER
5. For NoSQL sources, selectedColumns defines the order fields will be extracted from documents
6. This ensures INSERT statements generated from selectedColumns will match the temp table structure
7. CRITICAL: ALL SQL SELECT statements in the "sql" field MUST end with the placeholder {LIMIT_OFFSET_HERE}
   - This placeholder will be replaced with database-specific pagination syntax (LIMIT/OFFSET, TOP, FETCH, etc.)
   - Example: "SELECT col1, col2 FROM table {LIMIT_OFFSET_HERE}"
   - Do NOT add your own LIMIT/OFFSET clauses - only use the placeholder
8. CRITICAL: "targetDdl" MUST contain a SINGLE statement: just the CREATE TABLE. The
   execution engine ALREADY drops the target table before running targetDdl, so do NOT
   prepend "DROP TABLE IF EXISTS ...;" and do NOT include any second statement. Only the
   FIRST statement of the string is executed — a leading DROP would run and the CREATE
   would be skipped, causing "no such table" when the join INSERT runs. Same for any
   per-source "ddl": a single CREATE TABLE statement, no DROP.

Example 1 (External SQL source + SQL source in destination):
{
  "explanation": "Join external customers with orders already in destination",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "tempTableName": "temp_node_abc_123",
      "ddl": "CREATE TABLE temp_node_abc_123 (customer_id INT, name VARCHAR(255));", // Note: DDL order matches selectedColumns
      "sql": "SELECT customer_id, name FROM customers {LIMIT_OFFSET_HERE}", // Note: SELECT order matches selectedColumns, ends with placeholder
      "selectedColumns": ["customer_id", "name"] // Note: All three (DDL, SQL, selectedColumns) have same order
    },
    {
      "sourceNodeId": "node-def-456"
      // No fields - orders table already exists in destination
    }
  ],
  "targetDdl": "CREATE TABLE customer_orders (customer_id INT, name VARCHAR(255), order_id INT);",
  "joinSql": "INSERT INTO customer_orders SELECT t1.customer_id, t1.name, t2.order_id FROM temp_node_abc_123 t1 INNER JOIN orders t2 ON t1.customer_id = t2.customer_id;",
  "previewSql": "SELECT * FROM customer_orders LIMIT 100;",
  "joinColumns": [{"temp_node_abc_123": "customer_id", "orders": "customer_id"}],
  "selectedColumns": {"node-abc-123": ["customer_id", "name"], "node-def-456": ["order_id"]}
}

Example 2 (NoSQL source needing temp table for SQL destination):
{
  "explanation": "Load MongoDB users into temp table, join with SQL orders",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "tempTableName": "temp_node_abc_123",
      "ddl": "CREATE TABLE temp_node_abc_123 (user_id INT, name VARCHAR(255));", // Note: DDL order matches selectedColumns
      "nosqlOperation": "{\\"collection\\": \\"users\\", \\"filter\\": {}}", // Note: Will extract user_id, name in that order
      "selectedColumns": ["user_id", "name"] // Note: Defines extraction and insertion order
    },
    {
      "sourceNodeId": "node-def-456",
      "tempTableName": "temp_node_def_456",
      "ddl": "CREATE TABLE temp_node_def_456 (order_id INT, user_id INT);", // Note: DDL order matches selectedColumns
      "sql": "SELECT order_id, user_id FROM orders {LIMIT_OFFSET_HERE}", // Note: SELECT order matches selectedColumns, ends with placeholder
      "selectedColumns": ["order_id", "user_id"] // Note: All three (DDL, SQL, selectedColumns) have same order
    }
  ],
  "targetDdl": "CREATE TABLE user_orders (user_id INT, name VARCHAR(255), order_id INT);",
  "joinSql": "INSERT INTO user_orders SELECT t1.user_id, t1.name, t2.order_id FROM temp_node_abc_123 t1 INNER JOIN temp_node_def_456 t2 ON t1.user_id = t2.user_id;",
  "previewSql": "SELECT * FROM user_orders LIMIT 100;",
  "joinColumns": [{"temp_node_abc_123": "user_id", "temp_node_def_456": "user_id"}],
  "selectedColumns": {"node-abc-123": ["user_id", "name"], "node-def-456": ["order_id"]}
}
`)}

User Request Context: "${joinSettings.userRequest}"

Based on the user's request and conversation history, determine:
1. How each source should be queried (SELECT statements for SQL, nosqlOperation for NoSQL)
2. Join relationships between table pairs (which columns match, and what join type for each pair)
3. Which columns to include in the final result (default to all if not specified)
4. The final join logic that combines all sources appropriately

Note: Each table pair can have different join types (e.g., Table A INNER JOIN Table B, result LEFT JOIN Table C).

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Only return the keys provided in this prompt, and put any explanation inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.
  `,

};

const ChatPrompts = {
  join: JoinPrompts
};

module.exports = ChatPrompts;
module.exports.default = ChatPrompts;
