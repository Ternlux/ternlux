/**
 * Join Execution Helper Functions
 * Shared utilities for executing join operations
 */

const Datastore = require('@seald-io/nedb');

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
      return result.rows || [];
    }
  } else {
    // Load from SQL source via plugin
    const plugin = pluginManager.getConnector(sourceDbType);
    const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '')
    const result = await plugin.runQuery(fullConfig, sourceConnection.id, { query: sql});
    return result.rows || [];
  }
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
  onChunk
) {
  const sourceDbType = sourceConnection.dbType;

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
    if(!result.success){
      console.log('chunkQuery: ', chunkQuery, result)
    }
    const rows = result.rows || [];

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
  getFullConfig
) {
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(appSqliteDbPath);
  const tempTablesToCleanup = [];

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

      if (isNoSQLSource) {
        sourceData = await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);
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

    // Always close the db connection gracefully
    db.close();
  }
}

module.exports = {
  loadSourceData,
  loadSQLSourceInChunks,
  insertDataToTempTable,
  executeLocalSQLiteJoin
};
