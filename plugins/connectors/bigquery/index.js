/**
 * Google BigQuery Connector Plugin for Ternlux
 * Handles all BigQuery database operations
 */

const { BigQuery } = require('@google-cloud/bigquery');

// BigQuery client cache
const bigQueryClients = new Map();

/**
 * Get or create BigQuery client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!bigQueryClients.has(key)) {
    const options = {
      projectId: config.projectId,
    };

    // Support both service account key file path and JSON credentials
    if (config.keyFilePath) {
      options.keyFilename = config.keyFilePath;
    } else if (config.credentials) {
      // Parse credentials if it's a string
      const creds = typeof config.credentials === 'string'
        ? JSON.parse(config.credentials)
        : config.credentials;
      options.credentials = creds;
    }

    const client = new BigQuery(options);
    bigQueryClients.set(key, client);
  }

  return bigQueryClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'bigquery',
  name: 'Google BigQuery',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const bigquery = getClient(config, connectionId);

      // Test connection by listing datasets (limit 1)
      const [datasets] = await bigquery.getDatasets({ maxResults: 1 });

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
      const bigquery = getClient(config, connectionId);
      const datasetId = config.dataset;

      if (!datasetId) {
        return { success: false, message: 'Dataset is required' };
      }

      const dataset = bigquery.dataset(datasetId);
      const [tables] = await dataset.getTables();

      return {
        success: true,
        tables: tables.map(table => ({
          schema: datasetId,
          name: table.id,
          type: table.metadata.type === 'VIEW' ? 'view' : 'table'
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
      const bigquery = getClient(config, connectionId);
      const datasetId = schema || config.dataset;

      const [metadata] = await bigquery
        .dataset(datasetId)
        .table(table)
        .getMetadata();

      const fields = metadata.schema?.fields || [];

      return {
        success: true,
        columns: fields.map(field => ({
          name: field.name,
          type: field.type,
          nullable: field.mode !== 'REQUIRED',
          isPrimary: false, // BigQuery doesn't enforce primary keys
          defaultValue: null
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
   * BigQuery caps natively: `maxResults` bounds the page the job returns, so
   * the SQL the user wrote is the SQL BigQuery runs — no LIMIT is appended and
   * no subquery is wrapped around it. `autoPaginate: false` is what keeps the
   * client from fetching every remaining page behind our back.
   *
   * The statement runs exactly ONCE on every path.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    try {
      const bigquery = getClient(config, connectionId);

      // Extract SQL query from the query object
      const sqlQuery = queryObj.query;
      const maxRows = Number(options.maxRows);

      const jobOptions = {
        query: sqlQuery,
        location: config.location || 'US',
      };

      const [job] = await bigquery.createQueryJob(jobOptions);
      // One past the cap, so "is there more?" is observed rather than assumed.
      const [allRows] = maxRows > 0
        ? await job.getQueryResults({ maxResults: maxRows + 1, autoPaginate: false })
        : await job.getQueryResults();

      const rows = maxRows > 0 ? allRows.slice(0, maxRows) : allRows;

      // Extract column names from the first row or from job metadata
      let columns = [];
      if (rows.length > 0) {
        columns = Object.keys(rows[0]);
      }

      return {
        success: true,
        rows: rows,
        columns: columns,
        rowCount: rows.length,
        ...(maxRows > 0 ? { truncated: allRows.length > maxRows } : {})
      };
    } catch (error) {
      console.error('BigQuery runQuery error:', error);
      console.error('Query that failed:', queryObj.query);
      return { success: false, message: error.message };
    }
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const bigquery = getClient(config, connectionId);

      const options = {
        query: query,
        location: config.location || 'US',
      };

      const [job] = await bigquery.createQueryJob(options);

      return new Promise((resolve, reject) => {
        let columns = null;
        let totalRows = 0;
        let buffer = [];

        job
          .getQueryResultsStream()
          .on('data', async (row) => {
            // Extract column names from first row
            if (!columns && row) {
              columns = Object.keys(row);
            }

            buffer.push(row);

            // When buffer reaches batch size, process it
            if (buffer.length >= batchSize) {
              const batchToProcess = buffer;
              buffer = [];
              totalRows += batchToProcess.length;

              try {
                await onBatch(batchToProcess, columns);
              } catch (error) {
                reject(error);
              }
            }
          })
          .on('end', async () => {
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
          })
          .on('error', (error) => {
            reject(error);
          });
      });
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (bigQueryClients.has(connectionId)) {
      bigQueryClients.delete(connectionId);
    }
  },

  /**
   * Batch insert rows into a table (uses BigQuery streaming insert API)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const bigquery = getClient(config, connectionId);

      // Parse table name (format: dataset.table or project.dataset.table)
      const parts = tableName.split('.');
      let datasetId, tableId;

      if (parts.length === 2) {
        [datasetId, tableId] = parts;
      } else if (parts.length === 3) {
        [, datasetId, tableId] = parts;
      } else {
        throw new Error('Invalid table name format. Expected: dataset.table or project.dataset.table');
      }

      const dataset = bigquery.dataset(datasetId);
      const table = dataset.table(tableId);

      // Convert rows to BigQuery format
      const formattedRows = rows.map(row => {
        const rowData = {};
        columns.forEach(col => {
          const val = row[col];
          if (val === null || val === undefined) {
            rowData[col] = null;
          } else if (val instanceof Date) {
            rowData[col] = val.toISOString();
          } else if (typeof val === 'object') {
            rowData[col] = JSON.stringify(val);
          } else {
            rowData[col] = val;
          }
        });
        return rowData;
      });

      // Use streaming insert (no transaction needed - BigQuery handles it)
      const insertResponse = await table.insert(formattedRows);

      // Check for partial errors
      // BigQuery returns an array of error objects if some rows failed
      // if (insertResponse && Array.isArray(insertResponse) && insertResponse.length > 0) {
      //   // Extract error details
      //   const errorDetails = insertResponse.map((err, idx) => {
      //     const errorMessages = err.errors.map(e => e.message || e.reason).join(', ');
      //     return `Row ${idx}: ${errorMessages}`;
      //   }).join('; ');

      //   console.error('BigQuery insert partial errors:', insertResponse);

      //   return {
      //     success: false,
      //     message: `Failed to insert ${insertResponse.length} row(s). Errors: ${errorDetails}`
      //   };
      // }

      return {
        success: true,
        rowsInserted: rows.length
      };
    } catch (error) {
      // Handle complete failure
      if (error.errors && Array.isArray(error.errors)) {
        const errorDetails = error.errors.map(e => e.message || e.errors);
        console.error('BigQuery insert error:', errorDetails);
        return { success: false, message: `Insert failed: ${errorDetails}` };
      }
      console.error('BigQuery insert error:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'projectId',
        type: 'string',
        label: 'Project ID',
        placeholder: 'my-gcp-project',
        required: true,
        sensitive: true
      },
      {
        name: 'dataset',
        type: 'string',
        label: 'Dataset',
        placeholder: 'my_dataset',
        required: true,
        sensitive: false
      },
      {
        name: 'credentials',
        type: 'textarea',
        label: 'Service Account JSON',
        placeholder: 'Paste your service account JSON key here',
        required: true,
        sensitive: true
      },
      {
        name: 'location',
        type: 'string',
        label: 'Location',
        placeholder: 'US',
        default: 'US',
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating BigQuery transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetDataset, fullTableName) => `You are a Google BigQuery expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Google BigQuery
    - Target dataset: ${targetDataset}
    - Target table name: ${fullTableName}
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local SQLite'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:
    Generate transformation SQL that:
    1. Creates a new table in BigQuery with the transformed structure
    2. Populates it with transformed data using CREATE OR REPLACE TABLE ... AS SELECT

    **BigQuery-Specific Considerations**:
    - Use partitioning for large tables (PARTITION BY DATE, TIMESTAMP, or integer ranges)
    - Use clustering for frequently filtered columns (CLUSTER BY)
    - BigQuery supports nested and repeated fields (ARRAY, STRUCT)
    - Use appropriate data types (INT64, FLOAT64, STRING, BOOL, DATE, TIMESTAMP, etc.)

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE OR REPLACE TABLE statement with BigQuery optimizations",
      "sql": "The SELECT query is part of the CREATE TABLE AS SELECT statement in ddl field (leave sql as empty string)",
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local SQLite Storage**:
    Generate SQL to fetch data from BigQuery and save it locally to SQLite.

    **You must provide THREE separate SQL statements**:
    1. **DDL**: SQLite CREATE TABLE statement with appropriate SQLite data types
       - Use SQLite types: INTEGER, REAL, TEXT, BLOB
       - Column names must match the SELECT query output
    2. **SQL (SELECT)**: BigQuery SELECT query to fetch and transform data from the source
       - This will be executed on BigQuery
       - Include all transformations (filtering, calculations, etc.)
    3. **INSERT**: SQLite INSERT statement to insert the fetched data
       - Use parameterized query with ? placeholders
       - Column order must match the SELECT query output exactly

    **SQLite Data Type Mapping**:
    - INTEGER: for whole numbers (INT64, BOOL as 0/1)
    - REAL: for floating point numbers (FLOAT64, NUMERIC, BIGNUMERIC)
    - TEXT: for strings (STRING, BYTES, DATE, DATETIME, TIMESTAMP, TIME)
    - BLOB: for binary data

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "SQLite CREATE TABLE ${fullTableName.split('.').pop()} (...columns...)",
      "sql": "BigQuery SELECT query to fetch transformed data",
      "insertSql": "SQLite INSERT INTO ${fullTableName.split('.').pop()} (...columns...) VALUES (?, ?, ...)",
      "previewSql": "SQLite SELECT * FROM ${fullTableName.split('.').pop()} LIMIT 100"
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "ddl": "CREATE TABLE customers_transformed (customer_id INTEGER, name TEXT, email TEXT, total_spending REAL)",
      "sql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) as total_spending FROM \`project.dataset.customers\` WHERE status = 'active'",
      "insertSql": "INSERT INTO customers_transformed (customer_id, name, email, total_spending) VALUES (?, ?, ?, ?)",
      "previewSql": "SELECT * FROM customers_transformed LIMIT 100"
    }`}

    Be specific and provide working SQL. Use BigQuery-specific features where appropriate (e.g., backticks for table names, standard SQL syntax).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetDataset, fullTableName) => `You are a Google BigQuery expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Google BigQuery
    - Target dataset: ${targetDataset}
    - Target table name: ${fullTableName}

    Analyze the request and determine what operations are needed:

    1. **UPDATE/DELETE only**: Use sql field only, ddl is null
    2. **ALTER TABLE only**: Use ddl field only, sql is null
    3. **ALTER TABLE + UPDATE/DELETE**: Use both ddl and sql (ddl executes first)

    **Logic Rules**:
    1. Use UPDATE if the user wants to change values within existing rows.
    2. Use DELETE if the user wants to remove records.
    3. Use ALTER TABLE if the user wants to modify table structure (add/drop/rename columns).
    4. **Filtering Intent**: If the user's request is to "keep only," "get only," or "filter for" certain records, you must DELETE all records that do NOT meet that criteria (e.g., DELETE FROM table WHERE column != 'value').

    **ALTER TABLE Operations (BigQuery)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [OPTIONS(description='...')]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name
    - ALTER COLUMN TYPE: ALTER TABLE table_name ALTER COLUMN column_name SET DATA TYPE new_type

    **Important BigQuery Notes**:
    - Use backticks for table names: \`project.dataset.table\`
    - BigQuery supports UPDATE and DELETE with WHERE clauses
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
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount FLOAT64 OPTIONS(description='Total order amount')",
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
      "explanation": "Change **status_code** from INT64 to STRING",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status_code SET DATA TYPE STRING",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name STRING",
      "sql": "UPDATE ${fullTableName} SET full_name = CONCAT(first_name, ' ', last_name) WHERE TRUE",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working BigQuery SQL. Use BigQuery-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for BigQuery
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name (dataset)
   * @param {object} config - Database configuration (not used for BigQuery)
   * @returns {string} Properly quoted identifier
   */
  quoteIdentifier: (identifier, schema = null, config = null) => {
    if (!identifier) return identifier;

    const quotedIdentifier = `\`${identifier}\``;

    if (schema) {
      return `\`${schema}\`.${quotedIdentifier}`;
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
   * distinctly BigQuery belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'BigQuery',
    formatter: 'bigquery',
    // runQuery honours { maxRows } via maxResults — see the note there.
    maxRowsOption: true,
    // BigQuery's container above a table is the dataset.
    container: 'Dataset',
    objectLabel: 'Table',
    quote: '`',
    keywords: [
      'QUALIFY', 'UNNEST', 'STRUCT', 'ARRAY', 'EXCEPT DISTINCT', 'SELECT AS STRUCT',
      'PIVOT', 'UNPIVOT', 'TABLESAMPLE SYSTEM', 'PARTITION BY', 'CLUSTER BY',
      'FOR SYSTEM_TIME AS OF', 'ASSERT', 'DECLARE', 'MERGE', 'WINDOW',
    ],
    functions: [
      'ARRAY_AGG', 'ARRAY_LENGTH', 'STRING_AGG', 'GENERATE_ARRAY', 'UNNEST',
      'PARSE_JSON', 'JSON_VALUE', 'JSON_EXTRACT', 'TO_JSON_STRING',
      'DATE_TRUNC', 'DATE_ADD', 'DATE_DIFF', 'TIMESTAMP_TRUNC', 'TIMESTAMP_DIFF',
      'CURRENT_DATE', 'FORMAT_DATE', 'PARSE_DATE', 'SAFE_CAST', 'IFNULL',
      'APPROX_COUNT_DISTINCT', 'APPROX_QUANTILES', 'NET.HOST',
    ],
  }
};
