// The table an in-place statement addresses. A caller may pass the name
// directly, or `{ nodeId }` for a file source — that case is staged under a
// per-node table by public/transfomers/DuckDB.js, and this is the one place
// the name is worked out so the prompt and the executor cannot disagree.
const DuckDB = require('../transfomers/DuckDB');

function resolveInPlaceTable(target, sourceTableSchema) {
  if (target && typeof target === 'object') {
    return DuckDB.stagingTableFor(target.nodeId, target.fallback || sourceTableSchema?.tableName);
  }
  return target || sourceTableSchema?.tableName;
}

const prompts = {

transfomer: {
        // Local transformation prompts. Remote database prompts are generated
        // from plugins via window.electronAPI.dbConnect.generateTransformPrompt

        // Local transformations run on DuckDB. The source is read where it sits
        // (a file, or an upstream node's table) and the result becomes this
        // node's own table in the workflow's database. New-table mode is a
        // SELECT that defines the result; in-place mode is the ALTER / UPDATE /
        // DELETE the user actually asked for, run against the existing table.
        duckdbTransformationNewTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName) => `You are a DuckDB expert transforming a local data file.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Source: ${sourceTableSchema.tableName}  (readable by that name)
        Target: ${targetTableName}  (a table in this workflow's DuckDB database)

        **Instructions**:

        Write ONE SELECT statement that reads from the source and produces the
        transformed result. The rows it returns become the target table — you do
        not write CREATE TABLE, and you do not write an INSERT.

        **Important Notes**:
        - Refer to the source by the name above, as if it were a table
        - Column types come from the file; DuckDB infers them, so you do not declare them
        - DuckDB speaks PostgreSQL-flavoured SQL, and adds conveniences worth using:
          SELECT * EXCLUDE (col), SELECT * REPLACE (expr AS col), QUALIFY, GROUP BY ALL
        - Nested values read as STRUCT/LIST — reach into them with dot notation (addr.city) or [1]
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} are replaced at runtime

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Put all explanatory prose inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.

        Return your response in exactly this JSON format:
        {
          "explanation": "Brief explanation of the transformation approach",
          "sql": "SELECT statement producing the transformed rows",
          "previewSql": "The same SELECT with LIMIT 100, for previewing"
        }

        **Examples**:

        Filter and derive a column:
        {
          "explanation": "Keep **active** customers and compute their total spending",
          "sql": "SELECT customer_id, name, email, purchase_count * avg_purchase AS total_spending FROM customers WHERE status = 'active'",
          "previewSql": "SELECT customer_id, name, email, purchase_count * avg_purchase AS total_spending FROM customers WHERE status = 'active' LIMIT 100"
        }

        Aggregate:
        {
          "explanation": "Revenue per city, highest first",
          "sql": "SELECT city, count(*) AS orders, round(sum(amount), 2) AS revenue FROM orders GROUP BY city ORDER BY revenue DESC",
          "previewSql": "SELECT city, count(*) AS orders, round(sum(amount), 2) AS revenue FROM orders GROUP BY city ORDER BY revenue DESC LIMIT 100"
        }

        Drop a column and rename another:
        {
          "explanation": "Remove the internal **raw_blob** column and rename **cust_nm**",
          "sql": "SELECT * EXCLUDE (raw_blob), cust_nm AS customer_name FROM orders",
          "previewSql": "SELECT * EXCLUDE (raw_blob), cust_nm AS customer_name FROM orders LIMIT 100"
        }

        Provide working DuckDB SQL.`,

        // `target` is what the statements must address. For a source that is
        // already a table it is that table's name; for a FILE it is the staging
        // table the executor materialises the file into, derived from the node
        // id so both sides agree — pass `{ nodeId }` and it is worked out here,
        // rather than each caller deriving it and risking a mismatch.
        duckdbTransformationInPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema, target) => `You are a DuckDB expert modifying a local table in place.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Table: ${resolveInPlaceTable(target, sourceTableSchema)}  (a real table — write statements against it by that name)
        Operation Mode: In-Place (the table is modified where it stands)

        **Instructions**:

        Write the statement — or statements — that make the change the user
        asked for. This is an ordinary DuckDB table, so say what you mean:

        - "delete the cancelled orders" -> DELETE FROM orders WHERE status = 'cancelled';
        - "add a full_name column"      -> ALTER TABLE customers ADD COLUMN full_name VARCHAR;
                                           UPDATE customers SET full_name = first_name || ' ' || last_name;
        - "normalise the emails"        -> UPDATE customers SET email = lower(trim(email));
        - "drop the notes column"       -> ALTER TABLE orders DROP COLUMN notes;
        - "rename cust_nm"              -> ALTER TABLE orders RENAME COLUMN cust_nm TO customer_name;

        Separate multiple statements with semicolons; they run together as one
        unit. Adding a column and populating it is the common two-statement
        case — ALTER first, then UPDATE.

        **Important Notes**:
        - Only what your statements touch changes. Columns and rows you don't
          mention are left exactly as they are
        - Refer to the table by the bare name above — do not qualify it with a
          database or schema
        - Do NOT write a SELECT: a query changes nothing, and the node would
          report success having done nothing at all
        - Do NOT write CREATE TABLE or INSERT — the table already exists
        - Changes are permanent; the previous contents are not kept
        - DuckDB speaks PostgreSQL-flavoured SQL
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} are replaced at runtime

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Put all explanatory prose inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.

        Return your response in exactly this JSON format:
        {
          "explanation": "Brief explanation of what will change and why",
          "sql": "The statement(s) to run, separated by semicolons",
          "previewSql": "A SELECT showing the table after the change, with LIMIT 100"
        }

        **Examples**:

        Remove rows:
        {
          "explanation": "Delete all **cancelled** orders",
          "sql": "DELETE FROM orders WHERE status = 'cancelled';",
          "previewSql": "SELECT * FROM orders LIMIT 100"
        }

        Add a derived column:
        {
          "explanation": "Add **full_name**, combining first and last names",
          "sql": "ALTER TABLE customers ADD COLUMN full_name VARCHAR; UPDATE customers SET full_name = first_name || ' ' || last_name;",
          "previewSql": "SELECT * FROM customers LIMIT 100"
        }

        Rewrite a column in place:
        {
          "explanation": "Normalise **email** to lowercase",
          "sql": "UPDATE customers SET email = lower(trim(email));",
          "previewSql": "SELECT email FROM customers LIMIT 100"
        }

        Provide working DuckDB SQL.`,

        transformationRequest: (userRequest, sourceTablesInfo, dbyType, isSourceLocal = false, availableSkills = []) => `You are an intelligent data transformation assistant. Analyze the user's request and determine the best course of action.

        User's request: "${userRequest}"

        Available source data:
        ${sourceTablesInfo}

        Database type: ${dbyType}
        ${isSourceLocal ? 'Source data location: Local file (data is already stored locally)' : 'Source data location: Database (remote connection)'}

        ${availableSkills.length > 0 ? `**Available Skills**:
You have access to these special transformation skills that can be used instead of standard SQL/NoSQL transformations:

${availableSkills.map(skill => `
**${skill.name}** (${skill.id}):
${skill.description.description}

Capabilities:
${skill.description.capabilities.map(cap => `- ${cap}`).join('\n')}

Use when:
- ${skill.description.description}

${skill.prompts ? skill.prompts.systemContext : ''}
`).join('\n')}

**IMPORTANT**: If a skill is better suited for the transformation than standard SQL/NoSQL, you can specify "usesSkill": true and "skillId": "<skill-id>" in your response.
` : ''}

        **Important**: You have access to the full chat history. Use it to understand:
        - If this is a follow-up request (refine/modify existing transformation)
        - If this is a new transformation request
        - If the user is asking a question about existing transformation
        - Previous transformation settings and SQL/code that was generated

        Your task is to analyze this request and determine:

        1. **Action Type**: What should happen next?
           - "answer_directly": The user is asking a question that doesn't require transformation (e.g., "what columns are available?", "explain the transformation")
           - "ask_questions": Need to ask clarifying questions to determine transformation settings (use questionsNeeded to specify clarifications)
           - "generate_transformation": If the instructions are clear and there are no follow up questions (questionsNeeded in JSON response) required to ask the user and transformation can be written

        2. **Inferred Settings**: Based on the request, what transformation settings can you determine based on users input? Do not infer settings unless specified by the users input.
           - operationMode: "new_table" (creating new dataset) or "in_place" (updating/deleting existing records) or null if unclear${isSourceLocal ? '' : `
           - storageLocation: "database" (store/process in database) or "local" (store/process locally) or null if unclear
           - **CONSTRAINT**: If storageLocation is inferred as "local", automatically set operationMode to "new_table" (cannot do in-place on remote database while storing locally)`}

        3. **Questions Needed**: Which settings are ambiguous and need clarification?
           - Return object of setting names that need to be answered by user that are not infered by the user already
           - Only include settings that are ambiguous based on the request and need to be determined for the type of transformation
           - For each setting that needs clarification, provide a question that would be relevant towards the users input
           - Do not infer anything about the output format or any additional steps outside the scope of the singular transformation step to update/delete/create from the source
           - Do not impose questions if they are already infered from the user input${isSourceLocal ? '' : `
           - "Local" storage means a file on this machine, queried with DuckDB. Tabular and document data are handled the same way — there is no separate store to choose
           - If the storage location of the data is local and the source is a database, then by default a new local dataset is created`}

           **Dynamic Question Logic**: The follow up questions should follow this logic if they are not answered already in users input
            - If an update statement is the direct choice and user hasn't provided input on if they want to update the source table or create a new temporary table for this update
            - For filtering/deleting records, do they want to do it in source table or create a new table with filtered data${isSourceLocal ? '' : `
            - For in place transformations, the storage location (storageLocation) would be the database
            - If a transformation needs to create a new table, where should the data be stored: in the database or locally
            - **IMPORTANT**: If storageLocation is "local", then operationMode MUST always be "new_table" (database-to-local transformations cannot be in-place)`}

        4. tableName: custom output table/collection name if user specifies one (e.g., "save to customer_data", "create orders_2024 table"), or null to use default


        Examples:
        - Request: "What columns are in the orders table?" → answer_directly
        - Request: "I want to transform the data" → answer_directly (ask the user to provide the logic they want)${isSourceLocal ? `
        - Request: "Can you update column A in the table directly?" → generate_transformation (operationMode: in_place)
        - Request: "Create a new table with filtered customers" → ask_questions (clear: operationMode is new_table)` : `
        - Request: "Can you update column A in the table directly?" → generate_transformation (operationMode: in_place, storageLocation: database)
        - Request: "Create a new table with filtered customers" → ask_questions (clear: operationMode is new_table, but unclear: storage location)
        - Request: "Save filtered customers locally" → generate_transformation (operationMode: new_table, storageLocation: local - ALWAYS new_table for local storage)`}

        Notes:
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime
        - current application execution plan injects $out into statement and takes care of deleting collection if it needs to be replaced for new_table
        - Do not include any additional keys in the response

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, explanation, or corrected SQL before or after the object. If you need to explain something to the user, answer a question, or correct/diagnose SQL, put that text inside the "directAnswer" field and set "action" to "answer_directly" — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.

        Return your response as JSON:
        {
          "action": "answer_directly" | "generate_transformation" | "ask_questions",
          "directAnswer": "Your direct answer (only if action is answer_directly)",
          "tableName": "inferred custom_table_name if in users input",
          "usesSkill": false | true,
          "skillId": "skill-id-here (only if usesSkill is true)",
          "skillExplanation": "Brief explanation of why this skill is being used (only if usesSkill is true)",
          "inferredSettings": {
            "operationMode": "new_table" | "in_place" | null${isSourceLocal ? '' : `,
            "storageLocation": "database" | "local" | null`}
          },
          "questionsNeeded": {
            "operationMode": "If the operation type is not infered by the users input then provide context-specific question about operation mode based on user request else don't include this key"${isSourceLocal ? '' : `,
            "storageLocation": "If the storage is not infered by users input then provide context-specific question about storage location based on user request else don't include this key"`}
          }
        }

        Only ask questions that are truly needed.`
    }
}

module.exports = prompts;
module.exports.default = prompts;