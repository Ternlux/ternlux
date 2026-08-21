/**
 * Microsoft SQL Server Connector Plugin for Ternlux
 * Handles all SQL Server database operations
 */

const mssql = require('mssql');

// Connection pool cache
const connectionPools = new Map();

/**
 * Get or create connection pool
 */
async function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    const poolConfig = {
      server: config.host,
      port: config.port || 1433,
      database: config.database,
      user: config.username,
      password: config.password,
      options: {
        encrypt: config.ssl || false,
        trustServerCertificate: true,
        instanceName: config.instanceName || undefined,
        connectTimeout: 10000,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };

    const pool = await mssql.connect(poolConfig);
    connectionPools.set(key, pool);
  }

  return connectionPools.get(key);
}

/**
 * Quote a SQL Server identifier (table / schema name).
 *
 * A dotted name passed as a single string ("dbo.test_values") with no explicit
 * schema is treated as a multi-part schema.table name and EACH part is bracketed
 * → [dbo].[test_values]. The previous behaviour wrapped the whole string in one
 * bracket pair → [dbo.test_values], i.e. a table whose name literally contains a
 * dot — which then mismatched the unbracketed `INSERT INTO dbo.test_values`
 * (parsed by SQL Server as schema dbo / table test_values) and surfaced as
 * "Invalid object name 'dbo.test_values'".
 */
function quoteSqlServerIdentifier(identifier, schema = null) {
  if (!identifier) return identifier;
  if (typeof identifier === 'string' && identifier.startsWith('[')) return identifier;

  if (schema) {
    return `[${schema}].[${identifier}]`;
  }
  if (typeof identifier === 'string' && identifier.includes('.')) {
    return identifier.split('.').map((part) => `[${part}]`).join('.');
  }
  return `[${identifier}]`;
}

module.exports = {
  type: 'connector',
  id: 'mssql',
  name: 'SQL Server',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const pool = await mssql.connect({
        server: config.host,
        port: config.port || 1433,
        database: config.database,
        user: config.username,
        password: config.password,
        options: {
          encrypt: config.ssl || false,
          trustServerCertificate: true,
          instanceName: config.instanceName || undefined
        },
        connectionTimeout: 8000,
      });
      await pool.close();
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
      const pool = await getPool(config, connectionId);
      const result = await pool.request().query(`
        SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, TABLE_TYPE AS type
        FROM INFORMATION_SCHEMA.TABLES
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `);

      return {
        success: true,
        tables: result.recordset
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
      schema = schema || 'dbo';
      console.log('config, connectionId, schema, table: ', config, connectionId, schema, table)
      const pool = await getPool(config, connectionId);
      const result = await pool.request()
        .input('schema', mssql.NVarChar, schema)
        .input('table', mssql.NVarChar, table)
        .query(`
          SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.IS_NULLABLE AS nullable,
                 CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS isPrimary
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
          ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
          WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION
        `);
      console.log('result: ', result)
      return {
        success: true,
        columns: result.recordset
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
   * The cap is applied by putting the request in streaming mode and cancelling
   * it once enough rows have arrived, so the SQL the user wrote is the SQL SQL
   * Server runs — no TOP is injected and no subquery is wrapped around it.
   *
   * The statement runs exactly ONCE on every path. A stream that fails is
   * reported as a failure rather than retried unwrapped: re-running an
   * arbitrary statement to work around a read problem is how an INSERT ends up
   * applied twice.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    const maxRows = Number(options.maxRows);
    const sqlQuery = queryObj.query;

    if (!(maxRows > 0)) {
      try {
        const pool = await getPool(config, connectionId);
        const result = await pool.request().query(sqlQuery);
        const columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : [];
        return {
          success: true,
          rows: result.recordset,
          columns,
          rowCount: result.rowsAffected?.[0] ?? result.recordset?.length
        };
      } catch (error) {
        return { success: false, message: error.message };
      }
    }

    let pool;
    try {
      pool = await getPool(config, connectionId);
    } catch (error) {
      return { success: false, message: error.message };
    }

    return new Promise((resolve) => {
      const rows = [];
      let columns = [];
      let affected = 0;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const request = pool.request();
        request.stream = true;

        request.on('recordset', (recordsetColumns) => {
          columns = Object.keys(recordsetColumns || {});
        });
        request.on('row', (row) => {
          // One past the cap, so "is there more?" is observed rather than
          // assumed. Cancelling stops SQL Server sending the rest.
          if (rows.length <= maxRows) rows.push(row);
          if (rows.length > maxRows) request.cancel();
        });
        request.on('rowsaffected', (count) => { affected += count || 0; });
        request.on('error', (err) => finish({ success: false, message: err.message }));
        request.on('done', () => finish({
          success: true,
          rows: rows.slice(0, maxRows),
          columns: columns.length ? columns : Object.keys(rows[0] || {}),
          // A statement that returns no rows (DDL, or an UPDATE) reports its
          // effect through `rowsaffected` — that is the only count there is.
          rowCount: Math.min(rows.length, maxRows) || affected,
          truncated: rows.length > maxRows,
        }));

        request.query(sqlQuery);
      } catch (error) {
        finish({ success: false, message: error.message });
      }
    });
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const pool = await getPool(config, connectionId);

      return new Promise((resolve, reject) => {
        const request = pool.request();
        request.stream = true;

        let batch = [];
        let columns = null;
        let totalRows = 0;
        let isPaused = false;

        request.on('recordset', (recordsetColumns) => {
          columns = Object.keys(recordsetColumns);
        });

        request.on('row', (row) => {
          batch.push(row);

          if (batch.length >= batchSize && !isPaused) {
            isPaused = true;
            request.pause();
            const currentBatch = batch;
            batch = [];
            totalRows += currentBatch.length;

            // Process batch asynchronously
            Promise.resolve(onBatch(currentBatch, columns))
              .then(() => {
                isPaused = false;
                request.resume();
              })
              .catch((err) => {
                reject(err);
              });
          }
        });

        request.on('done', async () => {
          // Process remaining rows in batch
          if (batch.length > 0) {
            totalRows += batch.length;
            try {
              await onBatch(batch, columns);
            } catch (err) {
              reject(err);
              return;
            }
          }

          resolve({ success: true, totalRows });
        });

        request.on('error', (err) => {
          reject(err);
        });

        request.query(query);
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
      await pool.close();
      connectionPools.delete(connectionId);
    }
  },

  /**
   * Batch insert rows into a table (uses Table-Valued Parameters with transaction)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const pool = await getPool(config, connectionId);
      const transaction = pool.transaction();

      try {
        // Start transaction
        await transaction.begin();

        // Quote column names for SQL Server
        const quotedColumns = columns.map(col => `[${col}]`);

        // Build multi-row INSERT using MSSQL's table value constructor
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

        const insertSql = `INSERT INTO ${quoteSqlServerIdentifier(tableName)} (${quotedColumns.join(', ')}) VALUES ${valueRows.join(', ')}`;
        // console.log('insertSql: ', insertSql)

        await transaction.request().query(insertSql);
        // Commit transaction
        await transaction.commit();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await transaction.rollback();
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
        label: 'Server',
        placeholder: 'localhost',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '1433',
        default: 1433,
        required: false,
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
        placeholder: 'sa',
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
        name: 'instanceName',
        type: 'string',
        label: 'Instance Name',
        placeholder: 'SQLEXPRESS',
        required: false,
        sensitive: false
      },
      {
        name: 'ssl',
        type: 'boolean',
        label: 'Encrypt Connection',
        default: false,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating MSSQL transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Microsoft SQL Server expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Microsoft SQL Server
    - Target schema: ${targetSchema || 'dbo'}
    - Target table name: ${fullTableName}
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local SQLite'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:
    Generate transformation SQL that:
    1. Creates a new table in SQL Server with the transformed structure
    2. Populates it with transformed data using INSERT INTO ... SELECT

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement",
      "sql": "INSERT INTO statement with SELECT query",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (TOP 100)"
    }`
      : `**Instructions for Local SQLite Storage**:
    Generate SQL to fetch data from SQL Server and save it locally to SQLite.

    **You must provide THREE separate SQL statements**:
    1. **DDL**: SQLite CREATE TABLE statement with appropriate SQLite data types
       - Use SQLite types: INTEGER, REAL, TEXT, BLOB
       - Column names must match the SELECT query output
    2. **SQL (SELECT)**: SQL Server SELECT query to fetch and transform data from the source
       - This will be executed on SQL Server database
       - Include all transformations (filtering, calculations, etc.)
       - Use SQL Server syntax (e.g., TOP instead of LIMIT)
    3. **INSERT**: SQLite INSERT statement to insert the fetched data
       - Use parameterized query with ? placeholders
       - Column order must match the SELECT query output exactly

    **SQLite Data Type Mapping**:
    - INTEGER: for whole numbers (int, bigint, identity, etc.)
    - REAL: for floating point numbers (float, real, decimal, numeric)
    - TEXT: for strings (varchar, nvarchar, char, nchar, text, datetime, datetime2)
    - BLOB: for binary data (varbinary, image)

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "SQLite CREATE TABLE ${fullTableName.split('.').pop()} (...columns...)",
      "sql": "SQL Server SELECT query to fetch transformed data",
      "insertSql": "SQLite table INSERT INTO ${fullTableName.split('.').pop()} (...columns...) VALUES (?, ?, ...)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SQLite table SELECT * FROM ${fullTableName.split('.').pop()} LIMIT 100"
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "ddl": "CREATE TABLE customers_transformed (customer_id INTEGER, name TEXT, email TEXT, total_spending REAL)",
      "sql": "SELECT TOP 10000 customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM dbo.customers WHERE status = 'active'",
      "insertSql": "INSERT INTO customers_transformed (customer_id, name, email, total_spending) VALUES (?, ?, ?, ?)",
      "targetColumns": [{"name": "customer_id", "type": "INTEGER"}, {"name": "name", "type": "TEXT"}, {"name": "email", "type": "TEXT"}, {"name": "total_spending", "type": "REAL"}],
      "previewSql": "SELECT * FROM customers_transformed LIMIT 100"
    }`}

    Be specific and provide working SQL. Use SQL Server-specific features where appropriate (e.g., IDENTITY, NVARCHAR, XML/JSON functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Microsoft SQL Server expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Microsoft SQL Server
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

    **ALTER TABLE Operations (SQL Server)**:
    - ADD COLUMN: ALTER TABLE table_name ADD column_name data_type [DEFAULT value]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - ALTER COLUMN: ALTER TABLE table_name ALTER COLUMN column_name new_data_type [NULL | NOT NULL]
    - RENAME COLUMN: EXEC sp_rename 'table_name.old_name', 'new_name', 'COLUMN' (use stored procedure)

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - If both ddl and sql are provided, ddl will execute first, then sql

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "ALTER TABLE or EXEC sp_rename statement (null if not needed)",
      "sql": "UPDATE or DELETE statement (null if not needed)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // the table columns AFTER the change, or "*" if the shape is unchanged (plain UPDATE / DELETE)
      "previewSql": "SELECT query to preview the modified table (TOP 100)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders",
      "ddl": null,
      "sql": "DELETE FROM ${fullTableName} WHERE status = 'cancelled'",
      "targetColumns": "*",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Update operation:
    {
      "explanation": "Mark old orders as archived",
      "ddl": null,
      "sql": "UPDATE ${fullTableName} SET archived = 1, archived_date = GETDATE() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (add column):
    {
      "explanation": "Add **priority_level** column with default value",
      "ddl": "ALTER TABLE ${fullTableName} ADD priority_level INT DEFAULT 0",
      "sql": null,
      "targetColumns": [{"name": "order_id", "type": "INT"}, {"name": "total_amount", "type": "DECIMAL(10,2)"}, {"name": "discount_rate", "type": "DECIMAL(5,2)"}],   // ALL columns the table now has, not just the new one
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (rename column):
    {
      "explanation": "Rename **customer_name** to **client_name**",
      "ddl": "EXEC sp_rename '${fullTableName}.customer_name', 'client_name', 'COLUMN'",
      "sql": null,
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (modify type):
    {
      "explanation": "Change **status** column to allow longer values",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status NVARCHAR(100) NOT NULL",
      "sql": null,
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **display_name** column and populate from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD display_name NVARCHAR(255)",
      "sql": "UPDATE ${fullTableName} SET display_name = first_name + ' ' + last_name",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Be specific and provide working T-SQL. Use SQL Server-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for SQL Server
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for SQL Server)
   * @returns {string} Properly quoted identifier
   */
  quoteIdentifier: (identifier, schema = null, config = null) =>
    quoteSqlServerIdentifier(identifier, schema),

  /**
   * Generate preview SQL query with database-specific syntax
   * @param {string} tableName - Table name (can be pre-quoted)
   * @param {number} limit - Number of rows to return (default 100)
   * @returns {string} Preview SQL query
   */
  getPreviewQuery: (tableName, limit = 100) => {
    return `SELECT TOP ${limit} * FROM ${tableName}`;
  },

  /**
   * Data Explorer dialect. Read by public/database/dialect.js — keyword and
   * function lists are unioned with the shared ANSI baseline, so only what is
   * distinctly T-SQL belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'TransactSQL',
    formatter: 'transactsql',
    // runQuery honours { maxRows } by streaming and cancelling — see the note there.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    // Bracket quoting comes from this connector's own quoteIdentifier; this is
    // only the fallback, and T-SQL accepts double quotes under QUOTED_IDENTIFIER.
    quote: '"',
    keywords: [
      'TOP', 'OFFSET ? ROWS', 'FETCH NEXT ? ROWS ONLY', 'OUTPUT', 'MERGE',
      'CROSS APPLY', 'OUTER APPLY', 'PIVOT', 'UNPIVOT', 'WITH (NOLOCK)',
      'IDENTITY', 'NVARCHAR', 'DECLARE', 'BEGIN', 'GO', 'EXEC', 'TRY_CAST',
      'TRY_CONVERT', 'IIF', 'OVER', 'PARTITION BY',
    ],
    functions: [
      'ISNULL', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'DATEADD', 'DATEDIFF',
      'DATEPART', 'DATENAME', 'FORMAT', 'CONVERT', 'TRY_CONVERT', 'TRY_CAST',
      'STRING_AGG', 'STRING_SPLIT', 'CHARINDEX', 'PATINDEX', 'STUFF', 'LEN',
      'IIF', 'CHOOSE', 'NEWID', 'SCOPE_IDENTITY',
    ],
  }
};
