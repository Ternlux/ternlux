const pluginManager = require('../pluginManager');
const DuckDB = require('../transfomers/DuckDB');
const { loadSourceData, loadSQLSourceInChunks, insertDataToTempTable, executeLocalDuckDBJoin } = require('../joins/joinExecutionHelpers');
const localSqlite = require('../lib/sqlite');
const { batchChunkSizeFor, DEFAULT_BATCH_CHUNK_SIZE } = require('../lib/batchChunkSize');
const { logStep, traceCall } = require('./executionLog');
const { isCancelledError } = require('./executionCancel');

const VECTOR_DB_TYPES_SET = new Set(['lancedb', 'pinecone']);
const isVectorConnection = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES_SET.has(conn.dbType));

// These will be set by the initialize function
let appSqliteDbPath = null;
let getFullConfig = null;
let buildSkillHelpers = null;

/**
 * Initialize the module with required dependencies
 */
function initialize(sqliteDbPath, configGetter, skillHelpersBuilder = null) {
  appSqliteDbPath = sqliteDbPath;
  getFullConfig = configGetter;
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
    // MERGED, not `sourceConfig.sourceTableSchema || {…}`. The skill reads the
    // index coordinates off this object (joinHandler: `sourceTableSchema.indexName
    // || sourceConnection.indexName`), so the `||` meant that any source with a
    // real schema — i.e. every source in a built workflow — silently discarded
    // the indexName and namespace resolved just above, and Pinecone failed with
    // "Index name is required". The fallback only ever fired for a source that
    // had no schema at all.
    sourceTableSchema: {
      ...(sourceConfig.sourceTableSchema || {}),
      tableName: sourceConfig.sourceTableSchema?.tableName || tableName,
      indexName,
      namespace,
    },
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
    // Unified data access: pass `dbPath` to hit a local duckdb/sqlite/lancedb
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

/**
 * Run one statement on a join's DESTINATION and fail if it did not run.
 *
 * A connector reports a failed statement by RETURNING { success: false, message }
 * rather than by throwing — the mysql/postgres/mssql runQuery all catch the
 * driver error themselves. An unchecked call therefore carries on as though the
 * statement had worked, and the real error is discarded. Both ways that went
 * wrong were reported as something else entirely, several steps later:
 *
 *   - a failed CREATE TABLE surfaced as "Table 'database.temp_x' doesn't exist"
 *     from the INSERT after it, hiding the DDL error that actually happened
 *     (MySQL rejecting a bare VARCHAR, which requires a length);
 *   - a failed join INSERT…SELECT returned "Join completed successfully.
 *     0 rows inserted", because rowsAffected simply defaulted to 0.
 *
 * The statement's own message is the only thing that names the problem, so it
 * travels with the failure.
 */
async function runDestStatement(plugin, fullConfig, connectionId, query, what) {
  const result = await plugin.runQuery(fullConfig, connectionId, { query });
  if (result && result.success === false) {
    throw new Error(`${what} failed: ${result.message || 'unknown error'}`);
  }
  return result;
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
    // What the source is CALLED. Passed explicitly by the caller, like every
    // other field here — it used to be dug out of `config`, which is the target
    // DATABASE config (credentials, dbPath) and has never carried it. That read
    // silently produced null on every run, and the DuckDB path then fell back to
    // the target table name and had the node read its own unwritten output.
    sourceTableName = null,
    sourceConnectionName = null,
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
      // Which branch a transform takes is the first thing worth knowing when it
      // writes to somewhere unexpected — the routing rules below are subtle
      // (see isSqlSourceToLocal in workflowExecutionHelpers), and until now the
      // decision existed only as a console.log in the main process.
      logStep('info', `SQL transform routing: dbType=${dbType}, mode=${operationMode || 'replace'}`, {
        kind: 'transform',
        dbType,
        operationMode: operationMode || null,
        storageLocation: storageLocation || null,
        targetTable: targetTableName || null,
        sourceTable: sourceTableName || null,
      });

      if (dbType === 'duckdb') {
        const params = {
          sourceLocalPath,
          sql,
          targetTableName,
          targetLocalPath,
          // What the source is called when it is another node's output — the
          // name the model's `FROM …` refers to.
          sourceTableName,
          sourceFormat,
          // The source is ALSO registered under this connection's own schema,
          // so `FROM <connection>.<table>` — the form the Data Explorer's tree
          // displays — resolves at run time as well as the bare name.
          connectionName: sourceConnectionName,
          workflowId,
          nodeId,
        };
        const duckLabel = operationMode === 'in_place'
          ? 'duckdb.inPlaceLocalUpdate'
          : 'duckdb.createLocalTable';
        return traceCall(
          { kind: 'duckdb', label: duckLabel, sql, detail: { targetTable: targetTableName } },
          () => (operationMode === 'in_place'
            ? DuckDB.inPlaceLocalUpdate(params)
            : DuckDB.createLocalTable(params)),
        );
      }

      // A transform whose TARGET is SQLite is a node saved before local results
      // moved to DuckDB: it wrote into the app's shared SQLite database, a store
      // nothing writes to any more. Rebuilding the node repoints it at DuckDB,
      // which is a one-step fix — so say that rather than failing later with a
      // missing table.
      if (dbType === 'sqlite') {
        logStep('error', 'Transform target is the retired local SQLite store', {
          kind: 'transform', targetTable: targetTableName || null,
        });
        return {
          success: false,
          message:
            `This transform writes to "${targetTableName || 'a local SQLite table'}" in the app's `
            + 'shared SQLite database, which is no longer written to — local results are DuckDB now. '
            + 'Open the node and regenerate it to repoint it at local DuckDB storage.',
        };
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
          let sqlRowCount = 0;
          const messages = [];

          // The DDL runs first, and whether ITS failure fails the node depends
          // on whether there is DML behind it.
          //
          // DDL ALONE is the whole node. Nothing else was going to happen, so a
          // failure there is the node's failure and is reported as it stands.
          //
          // DDL + DML is the "add a column, then populate it" pair, and there a
          // failing DDL is routine rather than fatal: the SECOND run of an
          // ADD COLUMN reports "column already exists" precisely because the
          // first run worked. Failing the node on that would make every
          // in-place ALTER a one-shot — MySQL, SQL Server and Redshift have no
          // `ADD COLUMN IF NOT EXISTS` to write instead, so the statement
          // cannot be made rerunnable in SQL. So the DML decides the verdict:
          // it succeeds and the node succeeded, with the DDL's error carried on
          // the result rather than swallowed; it fails and both errors are
          // reported together, since the DDL's is usually the one that explains
          // the DML's ("no such column" behind "could not add column").
          let ddlError = null;
          if (ddl) {
            logStep('info', `Running DDL on ${dbType}`, { kind: 'transform', phase: 'ddl', sql: ddl });
            const ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
            if (ddlResult.success) {
              messages.push('DDL executed successfully');
              logStep('info', 'DDL executed successfully', { kind: 'transform', phase: 'ddl' });
            } else if (!sql) {
              // DDL alone was the whole node, so its failure is the node's.
              logStep('error', `DDL execution failed: ${ddlResult.message}`, {
                kind: 'transform', phase: 'ddl', sql: ddl,
              });
              return {
                success: false,
                message: `DDL execution failed: ${ddlResult.message}`
              };
            } else {
              ddlError = ddlResult.message;
              // Not fatal — see the note above on why a failing ADD COLUMN is
              // routine on a rerun — but it is the thing a user hunting a
              // missing column needs to see, and until now it reached them only
              // as a clause tacked onto the node's success message.
              logStep('warn', `DDL did not apply: ${ddlResult.message}. Continuing — the DML behind it decides this node.`, {
                kind: 'transform', phase: 'ddl', sql: ddl,
              });
            }
          }

          // Execute SQL (UPDATE/DELETE) if it exists
          if (sql) {
            logStep('info', `Running DML on ${dbType}`, { kind: 'transform', phase: 'dml', sql });
            const sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
            console.log('sqlResult: ', sqlResult)
            if (!sqlResult.success) {
              logStep('error', `SQL execution failed: ${sqlResult.message}`, {
                kind: 'transform', phase: 'dml', sql,
                ...(ddlError ? { precedingDdlError: ddlError } : {}),
              });
              return {
                success: false,
                message: ddlError
                  ? `SQL execution failed: ${sqlResult.message}. The DDL before it also failed: ${ddlError}`
                  : `SQL execution failed: ${sqlResult.message}`
              };
            }
            sqlRowCount = sqlResult.rowCount || 0;
            messages.push(`${sqlRowCount} rows modified`);
            logStep('info', `${sqlRowCount} rows modified`, {
              kind: 'transform', phase: 'dml', rowCount: sqlRowCount,
            });
          }

          return {
            success: true,
            // A DDL that failed while the DML went through is not a failure, but
            // it is not nothing either — a rerun's duplicate column and a real
            // schema problem look identical from here. Flagged so the run shows
            // amber and the message says what was skipped.
            warning: !!ddlError,
            message: ddlError
              ? `${messages.join('. ') || 'Operation completed'}. DDL did not apply: ${ddlError}`
              : (messages.length > 0 ? messages.join('. ') : 'Operation completed successfully'),
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
          //
          // Fatal here, unlike the in-place branch above. A new table's DDL is
          // the CREATE that the DROP immediately before it just made necessary,
          // so a failure means the target does not exist — and letting the
          // INSERT run anyway would either fail for a second reason or, worse,
          // succeed against a stale table left over from an earlier shape and
          // report rows written into the wrong place.
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

  
          // Success - return result.
          //
          // A DDL-only node reaching here is one saved BEFORE the connector
          // prompts required a separate INSERT: its ddl is a CREATE ... AS
          // SELECT, which fills the table in the same statement, so there is no
          // row count to report. Saying "0 rows inserted" reads as a node that
          // did nothing, which is the opposite of what happened. New builds
          // always carry both statements — see the completeness gate in
          // workflowBuilder.assembleTransformerConfig.
          const ranInsert = !!(sql && String(sql).trim());
          return {
            success: true,
            message: ranInsert
              ? `Table created and ${sqlResult.rowCount || 0} rows inserted`
              : 'Table created and populated in a single statement',
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
      // A stop must reach the runner as an exception — see executeOutput.
      if (isCancelledError(error)) throw error;
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
    // Optional scope for the local DuckDB table the aggregated docs land in.
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
      // NoSQL means a remote document store. Local files — JSON included —
      // are read as SQL by DuckDB and go through handleTransformSQL, so nothing
      // local arrives here at all.
      if (pluginManager.hasConnector(dbType)) {
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
        // workflow's own DuckDB database. They used to become a local file
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
          // `mode` mirrors what the old local path meant by operationMode: a new
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
          message: `Unsupported database type: ${dbType}. Only 'mongodb' is supported.`
        };
      }
  
    } catch (error) {
      // A stop must reach the runner as an exception rather than a failed
      // transform — see executeOutput's catch in outputExecutionHelpers.
      if (isCancelledError(error)) throw error;
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
    // Optional — used only to scope a local result to this run's own workflow
    // database. Absent for ad-hoc runs.
    workflowId = null,
    nodeId = null
  }) {
    try {
      // Rows per source read AND per temp-table batchInsert on the remote-join
      // path below. It was 1000, which made staging a large source thousands of
      // LIMIT/OFFSET round trips and thousands of inserts — the round trips,
      // not the rows, were the minutes. Shared default with the output node so
      // the two write paths do not drift; see public/lib/batchChunkSize.js.
      const CHUNK_SIZE = DEFAULT_BATCH_CHUNK_SIZE;
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
  
          // A join function is user- or AI-authored and may return anything.
          const documents = Array.isArray(joinedResults) ? joinedResults : [];

          // Strip `_id` for the same reason the output node does (see
          // outputExecutionHelpers): it names a document within its OWN
          // collection. A join function that returns source documents rather
          // than freshly-built objects would write another collection's ids
          // into the target — and two Mongo sources contributing rows can
          // collide with EACH OTHER on `_id` even in a brand-new collection,
          // failing the whole batch with E11000.
          //
          // In place, no rebuild: these objects were produced by the join
          // function for this insert and nothing else holds them. Most join
          // functions build fresh objects with no `_id` at all, in which case
          // the `in` check is all this costs.
          for (const doc of documents) {
            if (doc !== null && typeof doc === 'object' && '_id' in doc) delete doc._id;
          }

          // A join that matched nothing is not a failure of this node. What it
          // MEANS for the destination depends on the mode, and the two answers
          // are opposites:
          //
          //  · 'new_table' REPLACES the target every run. Replacing it with
          //    nothing means the target ends up EMPTY. Leaving last run's rows
          //    in place is not caution, it is staleness — a staging collection
          //    that the join reported as "no new records" still handed the
          //    downstream output node the PREVIOUS run's rows, which it then
          //    re-appended to the destination.
          //  · any other mode adds to what is there, so an empty result adds
          //    nothing and the target is correctly left alone.
          //
          // Either way insertMany is skipped rather than called with [] — the
          // driver rejects an empty batch outright.
          const isEmpty = documents.length === 0;

          if (isEmpty && operationMode !== 'new_table') {
            console.warn(`[NoSQL Join] Join matched no records — ${targetTableName} left unchanged`);
            return {
              success: true,
              warning: true,
              message: `No rows to write: the join matched no records, so ${targetTableName} was left unchanged.`,
              documentsInserted: 0,
            };
          }

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

          if (isEmpty) {
            // 'new_table' with nothing to write: the drop above already made the
            // target reflect this run. Downstream reads an empty collection,
            // which is the honest answer, rather than last run's rows.
            console.warn(`[NoSQL Join] Join matched no records — ${targetTableName} replaced with an empty collection`);
            return {
              success: true,
              warning: true,
              message: `No rows to write: the join matched no records, so ${targetTableName} is now empty.`,
              documentsInserted: 0,
            };
          }

          // Insert documents
          const insertResult = await plugin.runQuery(fullConfig, destinationConnection.id, {
            operation: 'insertMany',
            collection: targetTableName,
            documents
          });
  
          // A connector reports a failed statement by RETURNING
          // { success: false }, not by throwing — the MongoDB runQuery catches
          // the driver error itself. This result used to be assigned and then
          // discarded, so a write that never landed was reported as a
          // successful load of however many rows we had HOPED to write, and
          // the whole run went green on top of it.
          if (!insertResult || insertResult.success === false) {
            return {
              success: false,
              message: `Could not write to ${targetTableName}: ${insertResult?.message || 'unknown error'}`,
            };
          }

          // What the destination says it took, not what it was handed.
          const inserted = insertResult.insertedCount
            ?? insertResult.rowCount
            ?? documents.length;

          return {
            success: true,
            message: `Successfully inserted ${inserted} documents into ${targetTableName}`,
            documentsInserted: inserted
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

        // On the streaming path below, the SOURCE read size decides the
        // destination write size: every batch pulled from the source becomes
        // one batchInsert. So a destination that rations calls rather than
        // statement size — BigQuery spends a daily load-job quota — has to be
        // able to widen the read. See public/lib/batchChunkSize.js.
        const LOAD_CHUNK_SIZE = batchChunkSizeFor(destPlugin, CHUNK_SIZE);

  
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

          // One quoted form for every statement built HERE — the DROP below and
          // the cleanup at the end — so both name the same table that
          // `sourceConfig.ddl` creates. Quoted, because that DDL is: PostgreSQL
          // keeps a capital in a quoted name and folds it away in a bare one,
          // and the two forms are then different tables. (The load in between
          // goes through batchInsert, which takes the name UNQUOTED and quotes
          // it itself — see outputExecutionHelpers' note at its own call.)
          //
          // No schema, because the DDL is unqualified: the table lands wherever
          // the connection's own search path (or default database/dataset) puts
          // it, and naming a schema here could point somewhere else. The
          // connector's quoteIdentifier still qualifies where a bare name would
          // otherwise be ambiguous to it — MySQL with the connection's
          // database, BigQuery with its dataset.
          const quotedTempTableName = quoteTableIdentifier(
            destinationConnection.dbType, tempTableName, null, destFullConfig,
          );
          tempTablesToCleanup.push(quotedTempTableName);

          console.log(`TEMP_TABLE: ${tempTableName} -> ${quotedTempTableName}`);

          // Drop temp table if exists (from previous failed runs)
          try {
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTempTableName}`});
          } catch (err) {
            // Ignore errors if table doesn't exist
            console.log(`Ignoring drop table error for ${tempTableName}: ${err.message}`);
          }
  
          // Create temp table. Checked: a DDL that fails here leaves nothing for
          // the load below to write into, and the "table doesn't exist" it then
          // raises names neither the statement nor the reason.
          await runDestStatement(
            destPlugin, destFullConfig, destinationConnection.id,
            sourceConfig.ddl, `Creating temp table ${tempTableName}`,
          );
  
          // Load data from source
          const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
          const isNoSQLSource = sourceConnection.dbType === 'mongodb';
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
              LOAD_CHUNK_SIZE
            );
  
            console.log(`SQL_LOADED: ${totalInserted}/${sourceData.length}`);
  
          } else {
            // SQL source: Stream data in chunks
            // console.log(`[SQL Join] Loading SQL source ${i + 1}...`);

            totalInserted = await loadSQLSourceInChunks(
              sourceConnection,
              sourceConfig.sql,
              LOAD_CHUNK_SIZE,
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
  
          await runDestStatement(
            destPlugin, destFullConfig, destinationConnection.id,
            targetDdl, `Creating target table ${targetTableName}`,
          );
        }
  
        // Step 3: Execute join query
        console.log(`join_execute_main_query: `, joinSql);
        // Checked: rowsAffected falls back to 0, so an unchecked failure here
        // was reported as "Join completed successfully. 0 rows inserted" — a
        // node that wrote nothing, and said so as though that were the answer.
        const joinResult = await runDestStatement(
          destPlugin, destFullConfig, destinationConnection.id, joinSql, 'Join query',
        );
        const rowsAffected = joinResult.rowCount || joinResult.affectedRows || 0;
  
        // Step 4: Clean up temp tables
        console.log(`join_drop_temp_table: `, tempTablesToCleanup);
        // Already quoted when the table was named, by the same call the CREATE
        // and the load went through — re-quoting it here would only be the
        // idempotent guard handing it back.
        for (const tempTable of tempTablesToCleanup) {
          try {
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${tempTable}`});
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
      // A stop must reach the runner as an exception — see executeOutput.
      //
      // Note the temp tables: the cleanup above is on the success path only, so
      // a stop leaves them behind exactly as a failure already does. They are
      // reclaimed by the DROP TABLE IF EXISTS the next run issues before
      // recreating each one, so this leaks nothing permanently.
      if (isCancelledError(error)) throw error;
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
          // A SQLite source is a FILE, read by path. This used to go through the
          // app's shared SQLite pool, which could only ever reach app-data.db —
          // so a step against a .sqlite the user picked themselves silently ran
          // against the wrong database. Same lib and same path resolution the
          // join reader uses.
          const dbPath = sourceConnection.fileInfo?.filePath
            || sourceConnection.localPath
            || sourceConnection.dbConfig?.dbPath
            || null;
          if (!dbPath) {
            throw new Error(`No local SQLite path for source ${sourceConnection.id || '(unknown)'}`);
          }
          const rawSql = (step.sql || '').replace('{LIMIT_OFFSET_HERE}', '');
          if (!rawSql.trim()) {
            throw new Error('SQLite step requires a "sql" query');
          }
          rows = await localSqlite.runQuery({ dbPath, query: rawSql });
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