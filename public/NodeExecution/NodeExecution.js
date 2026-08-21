const pluginManager = require('../pluginManager');
const { transformNeDB, saveToLocalNeDB } = require('../transfomers/NeDB');
const Sqlite = require('../transfomers/Sqlite');
const DuckDB = require('../transfomers/DuckDB');
const { loadSourceData, loadSQLSourceInChunks, insertDataToTempTable, executeLocalSQLiteJoin, executeLocalDuckDBJoin } = require('../joins/joinExecutionHelpers');

const VECTOR_DB_TYPES_SET = new Set(['lancedb', 'pinecone']);
const isVectorConnection = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES_SET.has(conn.dbType));

// These will be set by the initialize function
let appSqliteDbPath = null;
let getFullConfig = null;
let sqlitePool = null;
let buildSkillHelpers = null;

/**
 * Initialize the module with required dependencies
 */
function initialize(sqliteDbPath, configGetter, connectionPool, skillHelpersBuilder = null) {
  appSqliteDbPath = sqliteDbPath;
  getFullConfig = configGetter;
  sqlitePool = connectionPool;
  buildSkillHelpers = skillHelpersBuilder;
}

/**
 * Lazy lookup for the vector-db-executor skill. Returns null if not loaded.
 */
function getVectorSkill() {
  return pluginManager.hasSkill && pluginManager.hasSkill('vector-db-executor')
    ? pluginManager.getSkill('vector-db-executor')
    : null;
}

/**
 * Pull rows for a single source, using the vector-db-executor skill when the
 * source is a vector DB; otherwise falling back to the standard
 * loadSourceData helper.
 */
async function pullJoinSourceRows(sourceConnection, sourceConfig) {
  if (!isVectorConnection(sourceConnection)) {
    return await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);
  }

  const skill = getVectorSkill();
  if (!skill || typeof skill.fetchVectorSourceRecords !== 'function') {
    throw new Error('vector-db-executor skill not available; cannot pull rows from vector source');
  }

  // The vector table name can live in any of these places depending on
  // whether the source was authored by the AI or wired through a saved local
  // connection. LanceDB connections in particular keep it on
  // connection.dbConfig.tableName, which the previous fallback chain missed
  // and caused `openTable(undefined)` to throw with `StringExpected`.
  const tableName =
    sourceConfig.sourceTableSchema?.tableName
    || sourceConfig.tableName
    || sourceConnection.dbConfig?.tableName
    || sourceConnection.indexName;
  if (!tableName) {
    throw new Error(
      `Vector source ${sourceConfig.sourceNodeId || ''}: no tableName/indexName found on sourceConfig or connection.dbConfig`
    );
  }
  const indexName =
    sourceConfig.indexName
    || sourceConnection.indexName
    || sourceConnection.dbConfig?.indexName
    || tableName;
  const namespace =
    sourceConfig.namespace
    || sourceConnection.namespace
    || sourceConnection.dbConfig?.namespace
    || '';

  const helpers = buildSkillHelpers ? await buildSkillHelpers() : {};
  return await skill.fetchVectorSourceRecords({
    sourceConnection,
    sourceTableSchema: sourceConfig.sourceTableSchema || { tableName, indexName, namespace },
    vectorFetchOperation: sourceConfig.vectorFetchOperation || {},
    pluginManager,
    getFullConfig,
    helpers
  });
}

/**
 * Build a `ctx` object passed to the AI-generated join `javascriptFunction`
 * (NoSQL / vector destinations). Mirrors the surface area of
 * skills/javascript-executor's sandbox so prompts can describe a single
 * helper API across both skills.
 */
function buildJoinCtx(helpers) {
  if (!helpers) return null;
  return {
    connections: (helpers.connections || []).map((c) => ({
      id: c.id || c._id,
      name: c.name,
      dbType: c.dbType,
      dbCategory: c.dbCategory
    })),
    aiProviders: helpers.aiProviders || [],
    embeddingProviders: helpers.embeddingProviders || [],
    // Unified data access: pass `dbPath` to hit a local nedb/sqlite/lancedb
    // file; leave it null for saved connections.
    runQuery:    (connection, query, dbPath = null)             => helpers.runQuery(connection, query, dbPath),
    getTables:   (connection, dbPath = null)                    => helpers.getTables(connection, dbPath),
    getColumns:  (connection, table, schema = null, dbPath = null) => helpers.getColumns(connection, table, schema, dbPath),
    askAi:       (prompt, opts = {})       => helpers.callAI(prompt, opts),
    vectorize:   (texts, opts = {})        => helpers.vectorize(texts, opts),
    axios: helpers.axios,
    log: (...args) => console.log('[join-fn]', ...args)
  };
}

/**
 * Quote table identifier with optional schema using the plugin's quoteIdentifier method
 */
function quoteTableIdentifier(dbType, tableName, schema, config) {
  if (!tableName) return tableName;

  // Check if a plugin exists for this database type
  if (pluginManager.hasConnector(dbType)) {
    const connector = pluginManager.getConnector(dbType);

    if (typeof connector.quoteIdentifier === 'function') {
      return connector.quoteIdentifier(tableName, schema, config);
    }
  }

  // Fallback: return with schema if provided
  return schema ? `${schema}.${tableName}` : tableName;
}

// SQL transformation handler implementation
async function handleTransformSQL({
    dbType,
    config,
    connectionId,
    ddl,
    sql,
    previewSql,
    storageLocation,
    operationMode,
    targetSchema,
    targetTableName,
    sourceLocalPath = null,
    insertSql = null,
    targetLocalPath = null,
    sourceFormat = null,
    workflowId = null,
    nodeId = null
  }) {
    try {
      console.log('handleTransformSQL', {
        dbType,
        config,
        connectionId,
        ddl,
        sql,
        previewSql,
        storageLocation,
        operationMode,
        targetSchema,
        targetTableName,
        sourceLocalPath,
        targetLocalPath,
        insertSql
      })

      // LOCAL — the node's output is a table in its workflow's DuckDB database.
      // The source is read where it lies (a file, or an upstream node's table
      // in the same database). `in_place` runs the model's ALTER/UPDATE/DELETE
      // against the table; anything else replaces it from the SELECT.
      if (dbType === 'duckdb') {
        const params = {
          sourceLocalPath,
          sql,
          targetTableName,
          targetLocalPath,
          // What the source is called when it is another node's output — the
          // name the model's `FROM …` refers to.
          sourceTableName: config?.sourceTableName || config?.sourceTableSchema?.tableName || null,
          sourceFormat,
          // The source is ALSO registered under this connection's own schema,
          // so `FROM <connection>.<table>` — the form the Data Explorer's tree
          // displays — resolves at run time as well as the bare name.
          connectionName: config?.sourceConnectionName || null,
          workflowId,
          nodeId,
        };
        return operationMode === 'in_place'
          ? DuckDB.inPlaceLocalUpdate(params)
          : DuckDB.createLocalTable(params);
      }

      // LOCAL SQL (legacy SQLite imports)
      if(dbType === 'sqlite'){
        if (operationMode === 'in_place') {
          // For SQLite in-place operations, execute DDL (ALTER TABLE) and/or UPDATE/DELETE on the app database
          return Sqlite.inPlaceLocalUpdate(appSqliteDbPath, ddl, sql, targetTableName, sqlitePool)
        } else {
          // For SQLite new table operations, create table and execute INSERT
          return Sqlite.createLocalTable(appSqliteDbPath, ddl, sql, targetTableName, sqlitePool)
        }
      } else {
        // DATABASE TYPES
        if (operationMode === 'in_place') {
          // Execute DDL (ALTER TABLE) and/or UPDATE/DELETE directly on the database
          const fullConfig = await getFullConfig(connectionId, config);
  
          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported`
            };
          }
  
          const plugin = pluginManager.getConnector(dbType);
          let ddlRowCount = 0;
          let sqlRowCount = 0;
          let messages = [];
          // Execute DDL first if it exists (ALTER TABLE operations)
          if (ddl) {
            const ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
            if (!ddlResult.success) {
              return {
                success: false,
                message: `DDL execution failed: ${ddlResult.message}`
              };
            }
            ddlRowCount = ddlResult.rowCount || 0;
            messages.push(`DDL executed successfully`);
          }

          // Execute SQL (UPDATE/DELETE) if it exists
          if (sql) {
            const sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
            console.log('sqlResult: ', sqlResult)
            if (!sqlResult.success) {
              return {
                success: false,
                message: `SQL execution failed: ${sqlResult.message}`
              };
            }
            sqlRowCount = sqlResult.rowCount || 0;
            messages.push(`${sqlRowCount} rows modified`);
          }
  
          return {
            success: true,
            message: messages.length > 0 ? messages.join('. ') : 'Operation completed successfully',
            rowCount: sqlRowCount // For UPDATE/DELETE row count
          };
        }else if(storageLocation === 'database'){
        // Execute DDL + INSERT directly in the database
          // This works for all SQL databases with plugin connectors
          const fullConfig = await getFullConfig(connectionId, config);
  
          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported. No plugin connector available.`
            };
          }
  
          const plugin = pluginManager.getConnector(dbType);

          // Drop existing table if it exists
          if (targetTableName) {
            // console.log('dbType, targetTableName, targetSchema: ', dbType, targetTableName, targetSchema, )
            const quotedTableName = quoteTableIdentifier(dbType, targetTableName, targetSchema, fullConfig);
            const dropQuery = `DROP TABLE IF EXISTS ${quotedTableName}`;
            await plugin.runQuery(fullConfig, connectionId, { query: dropQuery });
          }
          // console.log("ddl: ", ddl)
          // Execute DDL
          let ddlResult = {};
          if(ddl){
            
            ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
            console.log('ddlResult: ', ddlResult)

            if (!ddlResult.success) {
              return {
                success: false,
                message: `DDL execution failed: ${ddlResult.message}`
              };
            }
          }
          let sqlResult = {};
          if(sql){
            // Execute INSERT
            sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
            console.log('sqlResult: ', sqlResult)

            if (!sqlResult.success) {
              return {
                success: false,
                message: `SQL execution failed: ${sqlResult.message}`
              };
            }
          }

  
          // Success - return result
          return {
            success: true,
            message: `Table created and ${sqlResult.rowCount || 0} rows inserted`,
            rowCount: sqlResult.rowCount || 0
          };
  
        } else if (storageLocation === 'local') {
          // Pull data from a remote database into this node's table in the
          // workflow database. The SELECT has to run on the source through its
          // own plugin — DuckDB can't reach a Postgres table — so rows are
          // streamed across and written here.
          const fullConfig = await getFullConfig(connectionId, config);

          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported. Cannot pull data to local storage.`
            };
          }

          const plugin = pluginManager.getConnector(dbType);
          return DuckDB.databaseToLocal({
            fullConfig,
            plugin,
            connectionId,
            sql,
            targetTableName,
            targetLocalPath,
            workflowId,
            nodeId,
          });
        }
  
  
      }
  
      // Unknown storage location
      return {
        success: false,
        message: `Invalid settings location: ${storageLocation}. Must be 'database' or 'local'.`
      };
  
  
    } catch (error) {
      console.error('[dbconn:transform-sql]', error);
      return {
        success: false,
        message: `Transformation failed: ${error.message}`,
        error: error.stack
      };
    }
  }


  // NoSQL transformation handler implementation
async function handleTransformNoSQL({
    dbType,
    config,
    connectionId,
    sourceLocalPath,
    sourceCollection,
    targetCollection,
    targetLocalPath = null,
    operationType,
    nosqlOperation,
    transformFunction,
    storageLocation,
    operationMode,
    // Optional scope for the local NeDB fallback path (see saveToLocalNeDB).
    workflowId = null,
    nodeId = null
  }) {
    // console.log('[handleTransformNoSQL] input', JSON.stringify({
    //   dbType,
    //   connectionId,
    //   sourceLocalPath,
    //   sourceCollection,
    //   targetCollection,
    //   operationType,
    //   storageLocation,
    //   operationMode
    // }));
    try {
      // NoSQL now means a remote document store. Local files — JSON included —
      // are read as SQL by DuckDB and go through handleTransformSQL, so a
      // local target arriving here is a stale config from before the switch.
      if (dbType === 'nedb') {
        console.warn('[handleTransformNoSQL] nedb target is legacy; local transforms now run on DuckDB');
        return await transformNeDB({
          sourceLocalPath,
          targetCollection,
          targetLocalPath,
          operationType,
          nosqlOperation,
          transformFunction,
          operationMode
        });

      } else if (pluginManager.hasConnector(dbType)) {
        // Use NoSQL plugin for transformation (MongoDB, etc.)
        const fullConfig = await getFullConfig(connectionId, config);
  
        const plugin = pluginManager.getConnector(dbType);
        if (!plugin || !plugin.transformData) {
          return {
            success: false,
            message: `${dbType} plugin not found or does not support transformations`
          };
        }
  
        const result = await plugin.transformData(fullConfig, connectionId, {
          sourceCollection,
          targetCollection,
          operationType,
          nosqlOperation,
          transformFunction,
          storageLocation,
          operationMode
        });
  
        // The plugin aggregated remotely and handed back documents to land
        // locally. They go where every other node output goes: a table in this
        // workflow's own DuckDB database. They used to become a NeDB file,
        // which nothing downstream reads any more — the preview, joins and
        // output nodes all address a node's result as a DuckDB table.
        if (result.needsLocalStorage && result.transformedDocs) {
          const docs = Array.isArray(result.transformedDocs)
            ? result.transformedDocs
            : [result.transformedDocs];
          if (docs.length === 0) {
            return { success: true, message: 'Transformation produced no documents', recordCount: 0 };
          }

          const duck = require('../duckdb');
          const table = targetCollection || `transform_${String(nodeId || Date.now()).replace(/[^A-Za-z0-9_]/g, '_')}`;
          // `mode` mirrors what the NeDB path meant by operationMode: a new
          // table replaces, anything else adds to what is already there.
          const mode = operationMode === 'new_table' ? 'replace' : 'append';

          const { rowCount } = targetLocalPath && !workflowId
            ? await duck.ingestRowsToTableAt(docs, targetLocalPath, table, { mode })
            : await duck.ingestRowsToTable(docs, workflowId, table, { mode });

          return {
            success: true,
            message: `Saved ${rowCount} document(s) to ${table}`,
            recordCount: rowCount,
            documentsInserted: rowCount,
            totalProcessed: result.totalProcessed || rowCount,
            localPath: workflowId ? duck.workflowDbPath(workflowId) : targetLocalPath,
            targetTableName: table,
          };
        }
  
        return result;
  
      } else {
        return {
          success: false,
          message: `Unsupported database type: ${dbType}. Only 'mongodb' and 'nedb' are supported.`
        };
      }
  
    } catch (error) {
      return {
        success: false,
        message: `Transformation failed: ${error.message}`,
        error: error.stack
      };
    }
  }

  /**
 * Execute Join Operation
 * Handles joining multiple data sources with SQL or NoSQL destinations
 */
async function handleExecuteJoin({
    destinationConnection,
    joinConfig,
    operationMode = 'new_table',
    // Optional — used only to place a local NeDB result under
    // local-collections/<workflowId>/<nodeId>.db. Absent for ad-hoc runs.
    workflowId = null,
    nodeId = null
  }) {
    try {
      const CHUNK_SIZE = 1000;
      const isVectorDestination = isVectorConnection(destinationConnection);
      // NoSQL means a remote document store. A local destination is DuckDB and
      // takes the SQL path, whatever the shape of the data.
      const isNoSQL = destinationConnection.dbType === 'mongodb';
      const targetTableName = joinConfig.targetTableName || joinConfig.targetCollection;

      console.log(`[Join] Starting ${isVectorDestination ? 'Vector' : (isNoSQL ? 'NoSQL' : 'SQL')} join operation`);
      console.log(`[Join] Destination: ${destinationConnection.dbType}, Mode: ${operationMode}`);

      // ===== VECTOR DESTINATION =====
      // Pull every source into memory (vector sources go through the skill),
      // run the AI's joinFunction, then hand the joined rows to the skill for
      // embedding + upsert into the vector destination.
      if (isVectorDestination) {
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const javascriptFunction = joinConfig.transformFunction || joinConfig.javascriptFunction;
        console.log('javascriptFunction: ', javascriptFunction)
        if (!javascriptFunction) {
          return { success: false, message: 'Vector destination requires a javascriptFunction (joined rows)' };
        }

        const vectorDest = joinConfig.vectorDestination || {};
        if (!vectorDest.columnToEmbed || !vectorDest.embeddingProvider || !vectorDest.embeddingModel) {
          return {
            success: false,
            message: 'Vector destination missing required fields: columnToEmbed, embeddingProvider, embeddingModel'
          };
        }

        const sourceDataArrays = [];
        for (const sourceConfig of sourcesConfig) {
          const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
          if (!sourceConnection) {
            throw new Error(`Source connection not found for ${sourceConfig.sourceNodeId}`);
          }
          const rows = await pullJoinSourceRows(sourceConnection, sourceConfig);
          console.log(`[Vector Join] Loaded ${rows.length} rows from ${sourceConfig.sourceNodeId}`);
          sourceDataArrays.push(rows);
        }

        const ctxHelpersForVec = buildSkillHelpers ? await buildSkillHelpers() : null;
        const ctxForVec = buildJoinCtx(ctxHelpersForVec);
        const joinFn = eval(`(${javascriptFunction})`);
        const joinedRows = await joinFn(...sourceDataArrays, ctxForVec);
        if (!Array.isArray(joinedRows)) {
          throw new Error('joinFunction must return an array of joined records');
        }
        console.log(`[Vector Join] Join produced ${joinedRows.length} rows`);

        const skill = getVectorSkill();
        if (!skill || typeof skill.embedAndUpsertJoinedRows !== 'function') {
          return { success: false, message: 'vector-db-executor skill not available' };
        }
        const helpers = buildSkillHelpers ? await buildSkillHelpers() : {};

        const result = await skill.embedAndUpsertJoinedRows({
          joinedRows,
          columnToEmbed: vectorDest.columnToEmbed,
          vectorDbType: vectorDest.vectorDbType || destinationConnection.dbType,
          targetTable: vectorDest.targetTable || targetTableName,
          targetLocalPath: vectorDest.targetLocalPath || destinationConnection.localPath,
          targetConnectionId: vectorDest.targetConnectionId || destinationConnection.id,
          indexName: vectorDest.indexName,
          namespace: vectorDest.namespace || '',
          embeddingProvider: vectorDest.embeddingProvider,
          embeddingModel: vectorDest.embeddingModel,
          embeddingApiKey: vectorDest.embeddingApiKey,
          pluginManager,
          getFullConfig,
          helpers
        });

        return {
          success: !!result?.success,
          message: result?.message,
          recordCount: result?.recordCount || 0,
          targetTableName: vectorDest.targetTable || targetTableName,
          localPath: result?.targetLocalPath
        };
      }
  
      if (isNoSQL) {
        // ===== NoSQL JOIN: Load data into memory, run JavaScript function, insert to destination =====
  
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const javascriptFunction = joinConfig.transformFunction || joinConfig.javascriptFunction;
        const sourceDataArrays = [];
  
        // Step 1: Load all source data into memory
        console.log(`[NoSQL Join] Loading ${sourcesConfig.length} sources into memory...`);
  
        for (let i = 0; i < sourcesConfig.length; i++) {
          const sourceConfig = sourcesConfig[i];
          const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
  
          if (!sourceConnection) {
            throw new Error(`Source connection not found for ${sourceConfig.sourceNodeId}`);
          }

          const sourceData = await pullJoinSourceRows(sourceConnection, sourceConfig);

          console.log(`[NoSQL Join] Loaded ${sourceData.length} rows from source ${i + 1}`);
          sourceDataArrays.push(sourceData);
        }
  
        // Step 2: Execute JavaScript join function
        console.log(`[NoSQL Join] Executing join function...`);
        const ctxHelpersForNoSQL = buildSkillHelpers ? await buildSkillHelpers() : null;
        const ctxForNoSQL = buildJoinCtx(ctxHelpersForNoSQL);
        const joinFunction = eval(`(${javascriptFunction})`);
        const joinedResults = await joinFunction(...sourceDataArrays, ctxForNoSQL);
  
        console.log(`Join_produced:`, destinationConnection);
  
        // Step 3: Insert into the destination document store
        {
          if (!pluginManager.hasConnector(destinationConnection.dbType)) {
            return {
              success: false,
              message: `Database type ${destinationConnection.dbType} is not supported`
            };
          }
  
          const fullConfig = await getFullConfig(destinationConnection.id, destinationConnection.dbConfig || {});
          const plugin = pluginManager.getConnector(destinationConnection.dbType);
  
          if (operationMode === 'new_table') {
            // Drop existing collection
            try {
              await plugin.runQuery(fullConfig, destinationConnection.id, {
                operation: 'drop',
                collection: targetTableName
              });
            } catch (err) {
              // Collection might not exist
            }
          }
  
          // Insert documents
          const insertResult = await plugin.runQuery(fullConfig, destinationConnection.id, {
            operation: 'insertMany',
            collection: targetTableName,
            documents: joinedResults
          });
  
          return {
            success: true,
            message: `Successfully inserted ${joinedResults.length} documents into ${targetTableName}`,
            documentsInserted: joinedResults.length
          };
        }
  
      } else {
        // ===== SQL JOIN: Create temp tables, load data, execute join SQL =====
  
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const targetDdl = joinConfig.targetDdl || joinConfig.ddl;
        const joinSql = joinConfig.joinSql || joinConfig.sql;
        const tempTablesToCleanup = [];
  
        // A local destination writes this node's own table in the workflow's
        // DuckDB database.
        const isLocalDestination = destinationConnection.dbType === 'duckdb';
        // console.log('sourcesConfig: ', joinSql, targetDdl, sourcesConfig)
        if (isLocalDestination) {
          // Vector sources have no SQL surface, so resolve their rows via the
          // skill first; the join then sees them like any other source.
          for (const sc of sourcesConfig) {
            const sconn = sc.connection || sc.sourceConnection;
            if (isVectorConnection(sconn)) {
              sc._preloadedRows = await pullJoinSourceRows(sconn, sc);
              console.log(`[DuckDB Join] Pre-loaded ${sc._preloadedRows.length} vector rows for ${sc.sourceNodeId}`);
            }
          }

          // ===== LOCAL DUCKDB JOIN =====
          return await executeLocalDuckDBJoin({
            sourcesConfig,
            joinSql,
            targetTableName,
            targetLocalPath: joinConfig.targetLocalPath,
            pluginManager,
            getFullConfig,
            workflowId,
            nodeId,
          });
        }
  
        // ===== REMOTE DATABASE JOIN =====
  
        // Get destination connection
        if (!pluginManager.hasConnector(destinationConnection.dbType)) {
          return {
            success: false,
            message: `Database type ${destinationConnection.dbType} is not supported`
          };
        }
  
        const destFullConfig = await getFullConfig(destinationConnection.id, destinationConnection.dbConfig || {});
        const destPlugin = pluginManager.getConnector(destinationConnection.dbType);
  
  
        // Step 1: Create temp tables and load source data
        for (let i = 0; i < sourcesConfig.length; i++) {
          const sourceConfig = sourcesConfig[i];
  
          // Skip sources that don't need temp tables (already in destination)
          if (!sourceConfig.ddl || !sourceConfig.tempTableName) {
            console.log(`exists: `, sourceConfig);
            continue;
          }
          console.log(`SOURCE_CONFIG: `, sourceConfig);
  
          const tempTableName = sourceConfig.tempTableName;
          tempTablesToCleanup.push(tempTableName);
  
          console.log(`TEMP_TABLE: ${tempTableName}`);
  
          // Drop temp table if exists (from previous failed runs)
          try {
            const schema = joinConfig.targetSchema || destFullConfig?.dbConfig?.schema || null;
            const quotedTempTableName = quoteTableIdentifier(destinationConnection.dbType, tempTableName, schema, destFullConfig);
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTempTableName}`});
          } catch (err) {
            // Ignore errors if table doesn't exist
            console.log(`Ignoring drop table error for ${tempTableName}: ${err.message}`);
          }
  
          // Create temp table
          await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: sourceConfig.ddl});
  
          // Load data from source
          const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
          const isNoSQLSource = ['mongodb', 'nedb'].includes(sourceConnection.dbType);
          const isVectorSource = isVectorConnection(sourceConnection);

          // Get selectedColumns from sourceConfig
          const selectedColumns = sourceConfig.selectedColumns;
          if (!selectedColumns || selectedColumns.length === 0) {
            throw new Error(`No selectedColumns found for source ${sourceConfig.sourceNodeId}`);
          }

          let totalInserted = 0;

          if (isNoSQLSource || isVectorSource) {
            // NoSQL or Vector source: Load all data into memory, then batch
            // insert into the temp table. Vector rows are flattened by the
            // skill so metadata fields appear as top-level columns.
            const sourceData = await pullJoinSourceRows(sourceConnection, sourceConfig);
            totalInserted = await insertDataToTempTable(
              destPlugin,
              destFullConfig,
              destinationConnection.id,
              tempTableName,
              selectedColumns,
              sourceData,
              CHUNK_SIZE
            );
  
            console.log(`SQL_LOADED: ${totalInserted}/${sourceData.length}`);
  
          } else {
            // SQL source: Stream data in chunks
            // console.log(`[SQL Join] Loading SQL source ${i + 1}...`);

            totalInserted = await loadSQLSourceInChunks(
              sourceConnection,
              sourceConfig.sql,
              CHUNK_SIZE,
              pluginManager,
              getFullConfig,
              async (rows) => {
                await insertDataToTempTable(
                  destPlugin,
                  destFullConfig,
                  destinationConnection.id,
                  tempTableName,
                  selectedColumns,
                  rows,
                  rows.length // Don't re-chunk, already chunked by loadSQLSourceInChunks
                );
              },
              // Lets a local DuckDB source be resolved by path instead of
              // through the connector, which cannot open one.
              sourceConfig
            );

            console.log(`[SQL Join] Loaded ${totalInserted} rows from SQL source`);
          }
  
          console.log(`[SQL Join] Finished loading source ${i + 1}: ${totalInserted} total rows`);
        }
  
        // Step 2: Create target table if needed
        if (operationMode === 'new_table' && targetDdl) {
          console.log(`join_new_table ${targetTableName}...`);
  
          // Drop target table if exists (for clean re-runs)
          try {
            const schema = destinationConnection.targetSchema || destFullConfig?.dbConfig?.schema || null;
            const quotedTargetTableName = quoteTableIdentifier(destinationConnection.dbType, targetTableName, schema, destFullConfig);
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTargetTableName}`});
          } catch (err) {
            console.log('destPlugin_drop_table_error: ', err)
            // Ignore errors if table doesn't exist
          }
  
          await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: targetDdl});
        }
  
        // Step 3: Execute join query
        console.log(`join_execute_main_query: `, joinSql);
        const joinResult = await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: joinSql});
        const rowsAffected = joinResult.rowCount || joinResult.affectedRows || 0;
  
        // Step 4: Clean up temp tables
        console.log(`join_drop_temp_table: `, tempTablesToCleanup);
        for (const tempTable of tempTablesToCleanup) {
          try {
            const schema = joinConfig.targetSchema || destFullConfig?.dbConfig?.schema || null;
            const quotedTempTable = quoteTableIdentifier(destinationConnection.dbType, tempTable, schema, destFullConfig);
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTempTable}`});
          } catch (err) {
            console.error(`Failed to cleanup ${tempTable}:`, err);
          }
        }
  
        return {
          success: true,
          message: `Join completed successfully. ${rowsAffected} rows inserted into ${targetTableName}`,
          rowsAffected,
          targetTableName
        };
      }
  
    } catch (error) {
      console.error('Join execution error:', error);
      return {
        success: false,
        message: `Join execution failed: ${error.message}`,
        error: error.stack
      };
    }
  }

/**
 * Execute a branch validation plan.
 *
 * Input:
 *   sources: Array<{
 *     sourceNodeId, sourceNodeLabel, sourceNodeType,
 *     connection: { id, dbType, dbConfig, connectionType, localPath },
 *     tableName
 *   }>
 *   steps: Array<{
 *     stepNumber, sourceNodeId, description,
 *     sql?: string (must contain {LIMIT_OFFSET_HERE}),
 *     nosqlOperation?: string (JSON string),
 *     selectedColumns?: string[]
 *   }>
 *   validationFunction: string — a JS function expression
 *     `function(stepResults) { ... return boolean; }`
 *   outputRoutes: { "true": string, "false": string }
 *
 * Output:
 *   { success: true, result: boolean, route: string,
 *     stepResults: { [stepNumber]: { rows: Array<Object>, count: number } } }
 *   or { success: false, error: string, stepResults? }
 */
async function handleExecuteBranch({
  sources,
  steps,
  validationFunction,
  outputRoutes,
}) {
  const stepResults = {};
  try {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { success: false, error: 'No steps to execute' };
    }
    if (typeof validationFunction !== 'string' || !validationFunction.trim()) {
      return { success: false, error: 'Missing validation function' };
    }

    const sourceById = new Map();
    for (const src of sources || []) {
      if (src && src.sourceNodeId) sourceById.set(src.sourceNodeId, src);
    }

    for (const step of steps) {
      const stepNumber = step.stepNumber;
      const source = sourceById.get(step.sourceNodeId);
      if (!source) {
        return {
          success: false,
          error: `Step ${stepNumber}: unknown sourceNodeId "${step.sourceNodeId}"`,
          stepResults,
        };
      }

      const sourceConnection = source.connection || {};
      // loadSourceData reads either nosqlOperation or sql from the step config
      const stepConfig = {
        sql: step.sql,
        nosqlOperation: step.nosqlOperation,
      };

      let rows = [];
      try {
        const dbType = sourceConnection.dbType;
        if (dbType === 'sqlite') {
          // Local SQLite: run against the app sqlite DB via the pool.
          if (!sqlitePool) {
            throw new Error('Local SQLite pool is not initialized');
          }
          const rawSql = (step.sql || '').replace('{LIMIT_OFFSET_HERE}', '');
          if (!rawSql.trim()) {
            throw new Error('SQLite step requires a "sql" query');
          }
          rows = await sqlitePool.all(rawSql, []);
        } else {
          rows = await loadSourceData(
            sourceConnection,
            stepConfig,
            pluginManager,
            getFullConfig
          );
        }
      } catch (err) {
        return {
          success: false,
          error: `Step ${stepNumber} failed: ${err.message}`,
          stepResults,
        };
      }

      const safeRows = Array.isArray(rows) ? rows : [];
      stepResults[stepNumber] = {
        rows: safeRows,
        count: safeRows.length,
      };
    }

    // Evaluate the validation function in a sandboxed-ish Function scope.
    let validationResult = false;
    try {
      const evalFn = new Function(
        'stepResults',
        `try { var fn = (${validationFunction}); return !!fn(stepResults); } catch (e) { throw e; }`
      );
      validationResult = Boolean(evalFn(stepResults));
    } catch (err) {
      return {
        success: false,
        error: `Validation function error: ${err.message}`,
        stepResults,
      };
    }

    const route = (outputRoutes && outputRoutes[String(validationResult)])
      || (validationResult ? 'valid' : 'invalid');

    return {
      success: true,
      result: validationResult,
      route,
      stepResults,
    };
  } catch (err) {
    console.error('[handleExecuteBranch] error:', err);
    return {
      success: false,
      error: err.message || 'Branch execution failed',
      stepResults,
    };
  }
}

module.exports = {
  initialize,
  handleTransformSQL,
  handleTransformNoSQL,
  handleExecuteJoin,
  handleExecuteBranch
};