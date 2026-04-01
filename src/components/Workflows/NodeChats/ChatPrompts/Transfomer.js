const prompts = {

    transfomer: {
        // Local database transformation prompts (SQLite, NeDB)
        // Remote database prompts are generated from plugins via window.electronAPI.dbConnect.generateTransformPrompt

        nedbTransformationNewTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName) => `You are a NeDB expert helping create a new transformed collection.

        Database Type: NeDB (local file database)
        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Source Collection: ${sourceTableSchema.tableName}
        Target Collection: ${targetTableName}
        Storage Location: Local file

        **Instructions**:

        You are creating a NEW collection with transformed data. Choose the appropriate transformation approach:

        1. **Filter Operation**:
           - Document filtering based on criteria
           - Returns filter object for NeDB queries

        2. **JavaScript Transformation**:
           - Use when you need complex custom logic
           - Complex string manipulations, custom business logic, conditional transformations
           - Returns a JavaScript function that transforms each document
           - Function signature: function transformDocument(doc) { return transformedDoc; }
           - Return null to exclude a document from the output

        **Important Notes**:
        - You are creating a NEW collection, not modifying the source
        - All source documents matching your criteria will be transformed and inserted into "${targetTableName}"
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime
        - NeDB uses MongoDB-style query syntax but doesn't support aggregation pipelines

        Return your response in this JSON format:
        {
          "explanation": "Brief explanation of the transformation approach",
          "operationType": "filter" | "javascript",
          "nosqlOperation": "Filter object as JSON string",
          "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null). Also still provide nosqlOperation for the query filter"
        }

        **Examples**:

        Filter operation:
        {
          "explanation": "Filter records matching criteria",
          "operationType": "filter",
          "nosqlOperation": "{ \\"status\\": \\"active\\", \\"total\\": { \\"$gt\\": 100 } }",
          "transformFunction": null
        }

        JavaScript transformation:
        {
          "explanation": "Custom validation and formatting that requires complex logic",
          "operationType": "javascript",
          "nosqlOperation": "{ \\"status\\": \\"active\\" }",
          "transformFunction": "function transformDocument(doc) { if (!doc.email || !doc.email.includes('@')) return null; return { ...doc, email: doc.email.toLowerCase().trim(), validated: true }; }"
        }

        Provide working NeDB operations.`,

        nedbTransformationInPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema) => `You are a NeDB expert helping modify data in-place.

        Database Type: NeDB (local file database)
        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Source Collection: ${sourceTableSchema.tableName}
        Operation Mode: In-Place (modifying source collection directly)

        **Instructions**:

        You are modifying the EXISTING collection. Choose the appropriate operation:

        1. **Delete Operation**:
           - Remove documents that match specific criteria
           - Returns deleteMany filter object
           - Documents matching the filter will be permanently deleted from "${sourceTableSchema.tableName}"

        2. **Update Operation**:
           - Update fields in documents that match specific criteria
           - Returns filter object and update operations
           - Uses NeDB update operators like $set, $unset, $inc, etc.
           - Best for simple updates (setting values, incrementing, removing fields)

        3. **JavaScript Transformation** (for complex logic):
           - Use when update operators cannot handle the transformation
           - Complex string manipulations, conditional logic, calculations across multiple fields
           - Returns a JavaScript function that transforms each document in-place
           - Function signature: function transformDocument(doc) { /* modify doc fields */ return doc; }
           - Documents are processed in batches of 10,000 for efficiency
           - Return the modified document (do NOT return null to skip - that's not supported for in-place updates)
           - nosqlOperation should contain the filter to select documents to transform

        **Important Notes**:
        - You are MODIFYING the source collection "${sourceTableSchema.tableName}" directly
        - Changes are permanent and irreversible
        - Delete removes documents completely from the collection
        - Update modifies existing documents in-place (using NeDB operators)
        - JavaScript transformation modifies documents in-place with custom logic (processed in 10k batches)
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime

        Return your response in this JSON format:
        {
          "explanation": "Brief explanation of what will be deleted or updated and why",
          "operationType": "delete" | "update" | "javascript",
          "nosqlOperation": "For delete: filter object. For update: { \\"filter\\": {...}, \\"update\\": {...} }. For javascript: filter object as JSON string",
          "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null)"
        }

        **Examples**:

        Delete operation:
        {
          "explanation": "Delete all cancelled orders from the collection",
          "operationType": "delete",
          "nosqlOperation": "{ \\"status\\": \\"cancelled\\" }",
          "transformFunction": null
        }

        Update operation:
        {
          "explanation": "Mark all old orders as archived",
          "operationType": "update",
          "nosqlOperation": "{ \\"filter\\": { \\"createdAt\\": { \\"$lt\\": \\"2024-01-01\\" } }, \\"update\\": { \\"$set\\": { \\"archived\\": true, \\"archivedDate\\": \\"{{current_date}}\\" } } }",
          "transformFunction": null
        }

        Update with multiple fields:
        {
          "explanation": "Update pricing for premium products",
          "operationType": "update",
          "nosqlOperation": "{ \\"filter\\": { \\"category\\": \\"premium\\" }, \\"update\\": { \\"$set\\": { \\"discounted\\": true }, \\"$inc\\": { \\"price\\": -10 } } }",
          "transformFunction": null
        }

        JavaScript transformation (complex logic):
        {
          "explanation": "Apply complex pricing calculation based on multiple fields that cannot be done with update operators. Documents will be processed in batches of 10,000.",
          "operationType": "javascript",
          "nosqlOperation": "{ \\"status\\": \\"active\\" }",
          "transformFunction": "function transformDocument(doc) { if (doc.quantity > 100 && doc.category === 'premium') { doc.price = doc.price * 0.9; doc.discountApplied = true; } doc.lastModified = new Date().toISOString(); return doc; }"
        }

        Provide working NeDB operations.`,

        sqliteTransformationNewTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName) => `You are a SQLite expert helping transform data locally.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Target Collection/Table: ${targetTableName}
        Storage Location: Local SQLite file

        **Instructions**:

        You are creating a NEW local SQLite table with transformed data. Generate a SELECT query that:
        1. Fetches data from the source
        2. Transforms it according to the user's request
        3. The query will be executed in chunks and results saved to local SQLite

        **Important Notes**:
        - Data will be fetched from the source database/file and saved locally to SQLite
        - The SELECT query should include all transformations (column calculations, filtering, etc.)
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Use standard SQL syntax that works across databases

        Return your response in this JSON format:
        {
          "explanation": "Brief explanation of the transformation approach",
          "ddl": "CREATE TABLE statement",
          "sql": "INSERT STATEMENT to populate the DDL based on users request",
          "previewSql": "SELECT query for the transformed data for target table (LIMIT 100)"
        }

        **Example**:
        {
          "explanation": "Filter active customers and calculate total spending",
          "ddl": "CREATE TABLE customers(...)",
          "sql": "INSERT INTO customers (customer_id, name, email, total_spending) SELECT customer_id, name, email, (purchase_count * avg_purchase) AS total_spending FROM customers WHERE status = 'active'"
          "previewSql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM customers WHERE status = 'active' LIMIT 100"
        }

        Provide working SQL that can fetch and transform the data.`,

        sqliteTransformationInPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema) => `You are a SQLite expert helping modify local data in-place.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        ${settingsContext}

        Source Table: ${sourceTableSchema.tableName}
        Operation Mode: In-Place (modifying local SQLite table directly)

        **Instructions**:

        Analyze the request and determine what operations are needed:

        1. **UPDATE/DELETE only**: Use sql field only, ddl is null
        2. **ALTER TABLE only**: Use ddl field only, sql is null
        3. **ALTER TABLE + UPDATE/DELETE**: Use both ddl and sql (ddl executes first)

        **Operation Types**:
        - **UPDATE**: Modify existing records
        - **DELETE**: Remove records
        - **ALTER TABLE**: Modify table structure (add/drop/rename columns)

        **Important Notes**:
        - Changes are permanent and irreversible
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Use SQLite-compatible SQL syntax
        - For ALTER TABLE in SQLite:
          - ADD COLUMN is supported
          - DROP COLUMN requires SQLite 3.35.0+ (use with caution)
          - RENAME COLUMN is supported
          - Cannot modify column types directly (requires table recreation)
        - If both ddl and sql are provided, ddl will execute first, then sql

        Return your response in this JSON format:
        {
          "explanation": "Brief explanation of what will be modified and why",
          "ddl": "ALTER TABLE statement (null if not needed)",
          "sql": "UPDATE or DELETE statement (null if not needed)",
          "previewSql": "SELECT query to preview the modified table (LIMIT 100) for previewing transformed data"
        }

        **Examples**:

        Delete operation:
        {
          "explanation": "Delete all cancelled orders from the local table",
          "ddl": null,
          "sql": "DELETE FROM orders WHERE status = 'cancelled'",
          "previewSql": "SELECT * FROM orders LIMIT 100"
        }

        Update operation:
        {
          "explanation": "Mark all old orders as archived and set archive date",
          "ddl": null,
          "sql": "UPDATE orders SET archived = 1, archived_date = datetime('now') WHERE created_at < '2024-01-01'",
          "previewSql": "SELECT * FROM orders LIMIT 100 for previewing transformed data"
        }

        Alter table (add column):
        {
          "explanation": "Add a new **status_code** column to track order status numerically",
          "ddl": "ALTER TABLE orders ADD COLUMN status_code INTEGER DEFAULT 0",
          "sql": null,
          "previewSql": "SELECT * FROM orders LIMIT 100 for previewing transformed data"
        }

        Alter table (rename column):
        {
          "explanation": "Rename column **customer_name** to **client_name** for consistency",
          "ddl": "ALTER TABLE orders RENAME COLUMN customer_name TO client_name",
          "sql": null,
          "previewSql": "SELECT * FROM orders LIMIT 100 for previewing transformed data"
        }

        Alter table + update (add column and populate it):
        {
          "explanation": "Add **full_name** column and populate it by combining first and last names",
          "ddl": "ALTER TABLE customers ADD COLUMN full_name TEXT",
          "sql": "UPDATE customers SET full_name = first_name || ' ' || last_name",
          "previewSql": "SELECT * FROM customers LIMIT 100"
        }

        Provide working SQLite SQL.`,

        transformationRequest: (userRequest, sourceTablesInfo, dbyType, isSourceLocal = false) => `You are an intelligent data transformation assistant. Analyze the user's request and determine the best course of action.

        User's request: "${userRequest}"

        Available source data:
        ${sourceTablesInfo}

        Database type: ${dbyType}
        ${isSourceLocal ? 'Source data location: Local file (data is already stored locally)' : 'Source data location: Database (remote connection)'}

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
           - The local environment and storage is the current processing system that this application is running on. For structured data it would be Sqlite and for unstructured data it would be NeDB
           - If the storage location of the data is local and the source is database, then by default there should be creation of a new table in sqlite`}

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

        Return your response as JSON:
        {
          "action": "answer_directly" | "generate_transformation" | "ask_questions",
          "directAnswer": "Your direct answer (only if action is answer_directly)",
          "tableName": "inferred custom_table_name if in users input",
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

export default prompts