/**
 * Snowflake Connector Plugin for DagFlux
 * Handles all Snowflake database operations
 */

const snowflake = require('snowflake-sdk');

// Connection cache
const connections = new Map();

/**
 * Get or create Snowflake connection
 */
function getConnection(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connections.has(key)) {
    const connection = snowflake.createConnection({
      account: config.account,
      username: config.username,
      password: config.password,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema || 'PUBLIC',
      role: config.role,
    });

    connections.set(key, { connection, connected: false });
  }

  return connections.get(key);
}

/**
 * Connect to Snowflake if not already connected (async wrapper)
 */
async function ensureConnected(connectionObj) {
  if (connectionObj.connected) {
    return connectionObj.connection;
  }

  return new Promise((resolve, reject) => {
    connectionObj.connection.connect((err, conn) => {
      if (err) {
        reject(err);
      } else {
        connectionObj.connected = true;
        resolve(conn);
      }
    });
  });
}

/**
 * Execute query (async wrapper)
 */
function executeAsync(connection, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sqlText,
      binds: binds,
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve({ stmt, rows });
        }
      }
    });
  });
}

module.exports = {
  type: 'connector',
  id: 'snowflake',
  name: 'Snowflake',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);
      await executeAsync(connection, 'SELECT 1');
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get list of tables
   */
  getTables: async (config, connectionId = null) => {
    try {
      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);
      const database = config.database;
      const schema = config.schema || 'PUBLIC';

      const { rows } = await executeAsync(connection, `
        SELECT
          table_schema as schema,
          table_name as name,
          table_type as type
        FROM "${database}".INFORMATION_SCHEMA.TABLES
        ORDER BY table_schema, table_name
      `, []);

      return {
        success: true,
        tables: rows.map(row => ({
          schema: row.SCHEMA,
          name: row.NAME,
          type: row.TYPE === 'BASE TABLE' ? 'table' : 'view'
        }))
      };
    } catch (error) {
      console.log('getTables_error: ', error)
      return { success: false, message: error.message };
    }
  },

  /**
   * Get table columns
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);

      const database = config.database;
      const targetSchema = schema || config.schema || 'PUBLIC';

      const { rows } = await executeAsync(connection, `
        SELECT
          column_name AS name,
          data_type AS type,
          is_nullable AS nullable,
          column_default AS default_value
        FROM "${database}".INFORMATION_SCHEMA.COLUMNS
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position
      `, [targetSchema, table]);

      return {
        success: true,
        columns: rows.map(row => ({
          name: row.NAME,
          type: row.TYPE,
          nullable: row.NULLABLE === 'YES',
          isPrimary: false, // Snowflake doesn't enforce primary keys by default
          defaultValue: row.DEFAULT_VALUE
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Run SQL query
   */
  runQuery: async (config, connectionId, queryObj) => {
    try {
      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);
      // Extract SQL query from the query object
      const sqlQuery = queryObj.query;
      // console.log('sqlQuery: ', sqlQuery)
      const { stmt, rows } = await executeAsync(connection, sqlQuery);

      // Extract column names from statement metadata
      const columns = stmt.getColumns().map(col => col.getName());
      // console.log('connection, query: ', stmt.getColumns().map(col => col.getName()), rows, sqlQuery)

      return {
        success: true,
        rows: rows,
        columns: columns,
        rowCount: rows.length
      };
    } catch (error) {
      console.log('error: ', error)
      return { success: false, message: error.message };
    }
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);

      return new Promise((resolve, reject) => {
        let columns = null;
        let totalRows = 0;
        let buffer = [];

        connection.execute({
          sqlText: query,
          streamResult: true,
          complete: (err, stmt, rows) => {
            if (err) {
              reject(err);
              return;
            }

            // Extract column names
            columns = stmt.getColumns().map(col => col.getName());

            const stream = stmt.streamRows();

            stream.on('data', async (row) => {
              buffer.push(row);

              // When buffer reaches batch size, process it
              if (buffer.length >= batchSize) {
                const batchToProcess = buffer;
                buffer = [];
                totalRows += batchToProcess.length;

                try {
                  await onBatch(batchToProcess, columns);
                } catch (error) {
                  stream.destroy();
                  reject(error);
                }
              }
            });

            stream.on('end', async () => {
              // Process remaining rows in buffer
              if (buffer.length > 0) {
                totalRows += buffer.length;
                try {
                  await onBatch(buffer, columns);
                } catch (error) {
                  reject(error);
                  return;
                }
              }
              resolve({ success: true, totalRows });
            });

            stream.on('error', (error) => {
              reject(error);
            });
          }
        });
      });
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Batch insert rows into a table (uses multi-row INSERT with transaction)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const connectionObj = getConnection(config, connectionId);
      const connection = await ensureConnected(connectionObj);

      // Start transaction
      await executeAsync(connection, 'BEGIN TRANSACTION');

      try {
        // Format values for Snowflake multi-row insert
        const valueRows = rows.map(row => {
          const values = columns.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return val;
          });
          return `(${values.join(', ')})`;
        });

        // Use multi-row INSERT syntax
        const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valueRows.join(', ')}`;
        await executeAsync(connection, insertSql);

        // Commit transaction
        await executeAsync(connection, 'COMMIT');

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await executeAsync(connection, 'ROLLBACK');
        throw error;
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection
   */
  closeConnection: async (connectionId) => {
    if (connections.has(connectionId)) {
      const connectionObj = connections.get(connectionId);
      return new Promise((resolve) => {
        connectionObj.connection.destroy((err) => {
          connections.delete(connectionId);
          resolve();
        });
      });
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'account',
        type: 'string',
        label: 'Account',
        placeholder: 'xy12345.us-east-1',
        required: true,
        sensitive: true
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'myuser',
        required: true,
        sensitive: true
      },
      {
        name: 'password',
        type: 'password',
        label: 'Password',
        required: true,
        sensitive: true
      },
      {
        name: 'warehouse',
        type: 'string',
        label: 'Warehouse',
        placeholder: 'COMPUTE_WH',
        required: true,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'MYDB',
        required: true,
        sensitive: false
      },
      {
        name: 'schema',
        type: 'string',
        label: 'Schema',
        placeholder: 'PUBLIC',
        default: 'PUBLIC',
        required: false,
        sensitive: false
      },
      {
        name: 'role',
        type: 'string',
        label: 'Role',
        placeholder: 'ACCOUNTADMIN',
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating Snowflake transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Snowflake expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Snowflake
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local SQLite'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:
    Generate transformation SQL that:
    1. Creates a new table in Snowflake with the transformed structure
    2. Populates it with transformed data using CREATE OR REPLACE TABLE ... AS SELECT

    **Snowflake-Specific Considerations**:
    - Use clustering keys for frequently filtered columns (CLUSTER BY)
    - Consider table types (TRANSIENT, TEMPORARY) for staging
    - Snowflake supports VARIANT for semi-structured data (JSON, AVRO, PARQUET)
    - Use appropriate data types (NUMBER, FLOAT, VARCHAR, BOOLEAN, DATE, TIMESTAMP_NTZ, etc.)
    - Identifiers are case-insensitive unless quoted

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE OR REPLACE TABLE statement with Snowflake optimizations",
      "sql": "The SELECT query is part of the CREATE TABLE AS SELECT statement in ddl field (leave sql as empty string)",
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local SQLite Storage**:
    Generate SQL to fetch data from Snowflake and save it locally to SQLite.

    **You must provide THREE separate SQL statements**:
    1. **DDL**: SQLite CREATE TABLE statement with appropriate SQLite data types
       - Use SQLite types: INTEGER, REAL, TEXT, BLOB
       - Column names must match the SELECT query output
    2. **SQL (SELECT)**: Snowflake SELECT query to fetch and transform data from the source
       - This will be executed on Snowflake database
       - Include all transformations (filtering, calculations, etc.)
    3. **INSERT**: SQLite INSERT statement to insert the fetched data
       - Use parameterized query with ? placeholders
       - Column order must match the SELECT query output exactly

    **SQLite Data Type Mapping**:
    - INTEGER: for whole numbers (NUMBER with 0 decimal places, BOOLEAN as 0/1)
    - REAL: for floating point numbers (NUMBER, FLOAT, DOUBLE)
    - TEXT: for strings (VARCHAR, CHAR, STRING, DATE, TIMESTAMP, TIME)
    - BLOB: for binary data (BINARY, VARBINARY)

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "SQLite CREATE TABLE ${fullTableName.split('.').pop()} (...columns...)",
      "sql": "Snowflake SELECT query to fetch transformed data",
      "insertSql": "SQLite INSERT INTO ${fullTableName.split('.').pop()} (...columns...) VALUES (?, ?, ...)",
      "previewSql": "SQLite SELECT * FROM ${fullTableName.split('.').pop()} LIMIT 100"
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "ddl": "CREATE TABLE customers_transformed (customer_id INTEGER, name TEXT, email TEXT, total_spending REAL)",
      "sql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM PUBLIC.CUSTOMERS WHERE status = 'active'",
      "insertSql": "INSERT INTO customers_transformed (customer_id, name, email, total_spending) VALUES (?, ?, ?, ?)",
      "previewSql": "SELECT * FROM customers_transformed LIMIT 100"
    }`}

    Be specific and provide working SQL. Use Snowflake-specific features where appropriate (e.g., VARIANT, semi-structured data functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Snowflake expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Snowflake
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}

    Analyze the request and determine what operations are needed:

    1. **UPDATE/DELETE only**: Use sql field only, ddl is null
    2. **ALTER TABLE only**: Use ddl field only, sql is null
    3. **ALTER TABLE + UPDATE/DELETE**: Use both ddl and sql (ddl executes first)

    **Logic Rules**:
    1. Use UPDATE if the user wants to change values within existing rows.
    2. Use DELETE if the user wants to remove records.
    3. Use ALTER TABLE if the user wants to modify table structure (add/drop/rename columns, change types).
    4. **Filtering Intent**: If the user's request is to "keep only," "get only," or "filter for" certain records, you must DELETE all records that do NOT meet that criteria (e.g., DELETE FROM table WHERE column != 'value').

    **ALTER TABLE Operations (Snowflake)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [COMMENT 'description']
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name
    - ALTER COLUMN TYPE: ALTER TABLE table_name ALTER COLUMN column_name SET DATA TYPE new_type
    - SET DEFAULT: ALTER TABLE table_name ALTER COLUMN column_name SET DEFAULT value
    - DROP DEFAULT: ALTER TABLE table_name ALTER COLUMN column_name DROP DEFAULT
    - SET NOT NULL: ALTER TABLE table_name ALTER COLUMN column_name SET NOT NULL
    - DROP NOT NULL: ALTER TABLE table_name ALTER COLUMN column_name DROP NOT NULL

    **Important Snowflake Notes**:
    - Identifiers are case-insensitive unless quoted
    - Use double quotes for case-sensitive identifiers
    - String literals use single quotes
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - If both ddl and sql are provided, ddl will execute first, then sql

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "ALTER TABLE statement (null if not needed)",
      "sql": "UPDATE or DELETE statement (null if not needed)",
      "previewSql": "SELECT query to preview the modified table (LIMIT 100)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders",
      "ddl": null,
      "sql": "DELETE FROM ${fullTableName} WHERE status = 'cancelled'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Update operation:
    {
      "explanation": "Mark old orders as archived",
      "ddl": null,
      "sql": "UPDATE ${fullTableName} SET archived = true, archived_date = CURRENT_TIMESTAMP() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **total_amount** column to track order totals",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount NUMBER(10,2) DEFAULT 0.00 COMMENT 'Total order amount'",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (rename column):
    {
      "explanation": "Rename **customer_name** to **client_name**",
      "ddl": "ALTER TABLE ${fullTableName} RENAME COLUMN customer_name TO client_name",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (change type):
    {
      "explanation": "Change **status_code** from NUMBER to VARCHAR",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status_code SET DATA TYPE VARCHAR(10)",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name VARCHAR(200)",
      "sql": "UPDATE ${fullTableName} SET full_name = first_name || ' ' || last_name",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working Snowflake SQL. Use Snowflake-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for Snowflake
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for Snowflake)
   * @returns {string} Properly quoted identifier
   */
  quoteIdentifier: (identifier, schema = null, config = null) => {
    if (!identifier) return identifier;

    const quotedIdentifier = `"${identifier}"`;

    if (schema) {
      return `"${schema}".${quotedIdentifier}`;
    }

    return quotedIdentifier;
  },

  /**
   * Generate preview SQL query with database-specific syntax
   * @param {string} tableName - Table name (can be pre-quoted)
   * @param {number} limit - Number of rows to return (default 100)
   * @returns {string} Preview SQL query
   */
  getPreviewQuery: (tableName, limit = 100) => {
    return `SELECT * FROM ${tableName} LIMIT ${limit}`;
  }
};
