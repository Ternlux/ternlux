/**
 * MySQL Connector Plugin for Ternlux
 * Handles all MySQL database operations
 */

const mysql = require('mysql2/promise');

// Connection pool cache
const connectionPools = new Map();

/**
 * Get or create connection pool
 */
function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port || 3306,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000,
    });

    connectionPools.set(key, pool);
  }

  return connectionPools.get(key);
}

module.exports = {
  type: 'connector',
  id: 'mysql',
  name: 'MySQL',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port || 3306,
        database: config.database,
        user: config.username,
        password: config.password,
        ssl: config.ssl ? {} : undefined,
        connectTimeout: 8000,
      });
      await conn.end();
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
      const pool = getPool(config, connectionId);
      const [rows] = await pool.execute(`
        SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
               TABLE_TYPE AS type
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME
      `, [config.database]);

      return {
        success: true,
        tables: rows
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get table columns
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      const pool = getPool(config, connectionId);
      const [rows] = await pool.execute(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
               IS_NULLABLE AS nullable,
               (COLUMN_KEY = 'PRI') AS isPrimary
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [schema, table]);

      return {
        success: true,
        columns: rows
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
      const pool = getPool(config, connectionId);
      // Extract SQL query from the query object
      const sqlQuery = queryObj.query;
      const [rows, fields] = await pool.execute(sqlQuery);
      const columns = fields ? fields.map(f => f.name) : [];

      return {
        success: true,
        rows,
        columns,
        rowCount: rows.length
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */

  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const pool = getPool(config, connectionId);
      const connection = await pool.getConnection();
  
      return new Promise((resolve, reject) => {
        let batch = [];
        let columns = null;
        let totalRows = 0;
  
        // 1. Drop down to the underlying callback-based connection
        const sqlQuery = connection.connection.query(query);
  
        // 2. Listen for fields on the query object itself
        sqlQuery.on('fields', (fields) => {
          columns = fields.map(f => f.name);
        });
  
        // 3. Create the stream
        const stream = sqlQuery.stream();
  
        stream.on('data', (row) => {
          batch.push(row);
  
          if (batch.length >= batchSize) {
            stream.pause();
            const currentBatch = batch;
            batch = [];
            totalRows += currentBatch.length;
  
            // Process batch asynchronously
            Promise.resolve(onBatch(currentBatch, columns))
              .then(() => stream.resume())
              .catch((err) => {
                stream.destroy();
                connection.release();
                reject(err);
              });
          }
        });
  
        stream.on('end', async () => {
          // Process remaining rows in batch
          if (batch.length > 0) {
            totalRows += batch.length;
            try {
              await onBatch(batch, columns);
            } catch (err) {
              connection.release();
              reject(err);
              return;
            }
          }
  
          connection.release();
          resolve({ success: true, totalRows });
        });
  
        stream.on('error', (err) => {
          connection.release();
          reject(err);
        });
      });
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection pool
   */
  closeConnection: async (connectionId) => {
    if (connectionPools.has(connectionId)) {
      const pool = connectionPools.get(connectionId);
      await pool.end();
      connectionPools.delete(connectionId);
    }
  },

  /**
   * Batch insert rows into a table (uses parameterized multi-row INSERT with transaction)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const pool = getPool(config, connectionId);
      const connection = await pool.getConnection();

      try {
        // Start transaction
        await connection.beginTransaction();

        // Build parameterized multi-row INSERT
        const valuePlaceholders = rows.map(() => `(${columns.map(() => '?').join(', ')})`);
        const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valuePlaceholders.join(', ')}`;

        // Flatten all values into a single array
        const allValues = rows.flatMap(row =>
          columns.map(col => {
            const val = row[col];
            if (val instanceof Date) return val;
            if (typeof val === 'object' && val !== null) return JSON.stringify(val);
            return val;
          })
        );

        await connection.execute(insertSql, allValues);

        // Commit transaction
        await connection.commit();
        connection.release();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await connection.rollback();
        connection.release();
        throw error;
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'host',
        type: 'string',
        label: 'Host',
        placeholder: 'localhost',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '3306',
        default: 3306,
        required: true,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'mydb',
        required: true,
        sensitive: false
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'root',
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
        name: 'ssl',
        type: 'boolean',
        label: 'Use SSL',
        default: false,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating MySQL transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a MySQL expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: MySQL
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local SQLite'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:
    Generate transformation SQL that:
    1. Creates a new table in MySQL with the transformed structure
    2. Populates it with transformed data using INSERT INTO ... SELECT

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement",
      "sql": "INSERT INTO statement with SELECT query",
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local SQLite Storage**:
    Generate SQL to fetch data from MySQL and save it locally to SQLite.

    **You must provide THREE separate SQL statements**:
    1. **DDL**: SQLite CREATE TABLE statement with appropriate SQLite data types
       - Use SQLite types: INTEGER, REAL, TEXT, BLOB
       - Column names must match the SELECT query output
    2. **SQL (SELECT)**: MySQL SELECT query to fetch and transform data from the source
       - This will be executed on MySQL database
       - Include all transformations (filtering, calculations, etc.)
    3. **INSERT**: SQLite INSERT statement to insert the fetched data
       - Use parameterized query with ? placeholders
       - Column order must match the SELECT query output exactly

    **SQLite Data Type Mapping**:
    - INTEGER: for whole numbers (int, bigint, auto_increment, etc.)
    - REAL: for floating point numbers (float, double, decimal)
    - TEXT: for strings (varchar, char, text, datetime, timestamp)
    - BLOB: for binary data

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "SQLite CREATE TABLE ${fullTableName.split('.').pop()} (...columns...)",
      "sql": "MySQL SELECT query to fetch transformed data",
      "insertSql": "SQLite table INSERT INTO ${fullTableName.split('.').pop()} (...columns...) VALUES (?, ?, ...)",
      "previewSql": "SQLite table SELECT * FROM ${fullTableName.split('.').pop()} LIMIT 100"
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "ddl": "CREATE TABLE customers_transformed (customer_id INTEGER, name TEXT, email TEXT, total_spending REAL)",
      "sql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM customers WHERE status = 'active'",
      "insertSql": "INSERT INTO customers_transformed (customer_id, name, email, total_spending) VALUES (?, ?, ?, ?)",
      "previewSql": "SELECT * FROM customers_transformed LIMIT 100"
    }`}

    Be specific and provide working SQL. Use MySQL-specific features where appropriate (e.g., AUTO_INCREMENT, JSON functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a MySQL expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: MySQL
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

    **ALTER TABLE Operations (MySQL)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [AFTER existing_column]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name (MySQL 8.0+)
    - CHANGE COLUMN: ALTER TABLE table_name CHANGE old_name new_name data_type (older MySQL versions)
    - MODIFY COLUMN: ALTER TABLE table_name MODIFY COLUMN column_name new_data_type

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
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
      "sql": "UPDATE ${fullTableName} SET archived = 1, archived_date = NOW() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **discount_rate** column after **total_amount**",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN discount_rate DECIMAL(5,2) DEFAULT 0.00 AFTER total_amount",
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

    Alter table (modify type):
    {
      "explanation": "Change **status** column from VARCHAR(20) to VARCHAR(50)",
      "ddl": "ALTER TABLE ${fullTableName} MODIFY COLUMN status VARCHAR(50)",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **total_price** column and calculate from quantity and unit price",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_price DECIMAL(10,2) DEFAULT 0.00",
      "sql": "UPDATE ${fullTableName} SET total_price = quantity * unit_price",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working MySQL SQL. Use MySQL-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for MySQL
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name (not used for MySQL)
   * @param {object} config - Database configuration containing database name
   * @returns {string} Properly quoted identifier
   */
  quoteIdentifier: (identifier, schema = null, config = null) => {
    if (!identifier) return identifier;

    const quotedIdentifier = `\`${identifier}\``;

    // For MySQL, use database name from config if available, otherwise use schema
    const databaseName = config?.database || schema;

    if (databaseName) {
      return `\`${databaseName}\`.${quotedIdentifier}`;
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
