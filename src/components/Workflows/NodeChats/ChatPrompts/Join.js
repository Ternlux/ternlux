/** 
 * Chat Prompts for Join Node Configuration
 * Handles intelligent join analysis and query generation
 */

const JoinPrompts = {
  /**
   * Analyze join request to determine configuration needs
   */
  joinAnalysisRequest: (userRequest, sourcesInfo, availableDestinations, operationMode) => `
You are an expert data engineer helping configure a join operation between multiple data sources.

Current User Request: "${userRequest}"

Available Sources:
${sourcesInfo}

Available Destinations:
${availableDestinations}

${operationMode === 'new_table' ? 'Operation Mode: NEW TABLE (creating a new table/collection)\n' : ''}

Analyze the user's request and conversation history to determine the next steps. Return JSON with the following structure:
{
  "action": "answer_directly" | "ask_questions" | "generate_join",
  "inferredSettings": {
    "destinationSelection": "connection_id or local-sqlite or local-nedb" (optional),
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

Return ONLY valid JSON, no additional text.
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
- Table: ${src.tableName}
- Source Type: ${src.dbType || 'unknown'}
- In Destination DB: ${src.isInDestinationDb ? 'Yes (no temp table needed)' : 'No (needs temp table)'}
- Required Fields: ${src.requiredFields.length > 0 ? src.requiredFields.join(', ') : 'None (reference existing table directly in joinSql)'}
`).join('')}

Output Structure:
${dbType === 'mongodb' || dbType === 'nedb' ? `
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
  "targetDdl": "CREATE TABLE ..." // Only if operationMode is "new_table", else null,
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
`}

User Request Context: "${joinSettings.userRequest}"

Based on the user's request and conversation history, determine:
1. How each source should be queried (SELECT statements for SQL, nosqlOperation for NoSQL)
2. Join relationships between table pairs (which columns match, and what join type for each pair)
3. Which columns to include in the final result (default to all if not specified)
4. The final join logic that combines all sources appropriately

Note: Each table pair can have different join types (e.g., Table A INNER JOIN Table B, result LEFT JOIN Table C).

Return ONLY valid JSON, no additional text. Only return the keys provided in this prompt.
  `,

};

const ChatPrompts = {
  join: JoinPrompts
};

export default ChatPrompts;
