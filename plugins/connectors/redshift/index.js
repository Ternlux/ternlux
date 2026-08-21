/**
 * Amazon Redshift Connector Plugin for Ternlux
 * Handles all Redshift database operations
 */

const { Pool } = require('pg');

// Connection pool cache
const connectionPools = new Map();

/**
 * Get or create connection pool
 */
function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    // Parse host to remove JDBC protocol prefix if present
    let host = config.host;
    let port = config.port || 5439;

    // Handle JDBC URL format: jdbc:redshift://hostname:port/database
    if (host && host.includes('jdbc:redshift://')) {
      const urlMatch = host.match(/jdbc:redshift:\/\/([^:\/]+)(?::(\d+))?/);
      if (urlMatch) {
        host = urlMatch[1]; // Extract hostname
        if (urlMatch[2]) {
          port = parseInt(urlMatch[2], 10); // Extract port if present
        }
      }
    }

    const pool = new Pool({
      host: host,
      port: port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    connectionPools.set(key, pool);
  }

  return connectionPools.get(key);
}

module.exports = {
  type: 'connector',
  id: 'redshift',
  name: 'Amazon Redshift',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const pool = getPool(config, connectionId);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
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
      const result = await pool.query(`
        SELECT
          schemaname as schema,
          tablename as name,
          'table' as type
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
        UNION ALL
        SELECT
          schemaname as schema,
          viewname as name,
          'view' as type
        FROM pg_views
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
        ORDER BY schema, name
      `);

      return {
        success: true,
        tables: result.rows.map(row => ({
          schema: row.schema,
          name: row.name,
          type: row.type
        }))
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
      const result = await pool.query(`
        SELECT
          column_name AS name,
          data_type AS type,
          is_nullable AS nullable,
          column_default AS default_value
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table]);

      return {
        success: true,
        columns: result.rows.map(row => ({
          name: row.name,
          type: row.type,
          nullable: row.nullable === 'YES',
          isPrimary: false, // Redshift doesn't enforce primary keys
          defaultValue: row.default_value
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Run SQL query
   */
  /**
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows.
   *
   * The cap is applied through a cursor, so the SQL the user wrote is the SQL
   * Postgres runs — no LIMIT is appended and no subquery is wrapped around it.
   * A cursor reads a bounded number of rows and the rest of the result is never
   * materialised on either side of the wire.
   *
   * The statement runs exactly ONCE on every path. A cursor that fails is
   * reported as a failure rather than retried unwrapped: re-running an
   * arbitrary statement to work around a read problem is how an INSERT ends up
   * applied twice.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    const pool = getPool(config, connectionId);
    const sqlQuery = queryObj.query;
    const maxRows = Number(options.maxRows);

    if (!(maxRows > 0)) {
      try {
        const result = await pool.query(sqlQuery);
        return {
          success: true,
          rows: result.rows,
          columns: result.fields ? result.fields.map(f => f.name) : [],
          rowCount: result.rowCount
        };
      } catch (error) {
        return { success: false, message: error.message };
      }
    }

    const Cursor = require('pg-cursor');
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      return { success: false, message: error.message };
    }

    return new Promise((resolve) => {
      let cursor;
      try {
        cursor = client.query(new Cursor(sqlQuery));
      } catch (error) {
        client.release();
        resolve({ success: false, message: error.message });
        return;
      }
      // One past the cap, so "is there more?" is observed rather than assumed.
      cursor.read(maxRows + 1, (err, rows, result) => {
        cursor.close(() => client.release());
        if (err) {
          resolve({ success: false, message: err.message });
          return;
        }
        const all = rows || [];
        const capped = all.slice(0, maxRows);
        const fields = (result && result.fields) || [];
        resolve({
          success: true,
          rows: capped,
          columns: fields.length
            ? fields.map(f => f.name)
            : Object.keys(capped[0] || {}),
          // A statement that returns no rows (DDL, or an UPDATE without
          // RETURNING) completes through the same path with an empty array —
          // its command tag is the only count there is, so report that.
          rowCount: capped.length || (result && result.rowCount) || 0,
          truncated: all.length > maxRows,
        });
      });
    });
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const Cursor = require('pg-cursor');
      const pool = getPool(config, connectionId);
      const client = await pool.connect();

      return new Promise((resolve, reject) => {
        const cursor = client.query(new Cursor(query));
        let columns = null;
        let totalRows = 0;

        const readBatch = () => {
          cursor.read(batchSize, async (err, rows) => {
            if (err) {
              cursor.close(() => client.release());
              reject(err);
              return;
            }

            if (rows.length === 0) {
              // No more rows
              cursor.close(() => client.release());
              resolve({ success: true, totalRows });
              return;
            }

            // Extract column names from first batch
            if (!columns && rows.length > 0) {
              columns = Object.keys(rows[0]);
            }

            totalRows += rows.length;

            try {
              // Call onBatch and wait for it to complete
              await onBatch(rows, columns);
              // Continue reading next batch
              readBatch();
            } catch (batchError) {
              cursor.close(() => client.release());
              reject(batchError);
            }
          });
        };

        readBatch();
      });
    } catch (error) {
      return { success: false, message: error.message };
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

      const pool = await getPool(config, connectionId);
      const client = await pool.connect();

      try {
        // Start transaction
        await client.query('BEGIN');

        // Build parameterized multi-row INSERT
        const valuePlaceholders = rows.map((_, rowIndex) => {
          const rowPlaceholders = columns.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`);
          return `(${rowPlaceholders.join(', ')})`;
        });

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

        await client.query(insertSql, allValues);

        // Commit transaction
        await client.query('COMMIT');
        client.release();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await client.query('ROLLBACK');
        client.release();
        throw error;
      }
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
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'host',
        type: 'string',
        label: 'Cluster Endpoint',
        placeholder: 'my-cluster.abc123.us-east-1.redshift.amazonaws.com',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '5439',
        default: 5439,
        required: true,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'dev',
        required: true,
        sensitive: false
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'awsuser',
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
        name: 'schema',
        type: 'string',
        label: 'Schema',
        placeholder: 'public',
        default: 'public',
        required: false,
        sensitive: false
      },
      {
        name: 'ssl',
        type: 'boolean',
        label: 'Use SSL',
        default: true,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating Redshift transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are an Amazon Redshift expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Amazon Redshift
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local SQLite'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:
    Generate transformation SQL that:
    1. Creates a new table in Redshift with the transformed structure
    2. Populates it with transformed data using INSERT INTO ... SELECT

    **Redshift-Specific Considerations**:
    - Use appropriate distribution keys (DISTKEY) for large tables
    - Use sort keys (SORTKEY) for frequently filtered columns
    - Use ENCODE to specify column compression
    - Consider DISTSTYLE (AUTO, EVEN, KEY, ALL) based on table size and usage

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement with Redshift optimizations (DISTKEY, SORTKEY, ENCODE)",
      "sql": "INSERT INTO statement with SELECT query",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local SQLite Storage**:
    Generate SQL to fetch data from Redshift and save it locally to SQLite.

    **You must provide THREE separate SQL statements**:
    1. **DDL**: SQLite CREATE TABLE statement with appropriate SQLite data types
       - Use SQLite types: INTEGER, REAL, TEXT, BLOB
       - Column names must match the SELECT query output
    2. **SQL (SELECT)**: Redshift SELECT query to fetch and transform data from the source
       - This will be executed on Redshift database
       - Include all transformations (filtering, calculations, etc.)
    3. **INSERT**: SQLite INSERT statement to insert the fetched data
       - Use parameterized query with ? placeholders
       - Column order must match the SELECT query output exactly

    **SQLite Data Type Mapping**:
    - INTEGER: for whole numbers (int, bigint, smallint)
    - REAL: for floating point numbers (float, double precision, decimal, numeric)
    - TEXT: for strings (varchar, char, text, date, timestamp)
    - BLOB: for binary data

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "SQLite CREATE TABLE ${fullTableName.split('.').pop()} (...columns...)",
      "sql": "Redshift SELECT query to fetch transformed data",
      "insertSql": "SQLite INSERT INTO ${fullTableName.split('.').pop()} (...columns...) VALUES (?, ?, ...)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SQLite SELECT * FROM ${fullTableName.split('.').pop()} LIMIT 100"
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "ddl": "CREATE TABLE customers_transformed (customer_id INTEGER, name TEXT, email TEXT, total_spending REAL)",
      "sql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM public.customers WHERE status = 'active'",
      "insertSql": "INSERT INTO customers_transformed (customer_id, name, email, total_spending) VALUES (?, ?, ?, ?)",
      "targetColumns": [{"name": "customer_id", "type": "INTEGER"}, {"name": "name", "type": "TEXT"}, {"name": "email", "type": "TEXT"}, {"name": "total_spending", "type": "REAL"}],
      "previewSql": "SELECT * FROM customers_transformed LIMIT 100"
    }`}

    Be specific and provide working SQL. Use Redshift-specific features where appropriate (e.g., DISTKEY, SORTKEY, window functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are an Amazon Redshift expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Amazon Redshift
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

    **ALTER TABLE Operations (Redshift)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [ENCODE encoding]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME TABLE: ALTER TABLE table_name RENAME TO new_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name

    **Important Redshift Limitations**:
    - Redshift does NOT support ALTER COLUMN TYPE directly
    - To change column type, you must: 1) Add new column with new type, 2) Copy data with type conversion, 3) Drop old column, 4) Rename new column
    - Redshift does NOT support SET DEFAULT or SET NOT NULL on existing columns

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
    - Ensure string literals are properly escaped for Redshift.
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - If both ddl and sql are provided, ddl will execute first, then sql

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "ALTER TABLE statement (null if not needed)",
      "sql": "UPDATE or DELETE statement (null if not needed)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // the table columns AFTER the change, or "*" if the shape is unchanged (plain UPDATE / DELETE)
      "previewSql": "SELECT query to preview the modified table (LIMIT 100)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders",
      "ddl": null,
      "sql": "DELETE FROM ${fullTableName} WHERE status = 'cancelled'",
      "targetColumns": "*",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Update operation:
    {
      "explanation": "Mark old orders as archived",
      "ddl": null,
      "sql": "UPDATE ${fullTableName} SET archived = true, archived_date = CURRENT_TIMESTAMP WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **total_amount** column to track order totals",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount DECIMAL(10,2) DEFAULT 0.00 ENCODE LZO",
      "sql": null,
      "targetColumns": [{"name": "order_id", "type": "INT"}, {"name": "total_amount", "type": "DECIMAL(10,2)"}, {"name": "discount_rate", "type": "DECIMAL(5,2)"}],   // ALL columns the table now has, not just the new one
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (rename column):
    {
      "explanation": "Rename **customer_name** to **client_name**",
      "ddl": "ALTER TABLE ${fullTableName} RENAME COLUMN customer_name TO client_name",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name VARCHAR(200) ENCODE LZO",
      "sql": "UPDATE ${fullTableName} SET full_name = first_name || ' ' || last_name",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working Redshift SQL. Use Redshift-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for Redshift
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for Redshift)
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
  },

  /**
   * Data Explorer dialect. Read by public/database/dialect.js — keyword and
   * function lists are unioned with the shared ANSI baseline, so only what is
   * distinctly Redshift belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'Redshift',
    formatter: 'redshift',
    // runQuery honours { maxRows } via a cursor — see the note there.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    quote: '"',
    keywords: [
      'ILIKE', 'DISTKEY', 'SORTKEY', 'DISTSTYLE', 'ENCODE', 'COPY', 'UNLOAD',
      'VACUUM', 'ANALYZE', 'CREDENTIALS', 'IAM_ROLE', 'INTERLEAVED',
      'COMPUPDATE', 'STATUPDATE', 'LATE BINDING', 'EXTERNAL TABLE', 'SPECTRUM',
    ],
    functions: [
      'LISTAGG', 'DATE_TRUNC', 'DATEADD', 'DATEDIFF', 'GETDATE', 'CONVERT_TIMEZONE',
      'NVL', 'NVL2', 'DECODE', 'SPLIT_PART', 'REGEXP_REPLACE', 'REGEXP_SUBSTR',
      'JSON_EXTRACT_PATH_TEXT', 'JSON_ARRAY_LENGTH', 'APPROXIMATE COUNT',
      'PERCENTILE_CONT', 'MEDIAN', 'RATIO_TO_REPORT',
    ],
  }
};
