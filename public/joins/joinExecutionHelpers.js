/**
 * Join Execution Helper Functions
 * Shared utilities for executing join operations
 */

const path = require('path');
const Datastore = require('@seald-io/nedb');
const localSqlite = require('../lib/sqlite');

// Imported-file SQLite connections have NO plugin connector (sqlite is a local
// builtin, read via public/lib/sqlite.js). Detect that case so we read the
// source directly from its .db file instead of calling
// pluginManager.getConnector('sqlite') — which returns undefined and crashes
// with "Cannot read properties of undefined (reading 'runQuery')".
function isLocalSqliteSource(conn, pluginManager) {
  return !!conn && conn.dbType === 'sqlite'
    && (!pluginManager || typeof pluginManager.hasConnector !== 'function' || !pluginManager.hasConnector('sqlite'));
}

function localSqlitePath(conn) {
  return conn.fileInfo?.filePath || conn.localPath || conn.dbConfig?.dbPath || null;
}

/**
 * The file a local DuckDB source is read from.
 *
 * A connection that spans several files keeps a name -> path map, so the table
 * being read is what decides which file that is; everything else has one path
 * and the table name is only a label.
 */
function duckSourcePath(connection, tableName) {
  const paths = connection?.dbConfig?.tablePaths;
  if (tableName && paths && typeof paths === 'object' && paths[tableName]) return paths[tableName];
  return localFilePathOf(connection);
}

/**
 * The connection name a local source's schema is derived from.
 *
 * The saved `sourcesConfig[].connection` shape does not carry the connection's
 * NAME — it was assembled for reading a file, not for naming one. So fall back
 * to the file's own basename, which is what registerLocalFile names an imported
 * connection after; for the ordinary case ("customers.csv" imported as
 * "customers") the two agree, and the schema comes out the same as the Data
 * Explorer's. An explicit name is preferred whenever a caller has one.
 */
function connectionNameOf(connection, dbPath) {
  const explicit = connection?.connectionName || connection?.name || null;
  if (explicit) return explicit;
  const original = connection?.fileInfo?.originalName;
  if (original) return path.basename(original, path.extname(original));
  return dbPath ? path.basename(dbPath, path.extname(dbPath)) : null;
}

/**
 * Read a local DuckDB source — a data file, or a table in a workflow database.
 *
 * These never go through the duckdb CONNECTOR. The connector is built for a
 * saved connection and resolves its file from `config.dbPath`, but the shape
 * this loader is handed comes from enrichJoinSourcesConfig, which puts the path
 * on `connection.localPath` and leaves dbConfig empty for anything without a
 * saved connection — every upstream node's output, since those carry the
 * synthetic id "local-duckdb". Routed through the connector that source
 * resolved to nothing: `runQuery` returned `{ success: false, message: 'DuckDB
 * requires a file path', rows: [] }`, the caller's `result.rows || []` turned
 * that into an empty array, and the join ran to completion against no rows —
 * writing a silently empty result into the destination.
 *
 * So the path is resolved here the same way the local-destination join resolves
 * it (executeLocalDuckDBJoin), which also gets two things the connector route
 * did not: a workflow database is attached and its table addressed through the
 * alias, and a workbook's sheet is picked out by the source's table name rather
 * than every sheet reading as the first one.
 *
 * The AI writes `SELECT … FROM <table>`, so the source is exposed under that
 * name for the duration of the read — and under the file's own basename too,
 * since the two do not always agree (mirrors DuckDB.registerSource).
 */
async function withDuckDBSource(sourceConnection, sourceConfig, fn) {
  const duck = require('../duckdb');

  const table = sourceConfig.tableName
    || sourceConfig.sourceTableSchema?.tableName
    || sourceConfig.tempTableName
    || null;
  const dbPath = duckSourcePath(sourceConnection, table);
  if (!dbPath) {
    throw new Error(
      `Local source "${table || sourceConfig.sourceNodeId || 'unknown'}" has no file path`
      + ' — expected one on connection.localPath, fileInfo.filePath or dbConfig.dbPath.',
    );
  }

  let body;
  if (/\.duckdb$/i.test(dbPath)) {
    // An upstream node's output: a real table inside a workflow database.
    if (!table) throw new Error(`Reading a table out of ${path.basename(dbPath)} requires the source's table name.`);
    const alias = await duck.attachDb(dbPath);
    body = `SELECT * FROM ${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(duck.sanitizeIdentifier(table))}`;
  } else {
    // A data file, read where it lies. For a workbook the table name is the
    // sheet; for every other format that resolves to null.
    const ref = await duck.tableRef(
      dbPath,
      sourceConnection.fileInfo?.format || sourceConnection.dbConfig?.format || null,
      { sheet: duck.sheetFor(dbPath, table) },
    );
    body = `SELECT * FROM ${ref}`;
  }

  // Bare AND `<connection>.<table>` — see duck.registerAddressableViews. It
  // matters more here than for a transformer: a join has SEVERAL local sources,
  // so `customers.customers` and `products.products` are exactly how the Data
  // Explorer tells the user (and any model reading their SQL) to tell two files
  // apart.
  const { created } = await duck.registerAddressableViews({
    body,
    names: [table, path.basename(dbPath, path.extname(dbPath))],
    connectionName: connectionNameOf(sourceConnection, dbPath),
  });
  try {
    return await fn({ duck, table, dbPath });
  } finally {
    // Leaving one behind would shadow whatever else answers to that name.
    await duck.dropViews(created);
  }
}

/** Read a local DuckDB source whole. */
async function loadDuckDBSourceData(sourceConnection, sourceConfig) {
  return withDuckDBSource(sourceConnection, sourceConfig, async ({ duck, table }) => {
    const sql = String(sourceConfig.sql || '').replace('{LIMIT_OFFSET_HERE}', '').trim();
    if (!sql) {
      throw new Error(`Local source "${table || sourceConfig.sourceNodeId || 'unknown'}" has no SQL to read it with.`);
    }
    const result = await duck.query(sql);
    return result.rows || [];
  });
}

/**
 * Page a local DuckDB source, for a join whose DESTINATION is a real database.
 *
 * That route stages every source into a temp table on the destination, so rows
 * arrive in chunks rather than all at once. Until this existed, a local DuckDB
 * source taking it fell through to the duckdb CONNECTOR, which resolves its
 * file from `config.dbPath` — and an upstream node's output carries the
 * synthetic id "local-duckdb" with an empty dbConfig, so there was nothing to
 * open and the read failed with "DuckDB requires a file path". The path was on
 * `connection.localPath` the whole time; only loadDuckDBSourceData looked there,
 * and that is the read-it-all route, not this one.
 *
 * Views are registered ONCE and every page runs against them, so a source is
 * not re-resolved per chunk.
 */
async function loadDuckDBSourceInChunks(sourceConnection, sourceConfig, sql, chunkSize, onChunk) {
  return withDuckDBSource(sourceConnection, sourceConfig, async ({ duck, table }) => {
    const base = String(sql || '').trim();
    if (!base) {
      throw new Error(`Local source "${table || sourceConfig?.sourceNodeId || 'unknown'}" has no SQL to read it with.`);
    }
    let offset = 0;
    let totalProcessed = 0;
    while (true) {
      const pagination = `LIMIT ${chunkSize} OFFSET ${offset}`;
      const chunkQuery = base.includes('{LIMIT_OFFSET_HERE}')
        ? base.replace('{LIMIT_OFFSET_HERE}', pagination)
        : `${base} ${pagination}`;
      const { rows } = await duck.query(chunkQuery);
      if (!rows || rows.length === 0) break;
      totalProcessed += rows.length;
      await onChunk(rows, offset, totalProcessed);
      offset += chunkSize;
    }
    return totalProcessed;
  });
}

/**
 * Load data from a source (SQL or NoSQL)
 * @param {Object} sourceConnection - Source connection configuration
 * @param {Object} sourceConfig - Source configuration with sql/nosqlOperation
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @returns {Promise<Array>} Array of data rows/documents
 */
async function loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig) {
  const sourceDbType = sourceConnection.dbType;

  // Local imported-file SQLite source — read straight from its .db file.
  if (isLocalSqliteSource(sourceConnection, pluginManager)) {
    const dbPath = localSqlitePath(sourceConnection);
    if (!dbPath) throw new Error(`No local SQLite path for source ${sourceConnection.id}`);
    const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '');
    return await localSqlite.runQuery({ dbPath, query: sql });
  }

  // Local DuckDB source — a file, or a table in a workflow database. Read by
  // path rather than through the connector; see loadDuckDBSourceData.
  if (sourceDbType === 'duckdb') {
    return await loadDuckDBSourceData(sourceConnection, sourceConfig);
  }

  // Check if connector is available
  if (!pluginManager.hasConnector(sourceDbType) && sourceDbType !== 'nedb') {
    throw new Error(`Database type ${sourceDbType} is not supported`);
  }

  const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
  const isNoSQLSource = ['mongodb', 'nedb'].includes(sourceDbType);

  if (isNoSQLSource) {
    // Load from NoSQL source
    const operation = sourceConfig.nosqlOperation || '{}';

    if (sourceDbType === 'nedb') {
      // NeDB is handled locally, not via plugin
      const localPath = sourceConnection.fileInfo?.filePath || sourceConnection.localPath;
      const db = new Datastore({ filename: localPath, autoload: false });

      await new Promise((resolve, reject) => {
        db.loadDatabase((err) => err ? reject(err) : resolve());
      });
      const operationJson = JSON.parse(operation);
      const filter = operationJson.filter || {};
      const limit = operationJson.limit || 1000000;

      return await new Promise((resolve, reject) => {
        const query = db.find(filter);
        if (limit > 0) query.limit(limit);
        query.exec((err, docs) => err ? reject(err) : resolve(docs));
      });
    } else {
      // MongoDB or other NoSQL via plugin
      const plugin = pluginManager.getConnector(sourceDbType);
      const operationObj = JSON.parse(operation);
      const result = await plugin.runQuery(fullConfig, sourceConnection.id, operationObj);
      return rowsOrThrow(result, sourceConnection, sourceLabel(sourceConfig, sourceConnection));
    }
  } else {
    // Load from SQL source via plugin
    const plugin = pluginManager.getConnector(sourceDbType);
    const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '')
    const result = await plugin.runQuery(fullConfig, sourceConnection.id, { query: sql});
    return rowsOrThrow(result, sourceConnection, sourceLabel(sourceConfig, sourceConnection));
  }
}

/**
 * A connector's rows, or the reason there are none.
 *
 * Connectors report failure as `{ success: false, message, rows: [] }` rather
 * than by throwing, so `result.rows || []` reads a failed read as an empty
 * source — and a join over an empty source succeeds, writing a silently wrong
 * result to the destination. Same rule the skill-helper layer applies in
 * electron.js: success false is an error.
 */
function rowsOrThrow(result, sourceConnection, label) {
  if (result && result.success === false) {
    const name = label || sourceConnection?.id || 'source';
    throw new Error(`Could not read join source "${name}" (${sourceConnection?.dbType}): ${result.message || 'query failed'}`);
  }
  return (result && result.rows) || [];
}

/** How a source is named in a read failure — the table it meant, else its node. */
function sourceLabel(sourceConfig, sourceConnection) {
  return sourceConfig?.tableName
    || sourceConfig?.sourceTableSchema?.tableName
    || sourceConfig?.sourceNodeId
    || sourceConnection?.id
    || 'source';
}

/**
 * Load data from SQL source in chunks (streaming)
 * @param {Object} sourceConnection - Source connection configuration
 * @param {string} sql - SQL query to execute
 * @param {number} chunkSize - Number of rows per chunk
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} onChunk - Callback for each chunk (chunk, offset, totalSoFar)
 * @returns {Promise<number>} Total rows processed
 */
async function loadSQLSourceInChunks(
  sourceConnection,
  sql,
  chunkSize,
  pluginManager,
  getFullConfig,
  onChunk,
  // The source's own config. Needed to resolve WHERE a local source lives (and
  // which sheet of a workbook it means) — the connection alone does not say.
  sourceConfig = null
) {
  const sourceDbType = sourceConnection.dbType;

  // Local DuckDB source — a data file, or an upstream node's table in a
  // workflow database. Read by PATH rather than through the connector, which
  // resolves its file from `config.dbPath` and so cannot open either of those.
  // Mirrors the branch loadSourceData already has; see loadDuckDBSourceInChunks.
  if (sourceDbType === 'duckdb' && sourceConfig) {
    return await loadDuckDBSourceInChunks(sourceConnection, sourceConfig, sql, chunkSize, onChunk);
  }

  // Local imported-file SQLite source — page through it with the local lib
  // (LIMIT/OFFSET) since there is no plugin connector for sqlite.
  if (isLocalSqliteSource(sourceConnection, pluginManager)) {
    const dbPath = localSqlitePath(sourceConnection);
    if (!dbPath) throw new Error(`No local SQLite path for source ${sourceConnection.id}`);
    let offset = 0;
    let totalProcessed = 0;
    while (true) {
      const paginationClause = `LIMIT ${chunkSize} OFFSET ${offset}`;
      const chunkQuery = sql.includes('{LIMIT_OFFSET_HERE}')
        ? sql.replace('{LIMIT_OFFSET_HERE}', paginationClause)
        : `${sql} ${paginationClause}`;
      const rows = await localSqlite.runQuery({ dbPath, query: chunkQuery });
      if (rows.length === 0) break;
      totalProcessed += rows.length;
      await onChunk(rows, offset, totalProcessed);
      offset += chunkSize;
    }
    return totalProcessed;
  }

  if (!pluginManager.hasConnector(sourceDbType)) {
    throw new Error(`Database type ${sourceDbType} is not supported`);
  }

  const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
  const plugin = pluginManager.getConnector(sourceDbType);

  let offset = 0;
  let totalProcessed = 0;
  console.log('sql: ', sql)
  while (true) {
    // Replace {LIMIT_OFFSET_HERE} placeholder with database-specific pagination syntax
    let chunkQuery;
    let paginationClause;

    // Determine database-specific pagination syntax
    if (sourceDbType === 'mssql') {
      // MS SQL Server uses OFFSET...FETCH NEXT and requires ORDER BY
      // Use ORDER BY (SELECT NULL) as a workaround when no explicit ORDER BY is present
      paginationClause = `ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${chunkSize} ROWS ONLY`;
    } else {
      // PostgreSQL, MySQL, SQLite, Redshift, Snowflake, BigQuery use LIMIT/OFFSET
      paginationClause = `LIMIT ${chunkSize} OFFSET ${offset}`;
    }

    if (sql.includes('{LIMIT_OFFSET_HERE}')) {
      chunkQuery = sql.replace('{LIMIT_OFFSET_HERE}', paginationClause);
    } else {
      // Backward compatibility: append pagination clause if no placeholder found
      chunkQuery = `${sql} ${paginationClause}`;
    }

    const result = await plugin.runQuery(fullConfig, sourceConnection.id, { query: chunkQuery });
    // A failed chunk is not the end of the data. Left to `rows || []` it reads
    // as one — the loop breaks, the caller is told how many rows it got, and a
    // temp table that should hold a million rows holds none, with the join over
    // it succeeding anyway. Fail the read instead.
    const rows = rowsOrThrow(result, sourceConnection, sourceConnection?.id);

    if (rows.length === 0) break;

    totalProcessed += rows.length;
    await onChunk(rows, offset, totalProcessed);

    offset += chunkSize;
  }

  return totalProcessed;
}

/**
 * Insert data into a temp table in batches using selectedColumns
 * @param {Object} destPlugin - Destination database plugin
 * @param {Object} destFullConfig - Destination full configuration
 * @param {string} destConnectionId - Destination connection ID
 * @param {string} tempTableName - Temp table name
 * @param {Array} selectedColumns - Array of column names in order
 * @param {Array} data - Array of data to insert
 * @param {number} chunkSize - Batch size for inserts
 * @returns {Promise<number>} Total rows inserted
 */
async function insertDataToTempTable(
  destPlugin,
  destFullConfig,
  destConnectionId,
  tempTableName,
  selectedColumns,
  data,
  chunkSize
) {
  if (data.length === 0) return 0;
  if (!selectedColumns || selectedColumns.length === 0) {
    throw new Error(`No selectedColumns provided for ${tempTableName}`);
  }

  let totalInserted = 0;

  // Insert in chunks to avoid query size limits
  for (let chunkStart = 0; chunkStart < data.length; chunkStart += chunkSize) {
    const chunk = data.slice(chunkStart, chunkStart + chunkSize);

    // Use plugin's batchInsert function if available, otherwise fallback to individual inserts
    if (destPlugin.batchInsert) {
      const result = await destPlugin.batchInsert(destFullConfig, destConnectionId, tempTableName, selectedColumns, chunk);
      if (!result.success) {
        throw new Error(result.message || 'Batch insert failed');
      }
      totalInserted += result.rowsInserted;
    } else {
      // Fallback: individual INSERT statements
      const insertStatements = chunk.map(row => {
        // Format values for each column
        const values = selectedColumns.map(col => {
          const val = row[col];

          if (val === null || val === undefined) {
            return 'NULL';
          } else if (typeof val === 'string') {
            return `'${val.replace(/'/g, "''")}'`;
          } else if (val instanceof Date) {
            return `'${val.toISOString()}'`;
          } else if (typeof val === 'object') {
            return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          } else {
            return val;
          }
        });

        // Build INSERT statement
        const columnsList = selectedColumns.join(', ');
        const valuesList = values.join(', ');
        return `INSERT INTO ${tempTableName} (${columnsList}) VALUES (${valuesList})`;
      });

      // Execute all inserts in the batch (semicolon separated)
      const batchInsert = insertStatements.join('; ');
      await destPlugin.runQuery(destFullConfig, destConnectionId, {query: batchInsert});
      totalInserted += chunk.length;
    }
  }

  return totalInserted;
}

/**
 * Execute join operation on local SQLite database
 * @param {string} appSqliteDbPath - Path to local SQLite database
 * @param {Array} sourcesConfig - Array of source configurations
 * @param {string} targetDdl - CREATE TABLE statement for target
 * @param {string} joinSql - JOIN SQL query
 * @param {string} targetTableName - Target table name
 * @param {string} operationMode - 'new_table' or 'merge_existing'
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @returns {Promise<Object>} Result with success, message, localPath, targetTableName
 */
async function executeLocalSQLiteJoin(
  appSqliteDbPath,
  sourcesConfig,
  targetDdl,
  joinSql,
  targetTableName,
  operationMode,
  pluginManager,
  getFullConfig,
  sqlitePool
) {
  if (!sqlitePool) {
    throw new Error('[executeLocalSQLiteJoin] sqlitePool is required');
  }

  const tempTablesToCleanup = [];

  return sqlitePool.executeWrite(async (db) => {
    try {
    // Step 1: Create and populate temp tables for sources
    for (let i = 0; i < sourcesConfig.length; i++) {
      const sourceConfig = sourcesConfig[i];

      if (!sourceConfig.ddl || !sourceConfig.tempTableName) {
        console.log(`[Local SQLite Join] Source_exists: ${i + 1}`);
        continue;
      }

      const tempTableName = sourceConfig.tempTableName;
      tempTablesToCleanup.push(tempTableName);

      console.log(`[Local SQLite Join] ${tempTableName}...`);

      // Drop temp table
      await new Promise((res, rej) => {
        db.run(`DROP TABLE IF EXISTS ${tempTableName}`, (err) => err ? rej(err) : res());
      });

      // Create temp table
      await new Promise((res, rej) => {
        db.run(sourceConfig.ddl, (err) => {
          if (err) rej(new Error(`Failed to create temp table: ${err.message}`));
          else res();
        });
      });

      // Load data from source
      const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
      const isNoSQLSource = ['mongodb', 'nedb'].includes(sourceConnection.dbType);
      let sourceData = [];

      if (Array.isArray(sourceConfig._preloadedRows)) {
        // Caller (e.g. vector source pre-resolved by skill) supplied rows.
        sourceData = sourceConfig._preloadedRows;
      } else if (isNoSQLSource) {
        sourceData = await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);
      } else if (isLocalSqliteSource(sourceConnection, pluginManager)) {
        // Imported-file SQLite source — no plugin connector exists; read
        // directly from its .db file via the local lib.
        const dbPath = localSqlitePath(sourceConnection);
        if (!dbPath) throw new Error(`No local SQLite path for source ${sourceConnection.id}`);
        const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '');
        sourceData = await localSqlite.runQuery({ dbPath, query: sql });
      } else {
        const sourcePlugin = pluginManager.getConnector(sourceConnection.dbType);
        const sourceFullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '')
        const result = await sourcePlugin.runQuery(sourceFullConfig, sourceConnection.id, {query: sql});
        sourceData = result.rows || [];
      }

      if (sourceData.length === 0) {
        console.log(`[Local SQLite Join] No_data: ${tempTableName}`);
        continue;
      }

      const selectedColumns = sourceConfig.selectedColumns;
      if (!selectedColumns || selectedColumns.length === 0) {
        throw new Error(`No selectedColumns found for ${tempTableName}`);
      }

      // THE FIX: Use serialize locally for the fast transaction block
      await new Promise((res, rej) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION");

          const columnsList = selectedColumns.join(', ');
          const placeholders = selectedColumns.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO ${tempTableName} (${columnsList}) VALUES (${placeholders})`);

          // Insert each row
          for (const row of sourceData) {
            const values = selectedColumns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return null;
              if (val instanceof Date) return val.toISOString();
              if (typeof val === 'object') return JSON.stringify(val);
              return val;
            });
            stmt.run(values);
          }

          stmt.finalize();

          db.run("COMMIT", (err) => {
            if (err) rej(new Error(`Failed to commit transaction: ${err.message}`));
            else res();
          });
        });
      });

      console.log(`[Local SQLite Join] ${tempTableName}: ${sourceData.length}`);

      // // Validate data
      // const validateRecords = await new Promise((res, rej) => {
      //   db.all(`SELECT * FROM ${tempTableName} LIMIT 3`, (err, rows) => err ? rej(err) : res(rows));
      // });
      // console.log(`[Local SQLite Join] Sample data from ${tempTableName}:`, JSON.stringify(validateRecords, null, 2));
    }

    // Step 2: Create target table if needed
    if (operationMode === 'new_table' && targetDdl) {
      console.log(`[Local SQLite Join] TABLE_CREATE: ${targetTableName}...`);
      await new Promise((res, rej) => {
        db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (err) => err ? rej(err) : res());
      });
      await new Promise((res, rej) => {
        db.run(targetDdl, (err) => {
          if (err) rej(new Error(`Failed to create target table: ${err.message}`));
          else res();
        });
      });
    }

    // Step 3: Execute join SQL
    // console.log(`[Local SQLite Join] Executing join query...`);
    const rowsAffected = await new Promise((res, rej) => {
      db.run(joinSql, function(err) {
        if (err) rej(new Error(`Join query failed: ${err.message}`));
        else res(this.changes);
      });
    });
    console.log(`[Local SQLite Join] JOIN_QUERY: ${rowsAffected}`);

    // Target Table Validations
    // const targetRecords = await new Promise((res, rej) => {
    //   db.all(`SELECT * FROM ${targetTableName} LIMIT 3`, (err, rows) => err ? rej(err) : res(rows));
    // });
    // console.log(`[Local SQLite Join] Sample data from target table:`, JSON.stringify(targetRecords, null, 2));

    // const targetCount = await new Promise((res, rej) => {
    //   db.get(`SELECT COUNT(*) as count FROM ${targetTableName}`, (err, row) => err ? rej(err) : res(row.count));
    // });
    // console.log(`[Local SQLite Join] Total rows in target table: ${targetCount}`);

    return {
      success: true,
      message: `Join completed successfully. Results saved to local SQLite at ${appSqliteDbPath}`,
      localPath: appSqliteDbPath,
      targetTableName
    };

    } catch (error) {
      console.error('[Local SQLite Join] Error:', error);
      return {
        success: false,
        message: `Local SQLite join failed: ${error.message}`,
        error: error.stack
      };
    } finally {
      // Step 4: Clean up temp tables (Placed in finally to ensure cleanup even if an error occurs)
      for (const tempTable of tempTablesToCleanup) {
        await new Promise((res) => {
          db.run(`DROP TABLE IF EXISTS ${tempTable}`, (err) => {
            if (err) console.error(`Failed to cleanup ${tempTable}: ${err.message}`);
            res();
          });
        });
      }
      // Connection pool handles db connection, no need to close
    }
  });
}

/** The file a local source is read from, or null when it isn't a local file. */
function localFilePathOf(connection) {
  if (!connection || connection.dbType !== 'duckdb') return null;
  return connection.fileInfo?.filePath || connection.localPath || connection.dbConfig?.dbPath || null;
}

/**
 * An empty relation with the right column names, so a join over a source that
 * returned no rows still resolves instead of failing on an unknown table.
 */
function emptyViewSelect(selectedColumns) {
  const columns = (selectedColumns || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  if (columns.length === 0) return 'SELECT NULL WHERE false';
  const projection = columns.map((c) => `NULL::VARCHAR AS "${String(c).replace(/"/g, '""')}"`).join(', ');
  return `SELECT ${projection} WHERE false`;
}

/**
 * Run a join whose destination is local.
 *
 * Local file sources are registered as views straight over their files, so
 * their rows are never copied into a staging table — the join reads the CSV or
 * Parquet where it sits, and an upstream node's output is already a table in
 * this workflow's database. Only genuinely remote sources are pulled across,
 * and those land in a temporary Parquet file that is deleted afterwards.
 *
 * `joinSql` is a SELECT, and what it produces IS the result: it becomes this
 * node's output table in its workflow's DuckDB database.
 *
 * @returns {Promise<{success, message, localPath, targetTableName, rowCount}>}
 */
async function executeLocalDuckDBJoin({
  sourcesConfig,
  joinSql,
  targetTableName,
  targetLocalPath,
  pluginManager,
  getFullConfig,
  workflowId = null,
  nodeId = null,
}) {
  const duck = require('../duckdb');
  const DuckDB = require('../transfomers/DuckDB');

  const views = [];
  const stagedTables = [];
  const outPath = DuckDB.resolveTargetDb(targetLocalPath, { workflowId, nodeId });

  try {
    if (!joinSql || !String(joinSql).trim()) throw new Error('Join SQL is empty');

    // Counts SOURCES, not views. It used to piggyback on `views.length`, which
    // was one-per-source until a source started registering several names.
    let sourceIndex = 0;
    for (const sourceConfig of sourcesConfig) {
      const name = sourceConfig.tempTableName || sourceConfig.tableName;
      if (!name) continue;
      const stagingIndex = sourceIndex++;

      const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection || {};
      const filePath = localFilePathOf(sourceConnection);
      let body;

      if (DuckDB.isWorkflowDb(filePath)) {
        // An upstream node's output — already a table in this same database.
        const ref = await duck.workflowTableRef(workflowId, sourceConfig.tableName || name);
        body = `SELECT * FROM ${ref}`;
      } else if (filePath) {
        // The point of the whole change: read the file where it is. A workbook
        // holds a table per sheet, and this source's table name is which sheet
        // it means — without that, every sheet of a workbook would join as the
        // first one, quietly and with no error.
        const ref = await duck.tableRef(filePath, sourceConnection.fileInfo?.format || null, {
          sheet: duck.sheetFor(filePath, sourceConfig.tableName),
        });
        body = `SELECT * FROM ${ref}`;
      } else {
        // A source DuckDB can't read where it lies — a remote database, or a
        // vector store. Its rows are pulled through the plugin and staged as a
        // table in this workflow's own database, so the join never leaves
        // DuckDB and nothing is written outside the workflow's file.
        const rows = Array.isArray(sourceConfig._preloadedRows)
          ? sourceConfig._preloadedRows
          : await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);

        if (!rows || rows.length === 0) {
          body = emptyViewSelect(sourceConfig.selectedColumns);
        } else {
          const staged = `join_src_${stagingIndex}_${name}`;
          await duck.ingestRowsToStaging(rows, outPath, staged);
          stagedTables.push(staged);
          body = `SELECT * FROM ${await duck.stagingRef(outPath, staged)}`;
        }
      }

      // `name` is the temp-table alias the generated joinSql addresses. The
      // source's REAL table name and its `<connection>.<table>` form are
      // registered alongside it, so a join written against what the Data
      // Explorer shows resolves too — with several local files in one join,
      // that qualified form is the only way to tell same-named tables apart.
      const realTable = sourceConfig.tableName || sourceConfig.sourceTableSchema?.tableName || null;
      const { created } = await duck.registerAddressableViews({
        body,
        names: [name, realTable],
        // A node output has no connection; it is already reachable as
        // `<workflowAlias>.<table>` through the attach.
        connectionName: DuckDB.isWorkflowDb(filePath)
          ? null
          : connectionNameOf(sourceConnection, filePath),
      });
      views.push(...created);
    }

    // The join result is this node's output: a table in the workflow database.
    const rowCount = await duck.withWorkflowLock(workflowId, async () => {
      await duck.createTableAs(workflowId, targetTableName, joinSql);
      return duck.tableRowCount(workflowId, targetTableName);
    });

    return {
      success: true,
      message: `Join completed — ${rowCount} row(s) written to ${targetTableName}`,
      localPath: outPath,
      targetTableName,
      rowCount,
    };
  } catch (error) {
    console.error('[DuckDB Join] Error:', error);
    return {
      success: false,
      message: `Local join failed: ${error.message}`,
      error: error.stack,
    };
  } finally {
    // `views` holds quoted refs from registerAddressableViews, bare and
    // schema-qualified alike.
    await duck.dropViews(views);
    await duck.dropStaging(outPath, stagedTables);
  }
}

module.exports = {
  loadSourceData,
  loadSQLSourceInChunks,
  insertDataToTempTable,
  executeLocalSQLiteJoin,
  executeLocalDuckDBJoin
};
