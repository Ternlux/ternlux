/**
 * Workflow Execution Helpers
 * Handles execution of different node types in a workflow
 */

const path = require('path');
const fs = require('fs');
const { handleTransformNoSQL, handleTransformSQL, handleExecuteJoin, handleExecuteBranch } = require('./NodeExecution');
const { handleExecuteApiFetch } = require('./ApiFetch');
const { executeOutput } = require('./outputExecutionHelpers');
const { importParquetToSqlite, importAvroToSqlite, importSpreadsheetToSqlite, importCsvToSqlite } = require('../imports/importHelpers');

/**
 * Detect a node that was placed on the canvas but never configured (empty or
 * near-empty config). Such a node would otherwise fail deep in execution with a
 * vague message like "Database type not configured". Returns a clear per-node
 * error result when unconfigured, or null when the node has real configuration.
 *
 * `kind` selects which fields count as "configured" for that node type.
 */
function checkNodeConfigured(node, kind) {
  const config = node?.data?.config || {};
  const label = node?.data?.label || node?.id || 'Node';
  const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  let configured = false;
  switch (kind) {
    case 'transformer':
      configured = (config.usesSkill && config.skillId)
        || nonEmpty(config.targetSql)
        || nonEmpty(config.targetInsertSql)
        || nonEmpty(config.nosqlOperation)
        || nonEmpty(config.transformFunction)
        || nonEmpty(config.operation)
        || nonEmpty(config.targetDbType);
      break;
    case 'join':
      configured = (config.usesSkill && config.skillId)
        || nonEmpty(config.skillId)
        || nonEmpty(config.joinSql)
        || nonEmpty(config.targetSql)
        || nonEmpty(config.transformFunction)
        || nonEmpty(config.javascriptFunction);
      break;
    case 'output':
      configured = nonEmpty(config.outputType)
        || nonEmpty(config.outputFormat)
        || nonEmpty(config.destinationType)
        || nonEmpty(config.targetConnectionId)
        || !!config.outputSettings;
      break;
    default:
      configured = Object.keys(config).length > 0;
  }

  if (configured) return null;
  return {
    success: false,
    message: `Node "${label}" is not configured. Open it and complete its setup before running the workflow.`,
    recordsProcessed: 0,
  };
}

/**
 * Helper function to add a log entry to an execution
 */
async function addExecutionLog(executionsDb, executionId, level, message, nodeId = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    nodeId
  };

  await executionsDb.updateAsync(
    { executionId },
    { $push: { logs: logEntry } },
    {}
  );
}

/**
 * Get source local path for NeDB or local SQLite operations
 */
function getSourceLocalPath(targetNode, nodeMap, edges) {
  const sourceEdge = edges.find(e => e.target === targetNode.id);
  if (!sourceEdge) return null;

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode?.data?.config) return null;

  const sourceConfig = sourceNode.data.config;

  return sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
}

  /**
   * Helper function to get original file path from connection
   * @param {String} sourceConnectionId - Connection ID
   * @param {String} dbType - Database type (sqlite or nedb)
   * @returns {Promise<String|null>} Original file path or null
   */
  const getOriginalFilePath = async (sourceConnectionId, dbType, getDb) => {
    if (!sourceConnectionId) {
      return null;
    }

    // Only applicable for local file types
    if (!['duckdb', 'sqlite', 'nedb'].includes(dbType)) {
      return null;
    }

    try {
      // Get connections database
      const connectionsDb = await getDb('connections');

      // Find the connection record
      const connection = await connectionsDb.findOneAsync({ id: sourceConnectionId });
      console.log('connection: ', connection, sourceConnectionId, dbType)
      if (!connection) {
        console.warn(`[executeDataSourceNode] Connection not found: ${sourceConnectionId}`);
        return null;
      }

      // Get localPath from connection
      const localPath = connection?.fileInfo?.sourceFilePath || connection?.fileInfo?.filePath;

      if (localPath) {
        console.log(`[executeDataSourceNode] Found original file path for ${dbType}: ${localPath}`);
        return localPath;
      }

      console.warn(`[executeDataSourceNode] No local path found in connection ${sourceConnectionId}`);
      return null;
    } catch (error) {
      console.error(`[executeDataSourceNode] Error getting file path from connection:`, error);
      return null;
    }
  };

/**
 * Execute a Data Source node
 * Imports local files or Google Sheets
 */
async function executeDataSourceNode(node, helpers) {
  const { pluginManager, getFullConfig, getDb, appSqliteDbPath, sqlitePool } = helpers;

  console.log(`[Workflow Execution] Executing Data Source node: ${node.id}`);

  // Data source nodes can have local file imports or cloud data sources
  const config = node.data?.config;
  // console.log('node: ', node)

  if (!config) {
    return {
      success: false,
      message: 'Data source configuration not found',
      recordsProcessed: 0
    };
  }


  const sourceConnectionId = config.sourceConnectionId;
  console.log('config: ', config)
  // REST API source: re-execute the saved fetch function and re-populate the
  // local NeDB collection the downstream nodes already point at.
  if (config.sourceConnectionType === 'api' && config.apiFetchCode) {
    try {
      console.log('[Workflow Execution] REST API source — re-running fetch function');
      const collection = config.sourceCollection ||
        String(node.id).replace(/[^a-z0-9]+/gi, '_').toLowerCase() ||
        'api_response';

      const fetchResult = await handleExecuteApiFetch({
        apiConnectionId: config.sourceApiConnectionId,
        apiConnectionConfig: config.apiConnectionPublicConfig || {},
        apiFetchCode: config.apiFetchCode,
        nedbCollection: collection,
        operationMode: 'new_table',
        workflowId: helpers?.workflowId || null,
        nodeId: node.id,
      });

      if (!fetchResult.success) {
        return {
          success: false,
          message: `REST API fetch failed: ${fetchResult.error || 'unknown error'}`,
          recordsProcessed: 0,
        };
      }

      return {
        success: true,
        message: `REST API fetch completed: ${fetchResult.rowCount || 0} rows into ${collection}`,
        recordsProcessed: fetchResult.rowCount || 0,
      };
    } catch (err) {
      console.error('[Workflow Execution] REST API source error:', err);
      return { success: false, message: err.message || 'REST API source failed', recordsProcessed: 0 };
    }
  }

  // Check if it's a cloud storage file that needs to be re-downloaded and imported
  if (config.cloudSource) {
    try {
      console.log('[Workflow Execution] Cloud storage file detected, downloading and importing...');

      const { connectionId, dbType, containerName, objectKey, objectName, sheetName } = config.cloudSource;

      // Get the cloud storage connection config
      const cloudConnection = await getFullConfig(connectionId);
      if (!cloudConnection) {
        return {
          success: false,
          message: `Cloud storage connection not found: ${connectionId}`,
          recordsProcessed: 0
        };
      }

      // Get the connector plugin
      const plugin = pluginManager.getConnector(dbType);
      if (!plugin || !plugin.downloadObject) {
        return {
          success: false,
          message: `Cloud storage connector not available for: ${dbType}`,
          recordsProcessed: 0
        };
      }

      // Download the file from cloud storage
      console.log(`[Workflow Execution] Downloading from ${dbType}: ${containerName}/${objectKey}`);
      // console.log('cloudConnection: ', cloudConnection)
      const downloadResult = await plugin.downloadObject(
        cloudConnection,
        connectionId,
        containerName,
        objectKey
      );

      if (!downloadResult.success) {
        return {
          success: false,
          message: `Failed to download file: ${downloadResult.message}`,
          recordsProcessed: 0
        };
      }

      
      const fileExt = path.extname(objectName).toLowerCase();

      let fileType;
      if (['.csv'].includes(fileExt)) {
        fileType = 'spreadsheet';
      } else if (['.xlsx', '.xls'].includes(fileExt)) {
        fileType = 'spreadsheet';
      } else if (['.json'].includes(fileExt)) {
        fileType = 'json';
      } else if (['.parquet'].includes(fileExt)) {
        fileType = 'parquet';
      } else if (['.avro'].includes(fileExt)) {
        fileType = 'avro';
      }

      if (!fileType) {
        return {
          success: false,
          message: `Unsupported file type: ${fileExt}`,
          recordsProcessed: 0
        };
      }

      // Import the file to local storage
      const tableName = config.sourceTableName || config.sourceCollection || config.sourceTableSchema?.tableName;
      
      if (fileType === 'spreadsheet' || fileType === 'parquet' || fileType === 'avro') {
        // Import to SQLite
        if (!sqlitePool) {
          throw new Error('SQLite connection pool not available');
        }

        // Prepare sheets array for Excel files
        // If sheetName is specified in cloudSource, only import that sheet
        const sheets = sheetName ? [sheetName] : [];

        const importResult = await sqlitePool.executeWrite(async (db) => {
          if (fileType === 'parquet') {
            // Save buffer to temp file for parquet parser
            const tempPath = path.join(require('electron').app.getPath('temp'), objectName);
            fs.writeFileSync(tempPath, Buffer.from(downloadResult.data));
            const result = await importParquetToSqlite(tempPath, tableName, db, appSqliteDbPath);
            fs.unlinkSync(tempPath);
            return result;
          } else if (fileType === 'avro') {
            // Save buffer to temp file for avro parser
            const tempPath = path.join(require('electron').app.getPath('temp'), objectName);
            fs.writeFileSync(tempPath, Buffer.from(downloadResult.data));
            const result = await importAvroToSqlite(tempPath, tableName, db, appSqliteDbPath);
            fs.unlinkSync(tempPath);
            return result;
          } else if (['.xlsx', '.xls'].includes(fileExt)) {
            // Save buffer to temp file for spreadsheet parser
            const tempPath = path.join(require('electron').app.getPath('temp'), objectName);
            fs.writeFileSync(tempPath, Buffer.from(downloadResult.data));
            const connectionName = sheetName ? tableName.replace(`_${sheetName}`, '') : tableName;
            console.log('tableName, sheets: ', connectionName, tableName, sheets)
            // Pass sheets array: empty = import all sheets, specific = import only those
            const result = await importSpreadsheetToSqlite(tempPath, connectionName, db, appSqliteDbPath, sheets);
            fs.unlinkSync(tempPath);
            return result;
          } else if (fileExt === '.csv') {
            // Save buffer to temp file for CSV parser
            const tempPath = path.join(require('electron').app.getPath('temp'), objectName);
            fs.writeFileSync(tempPath, Buffer.from(downloadResult.data));
            const result = await importCsvToSqlite(tempPath, tableName, db, appSqliteDbPath);
            fs.unlinkSync(tempPath);
            return result;
          }
        });

        if (importResult.success) {
          return {
            success: true,
            message: `Successfully imported ${importResult.rowCount || 0} rows from cloud storage`,
            recordsProcessed: importResult.rowCount || 0
          };
        } else {
          return {
            success: false,
            message: importResult.message || 'Cloud storage import failed',
            recordsProcessed: 0
          };
        }
      } else if (fileType === 'json') {
        // Import to NeDB
        const collectionName = config.sourceCollection || config.sourceTableSchema?.tableName;
        const dbPath = config.sourceLocalPath;

        // Parse JSON
        const jsonContent = Buffer.from(downloadResult.data).toString('utf8');
        let documents;
        try {
          const parsed = JSON.parse(jsonContent);
          documents = Array.isArray(parsed) ? parsed : [parsed];
        } catch (parseErr) {
          return {
            success: false,
            message: `Invalid JSON format: ${parseErr.message}`,
            recordsProcessed: 0
          };
        }

        if (documents.length === 0) {
          return {
            success: false,
            message: 'No documents found in JSON file',
            recordsProcessed: 0
          };
        }

        // Create NeDB datastore
        const Datastore = require('@seald-io/nedb');
        const db = new Datastore({ filename: dbPath, autoload: true });

        // Remove all existing documents first
        await new Promise((resolve) => {
          db.remove({}, { multi: true }, (err, numRemoved) => {
            if (err) {
              console.warn(`[Workflow Execution] Could not clear NeDB collection:`, err);
            } else {
              console.log(`[Workflow Execution] Cleared ${numRemoved} existing documents from collection`);
            }
            resolve();
          });
        });

        db.persistence.compactDatafile();

        // Insert documents
        const insertResult = await new Promise((resolve) => {
          db.insert(documents, (err, newDocs) => {
            if (err) {
              resolve({
                success: false,
                message: `Failed to insert documents: ${err.message}`
              });
            } else {
              resolve({
                success: true,
                docCount: newDocs.length
              });
            }
          });
        });

        if (insertResult.success) {
          return {
            success: true,
            message: `Successfully imported ${insertResult.docCount} documents from cloud storage`,
            recordsProcessed: insertResult.docCount
          };
        } else {
          return {
            success: false,
            message: insertResult.message,
            recordsProcessed: 0
          };
        }
      }
    } catch (error) {
      console.error('[Workflow Execution] Cloud storage import error:', error);
      return {
        success: false,
        message: error.message,
        recordsProcessed: 0
      };
    }
  }

  const filePath = await getOriginalFilePath(sourceConnectionId, config.sourceDbType, getDb)
  console.log("sourceFilePath: ", filePath)

  // A local file source has nothing to execute. It used to be re-imported into
  // SQLite or NeDB on every run — reading the whole file and rewriting a copy
  // of it before the workflow could touch a single row. DuckDB reads the file
  // in place when a downstream node queries it, so this step only has to
  // confirm the file is still there and report how big it is.
  if (config.sourceDbType === 'duckdb') {
    const localPath = config.sourceFilePath || config.sourceLocalPath || filePath;
    if (!localPath) {
      return { success: false, message: 'No file path recorded for this data source', recordsProcessed: 0 };
    }
    if (!fs.existsSync(localPath)) {
      return {
        success: false,
        message: `Source file no longer exists: ${localPath}`,
        recordsProcessed: 0,
      };
    }
    try {
      const duck = require('../duckdb');
      // A workflow database holds the source as a TABLE (an upstream node's
      // output); a data file is counted where it lies.
      const isDb = /\.duckdb$/i.test(localPath);
      const sourceTable = config.sourceTableName || config.sourceTableSchema?.tableName;
      if (isDb && !sourceTable) {
        return { success: false, message: 'No table recorded for this data source', recordsProcessed: 0 };
      }
      const rowCount = isDb
        ? await duck.tableRowCountAt(localPath, sourceTable)
        : await duck.countRows(localPath, config.sourceFormat || null);
      return {
        success: true,
        message: isDb
          ? `${sourceTable} ready — ${rowCount} row(s)`
          : `${path.basename(localPath)} ready — ${rowCount} row(s), read in place`,
        recordsProcessed: rowCount,
      };
    } catch (error) {
      return {
        success: false,
        message: `Cannot read ${path.basename(localPath)}: ${error.message}`,
        recordsProcessed: 0,
      };
    }
  }

  // Check if it's a Google Sheets import
  if (config.dbType === 'google-sheets' && config.spreadsheetId) {
    try {
      const plugin = pluginManager.getConnector('google-sheets');
      if (!plugin) {
        return {
          success: false,
          message: 'Google Sheets plugin not found',
          recordsProcessed: 0
        };
      }

      const connectionId = config.connectionId;
      const fullConfig = await getFullConfig(connectionId);

      if (!fullConfig) {
        return {
          success: false,
          message: 'Google Sheets connection not found',
          recordsProcessed: 0
        };
      }

      // Import Google Sheet to SQLite using connection pool
      if (!sqlitePool) {
        throw new Error('SQLite connection pool not available');
      }

      const tableName = config.tableName || config.sourceTableSchema?.tableName || 'imported_sheet';

      // Use the plugin's import function with connection pool
      const importResult = await sqlitePool.executeWrite(async (db) => {
        // Note: Drop table logic is handled within the plugin's importToSqlite function
        return await plugin.importToSqlite(
          fullConfig.dbConfig,
          connectionId,
          config.spreadsheetId,
          config.sheetName,
          tableName,
          db,
          appSqliteDbPath
        );
      });

      if (importResult.success) {
        return {
          success: true,
          message: `Successfully imported ${importResult.rowCount || 0} rows from Google Sheets`,
          recordsProcessed: importResult.rowCount || 0
        };
      } else {
        return {
          success: false,
          message: importResult.message || 'Google Sheets import failed',
          recordsProcessed: 0
        };
      }
    } catch (error) {
      console.error('[Workflow Execution] Google Sheets import error:', error);
      return {
        success: false,
        message: error.message,
        recordsProcessed: 0
      };
    }
  }

  // For other data sources, just validate that the configuration exists
  return {
    success: true,
    message: 'Data source validated',
    recordsProcessed: config.recordCount || 0
  };
}

/**
 * Execute a Transformer node
 * Calls the transformation handlers directly
 */
async function executeTransformerNode(node, nodeMap, edges, helpers) {
  console.log(`[Workflow Execution] Executing Transformer node: ${node.id}`);

  const config = node.data?.config;
  // console.log('config: ', config)
  if (!config) {
    return {
      success: false,
      message: 'Transformation configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured transformer up front with a clear, node-named
  // message instead of failing later with "Database type not configured".
  const notConfigured = checkNodeConfigured(node, 'transformer');
  if (notConfigured) return notConfigured;

  // Find source node
  const sourceEdge = edges.find(e => e.target === node.id);
  if (!sourceEdge) {
    return {
      success: false,
      message: 'No source connection found for transformer',
      recordsProcessed: 0
    };
  }

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode) {
    return {
      success: false,
      message: 'Source node not found',
      recordsProcessed: 0
    };
  }

  try {
    // Check if this transformation uses a skill
    if (config.usesSkill && config.skillId) {
      console.log(`[Workflow Execution] Executing skill transformation: ${config.skillId}`);

      // Get source connection info
      const rawSourceConfig = sourceNode.data?.config || {};
      let sourceConnection = rawSourceConfig.connection || rawSourceConfig;
      // Datasource node configs store fields with a `source*` prefix
      // (sourceDbType, sourceLocalPath, sourceConnectionId, ...) while skills
      // read the canonical un-prefixed names. Map both shapes so the skill
      // sees a uniform sourceConnection regardless of which node produced it.
      sourceConnection = {
        ...sourceConnection,
        id: sourceConnection.id || sourceConnection.sourceConnectionId,
        name: sourceConnection.name || sourceConnection.sourceConnectionName,
        dbType: sourceConnection.dbType || sourceConnection.sourceDbType,
        dbConfig: sourceConnection.dbConfig || sourceConnection.sourceDbConfig,
        dbCategory: sourceConnection.dbCategory || sourceConnection.sourceDbCategory,
        connectionType: sourceConnection.connectionType || sourceConnection.sourceConnectionType,
        localPath: sourceConnection.localPath
          || sourceConnection.sourceLocalPath
          || sourceConnection.targetLocalPath
      };
      const sourceTableSchema = sourceNode.data?.config?.targetTableSchema || sourceNode.data?.config?.sourceTableSchema;

      // Determine operation type
      const isNoSQL = ['mongodb', 'nedb'].includes(sourceConnection?.dbType);
      const operationType = isNoSQL ? 'nosql' : 'sql';

      // Get source schema
      const sourceSchema = sourceNode.data?.config?.targetSchema || sourceNode.data?.config?.sourceSchema;
      const sourceNodeConfig = sourceNode.data?.config;

      // For LanceDB, ensure localPath is included in sourceConnection
      if (sourceConnection?.dbType === 'lancedb') {
        sourceConnection = {
          ...sourceConnection,
          localPath: sourceConnection.localPath ||
                     sourceNodeConfig?.targetLocalPath ||
                     sourceNodeConfig?.sourceLocalPath ||
                     sourceNodeConfig?.targetDbConfig?.dbPath
        };
      }

      // Build the same helpers bundle the IPC layer would inject so skills
      // (javascript-executor, vector-db-executor, ...) receive params.helpers.
      const skillHelpers = typeof helpers.buildSkillHelpers === 'function'
        ? await helpers.buildSkillHelpers()
        : null;

      // Mirror the `skills:execute` IPC shim: vector-db-executor still reads
      // embeddingApiKey from top-level params, but stored configs don't carry
      // the key. Resolve it from the same apiKeys bundle the chat path uses.
      let resolvedEmbeddingKey = config.embeddingApiKey;
      if (config.skillId === 'vector-db-executor' && !resolvedEmbeddingKey && config.embeddingProvider && skillHelpers?.apiKeys) {
        if (config.embeddingProvider === 'openai') {
          resolvedEmbeddingKey = skillHelpers.apiKeys.chatgpt;
        } else if (config.embeddingProvider === 'huggingface') {
          resolvedEmbeddingKey = skillHelpers.apiKeys.huggingface;
        }
      }

      // Execute the skill
      const skillResult = await helpers.pluginManager.executeSkill(config.skillId, {
        helpers: skillHelpers,
        // Source information
        sourceConnection: sourceConnection,
        sourceTableSchema: {
          tableName: sourceTableSchema?.tableName,
          originalTableName: sourceTableSchema?.tableName,
          indexName: sourceTableSchema?.indexName || sourceConnection?.indexName,
          columns: sourceTableSchema?.columns,
          sampleData: sourceTableSchema?.sampleData,
          sheetName: sourceTableSchema?.sheetName,
          schema: sourceSchema,
          namespace: sourceTableSchema?.namespace || sourceSchema,
          localPath: sourceTableSchema?.localPath || sourceNodeConfig?.targetLocalPath || sourceNodeConfig?.sourceLocalPath
        },

        // Operation type and settings
        operationType,
        storageLocation: config.transformationSettings?.storageLocation || config.storageLocation,
        operationMode: config.transformationSettings?.operationMode || config.operationMode,

        // Target information
        targetLocalPath: config.targetLocalPath || sourceNodeConfig?.targetLocalPath || sourceNodeConfig?.sourceLocalPath,
        targetTable: config.targetTableName || config.targetCollection,
        targetConnectionId: config.targetConnectionId,
        targetConnectionName: sourceConnection?.name,

        // Vector DB specific parameters
        vectorDbType: config.targetDbType || config.skillExecution?.vectorDbType,
        operation: config.skillExecution?.operation,
        namespace: config.namespace || sourceTableSchema?.namespace || sourceSchema,
        indexName: config.indexName || sourceTableSchema?.indexName || sourceConnection?.indexName,

        // Embedding parameters
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        embeddingApiKey: resolvedEmbeddingKey,
        columnToEmbed: config.columnToEmbed,

        // Query parameters
        queryText: config.queryText,
        queryVector: config.queryVector,
        topK: config.topK,
        filter: config.filter,
        useEmbeddingSearch: config.useEmbeddingSearch,
        searchQuery: config.searchQuery,

        // Transformation function parameters
        transformFunction: config.transformFunction,
        initialState: config.initialState,

        // Pinecone/LanceDB specific configs
        pineconeConfig: config.pineconeConfig,
        lancedbConfig: config.lancedbConfig,

        // Node context
        nodeId: node.id,
        sourceNodeId: sourceNode?.id,
        sourceNodeLabel: sourceNode?.data?.label,
        sourceNodeConfig: sourceNodeConfig,
        sourceConnectionName: sourceConnection?.name,
        sourceConnectionType: sourceConnection?.connectionType,

        // System dependencies
        pluginManager: helpers.pluginManager,
        getFullConfig: helpers.getFullConfig,
        appSqliteDbPath: helpers.appSqliteDbPath,
        sqlitePool: helpers.sqlitePool,

        // Spread any additional skill params last (allows overrides)
        ...config.skillParams
      });

      if (!skillResult.success) {
        return {
          success: false,
          message: skillResult.error || skillResult.message || 'Skill execution failed',
          recordsProcessed: 0
        };
      }

      return {
        success: true,
        message: skillResult.message || 'Skill transformation completed',
        recordsProcessed: skillResult.recordCount || 0
      };
    }

    const dbType = config.targetDbType || config.dbType;
    const sourceDbType = config.sourceDbType || config.sourceType;

    if (!dbType) {
      return {
        success: false,
        message: `Node "${node.data?.label || node.id}" is not fully configured (no target database). Open it and complete its setup before running.`,
        recordsProcessed: 0
      };
    }

    // Get source local path if needed (for NeDB or local SQLite operations)
    const isNeDB = dbType === 'nedb';
    const isLocalStorage = config.transformationSettings?.storageLocation === 'local';
    const isInPlace = config.transformationSettings?.operationMode === 'in_place';

    // Cross-database NoSQL case: the source is MongoDB but the destination is a
    // local NeDB file (target dbType "nedb" / storageLocation "local"). The read
    // and aggregation must run against MongoDB; the resulting documents are then
    // persisted to local NeDB by handleTransformNoSQL via saveToLocalNeDB.
    // Routing off the *target* dbType alone would mistakenly try to open a local
    // NeDB source file that does not exist ("Source NeDB file not found").
    const isMongoSourceToLocal =
      sourceDbType === 'mongodb' && dbType !== 'mongodb' && (isNeDB || isLocalStorage);

    // Diagnostic: the exact inputs that drive transformer routing. If the
    // running main process predates the isMongoSourceToLocal guard, this line
    // will be ABSENT from the logs even though the code above has it — that
    // absence is itself the signal that Electron needs a restart.
    // console.log('[Transformer Routing]', JSON.stringify({
    //   nodeId: node.id,
    //   label: node.data?.label,
    //   sourceNodeId: config.sourceNodeId,
    //   dbType,                         // target db (config.targetDbType || config.dbType)
    //   sourceDbType,                   // source db (config.sourceDbType || config.sourceType)
    //   storageLocation: config.transformationSettings?.storageLocation,
    //   operationMode: config.transformationSettings?.operationMode,
    //   operationType: config.operationType,
    //   sourceCollection: config.sourceCollection,
    //   targetCollection: config.targetCollection,
    //   sourceConnectionId: config.sourceConnectionId,
    //   targetConnectionId: config.targetConnectionId,
    //   targetLocalPath: config.targetLocalPath,
    //   flags: { isNeDB, isLocalStorage, isInPlace, isMongoSourceToLocal },
    //   route: isMongoSourceToLocal
    //     ? 'mongo-source-to-local (handleTransformNoSQL dbType=mongodb)'
    //     : (['mongodb', 'nedb'].includes(dbType)
    //         ? `nosql (handleTransformNoSQL dbType=${dbType})`
    //         : 'sql (handleTransformSQL)')
    // }, null, 2));

    if (isMongoSourceToLocal) {
      console.log('[Transformer Routing] -> mongo-source-to-local: aggregating on MongoDB, writing result to local NeDB');
      const result = await handleTransformNoSQL({
        dbType: 'mongodb',
        config: config.sourceDbConfig || config.dbConfig,
        connectionId: config.sourceConnectionId || config.connectionId,
        sourceLocalPath: null,
        sourceCollection: config.sourceCollection,
        targetCollection: config.targetCollection,
        targetLocalPath: config.targetLocalPath,
        operationType: config.operationType,
        nosqlOperation: config.nosqlOperation,
        transformFunction: config.transformFunction,
        storageLocation: 'local',
        operationMode: config.transformationSettings?.operationMode
      });

      return {
        success: result.success,
        message: result.message || (result.success ? 'NoSQL transformation completed' : 'NoSQL transformation failed'),
        recordsProcessed: result.recordCount || result.modifiedCount
          || result.documentsInserted || result.documentsProcessed || 0
      };
    }

    // Cross-database SQL case: the source is a remote SQL database (MSSQL,
    // Postgres, MySQL, …) but the destination is local SQLite (target dbType
    // "sqlite" / storageLocation "local"). The transform SELECT must run on the
    // *source* via its plugin; the rows are then written to local SQLite with
    // ddl/insertSql by Sqlite.databaseToLocal. Routing off the target dbType
    // would run the source SELECT (e.g. "FROM [dbo].[items]") against the local
    // app DB → "no such table: dbo.items". Mirrors isMongoSourceToLocal above.
    const isSqlSourceToLocal =
      isLocalStorage && !isInPlace &&
      (dbType === 'duckdb' || dbType === 'sqlite') &&
      sourceDbType && !['duckdb', 'sqlite', 'nedb', 'mongodb'].includes(sourceDbType);

    const sourceLocalPath = (isNeDB || isLocalStorage || isInPlace || dbType === 'duckdb')
      ? getSourceLocalPath(node, nodeMap, edges)
      : null;

    // NoSQL transformations (MongoDB, NeDB)
    if (['mongodb', 'nedb'].includes(dbType)) {
      console.log(`[Transformer Routing] -> nosql branch dbType=${dbType}, sourceLocalPath=${sourceLocalPath}` +
        (dbType === 'nedb' && sourceDbType === 'mongodb'
          ? '  ⚠️ NeDB branch with a MongoDB source — this yields "Source NeDB file not found". Restart Electron to pick up the mongo-source guard.'
          : ''));
      const result = await handleTransformNoSQL({
        dbType,
        config: config.targetDbConfig || config.dbConfig,
        connectionId: config.targetConnectionId || config.connectionId,
        sourceLocalPath: sourceLocalPath,
        sourceCollection: config.sourceCollection,
        targetCollection: config.targetCollection,
        targetLocalPath: config.targetLocalPath,
        operationType: config.operationType,
        nosqlOperation: config.nosqlOperation,
        transformFunction: config.transformFunction,
        storageLocation: config.transformationSettings?.storageLocation,
        operationMode: config.transformationSettings?.operationMode,
        workflowId: helpers?.workflowId || null,
        nodeId: node.id
      });

      return {
        success: result.success,
        message: result.message || (result.success ? 'NoSQL transformation completed' : 'NoSQL transformation failed'),
        recordsProcessed: result.recordCount || result.modifiedCount || 0
      };
    }

    // SQL transformations (PostgreSQL, MySQL, MSSQL, SQLite, etc.)
    // For a remote-SQL-source → local-SQLite transform, hand handleTransformSQL
    // the *source* db/connection so its storageLocation==='local' branch pulls
    // data from the source plugin into local SQLite; otherwise use the target.
    const result = await handleTransformSQL({
      dbType: isSqlSourceToLocal ? sourceDbType : dbType,
      config: isSqlSourceToLocal
        ? (config.sourceDbConfig || config.dbConfig)
        : (config.targetDbConfig || config.dbConfig),
      connectionId: isSqlSourceToLocal
        ? (config.sourceConnectionId || config.connectionId)
        : (config.targetConnectionId || config.connectionId),
      ddl: config.targetDdl,
      sql: config.targetSql,
      previewSql: config.targetPreviewSql,
      storageLocation: config.transformationSettings?.storageLocation,
      operationMode: config.transformationSettings?.operationMode,
      targetSchema: config.targetSchema || config.sourceSchema || config.schema,
      targetTableName: config.targetTableName || config.targetCollection,
      sourceLocalPath: sourceLocalPath,
      insertSql: config.targetInsertSql,
      // A local DuckDB target writes one Parquet file per node, so it needs to
      // know which node it is.
      targetLocalPath: config.targetLocalPath,
      sourceFormat: config.sourceFormat || null,
      workflowId: helpers?.workflowId || null,
      nodeId: node.id
    });

    return {
      success: result.success,
      message: result.message || (result.success ? 'SQL transformation completed' : 'SQL transformation failed'),
      recordsProcessed: result.rowCount || result.recordCount || 0
    };
  } catch (error) {
    console.error('[Workflow Execution] Transformer error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}

/**
 * Execute a Join node
 * Calls the join handler directly
 */
async function executeJoinNode(node, nodeMap, edges, helpers) {
  const { getFullConfig } = helpers;

  console.log(`[Workflow Execution] Executing Join node: ${node.id}`);

  const config = node.data?.config;

  if (!config) {
    return {
      success: false,
      message: 'Join configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured join up front with a clear, node-named message.
  const joinNotConfigured = checkNodeConfigured(node, 'join');
  if (joinNotConfigured) return joinNotConfigured;

  // Find source nodes
  const sourceEdges = edges.filter(e => e.target === node.id);
  if (sourceEdges.length < 2) {
    return {
      success: false,
      message: 'Join requires at least 2 source connections',
      recordsProcessed: 0
    };
  }

  // Check if join is configured. Saved join nodes store the generated
  // operation as flat fields (sourcesConfig, joinSql / transformFunction,
  // targetDdl …) — there is no nested config.joinConfig; the executor rebuilds
  // it below. So gate on what's actually generated: a SQL join has joinSql, a
  // NoSQL/vector join has a transformFunction. Both JoinNodeChat (interactive)
  // and the headless workflow builder produce this same flat shape.
  if (!config.joinSql && !config.transformFunction) {
    return {
      success: false,
      message: 'Join configuration not found',
      recordsProcessed: 0
    };
  }

  try {
    // Build destination connection from config. Include localPath so a local
    // file destination (LanceDB directory / SQLite / NeDB file) resolves to the
    // right path — the vector branch falls back to destinationConnection.localPath.
    const destinationConnection = {
      id: config.targetConnectionId || config.connectionId,
      dbType: config.targetDbType,
      dbConfig: config.targetDbConfig || {},
      localPath: config.targetLocalPath
    };

    // Build join config. Pass vectorDestination through so a vector destination
    // (saved Pinecone connection OR local LanceDB table) gets embedded + upserted
    // by the handler's vector branch.
    const joinConfig = {
      sourcesConfig: config.sourcesConfig,
      joinSql: config.joinSql,
      targetDdl: config.targetDdl,
      transformFunction: config.transformFunction,
      targetTableName: config.targetTableName,
      targetCollection: config.targetCollection,
      // Carried so a local NeDB join writes to the file its readers already
      // point at, rather than falling back to a derived path.
      targetLocalPath: config.targetLocalPath,
      vectorDestination: config.vectorDestination
    };

    // Call the join handler directly
    const result = await handleExecuteJoin({
      destinationConnection,
      joinConfig,
      operationMode: config.joinSettings?.operationMode || 'new_table',
      workflowId: helpers?.workflowId || null,
      nodeId: node.id
    });

    return {
      success: result.success,
      message: result.message || (result.success ? 'Join executed successfully' : 'Join execution failed'),
      recordsProcessed: result.rowCount || result.recordCount || result.documentsInserted || 0
    };
  } catch (error) {
    console.error('[Workflow Execution] Join error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}



/**
 * Execute an Output node
 * Calls the output handler directly
 */
async function executeOutputNode(node, nodeMap, edges, helpers) {
  const { getFullConfig, pluginManager, getDb } = helpers;

  console.log(`[Workflow Execution] Executing Output node: ${node.id}`);

  const config = node.data?.config;

  if (!config) {
    return {
      success: false,
      message: 'Output configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured output up front with a clear, node-named message.
  const outputNotConfigured = checkNodeConfigured(node, 'output');
  if (outputNotConfigured) return outputNotConfigured;

  // Find source node
  const sourceEdge = edges.find(e => e.target === node.id);
  if (!sourceEdge) {
    return {
      success: false,
      message: 'No source connection found for output',
      recordsProcessed: 0
    };
  }

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode) {
    return {
      success: false,
      message: 'Source node not found',
      recordsProcessed: 0
    };
  }

  // Check if output is configured
  if (!config.outputSettings) {
    return {
      success: false,
      message: 'Output settings not configured',
      recordsProcessed: 0
    };
  }

  try {


    // This node's own source* fields already hold the upstream connection,
    // resolved when the node was configured (OutputNodeChat.js:305). Prefer
    // them. Deriving from the parent instead mixes its source* and target*
    // sides — for a transformer that yields dbType from its source (mongodb)
    // beside localPath from its target (a NeDB file), a pair that matches no
    // read branch in executeOutput. Parent target* comes next, since a
    // transformer/join writes to its target; parent source* is last, covering
    // a datasource parent, which has no target side.
    const sourceConfig = sourceNode.data?.config || {};

    const connection = {
      id: config.sourceConnectionId || sourceConfig.targetConnectionId || sourceConfig.sourceConnectionId,
      name: config.sourceConnectionName || sourceConfig.targetConnectionName || sourceConfig.sourceConnectionName,
      connectionType: config.sourceConnectionType || sourceConfig.targetConnectionType || sourceConfig.sourceConnectionType,
      dbType: config.sourceDbType || sourceConfig.targetDbType || sourceConfig.sourceDbType,
      dbConfig: config.sourceDbConfig || sourceConfig.targetDbConfig || sourceConfig.sourceDbConfig,
      localPath: config.sourceLocalPath || sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath,
      dbCategory: config.sourceDbCategory || sourceConfig.targetDbCategory || sourceConfig.sourceDbCategory,
      indexName: config.sourceIndexName || sourceConfig.targetIndexName || sourceConfig.sourceIndexName // For Pinecone
    };

    const sourceConnectionId = connection.id;

    const sourceConnection = await getFullConfig(sourceConnectionId, connection);
    
    // console.log('sourceConnectionId: ', sourceNode, sourceConnection)

    if (!sourceConnection) {
      return {
        success: false,
        message: 'Source connection not found',
        recordsProcessed: 0
      };
    }

    // Call the output handler directly. getDb IS available on the helpers
    // bundle (assembled in electron.js); the previous null hard-code broke
    // insertToConnection's connection-lookup at outputExecutionHelpers.js:760.
    const skillHelpers = typeof helpers.buildSkillHelpers === 'function'
      ? await helpers.buildSkillHelpers()
      : null;
    const result = await executeOutput(
      sourceConnection,
      config.sourceTableSchema,
      config.outputSettings,
      pluginManager,
      getFullConfig,
      getDb,
      skillHelpers
    );

    return {
      success: result.success,
      message: result.message || (result.success ? 'Output executed successfully' : 'Output execution failed'),
      recordsProcessed: result.rowCount || result.recordCount || 0
    };
  } catch (error) {
    console.error('[Workflow Execution] Output error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}

/**
 * Execute a single workflow node
 * @param {object} node - The node to execute
 * @param {Map} nodeMap - Map of node IDs to node objects
 * @param {Array} edges - Array of workflow edges
 * @param {object} helpers - Helper functions and dependencies
 * @returns {Promise<object>} - Result of node execution
 */
async function executeNode(node, nodeMap, edges, helpers) {
  let nodeResult = null;
  // console.log('node: ', node)
  switch (node.type) {
    case 'dataSource':
      nodeResult = await executeDataSourceNode(node, helpers);
      break;

    case 'transformer':
      nodeResult = await executeTransformerNode(node, nodeMap, edges, helpers);
      break;

    case 'join':
      nodeResult = await executeJoinNode(node, nodeMap, edges, helpers);
      break;

    case 'output':
      nodeResult = await executeOutputNode(node, nodeMap, edges, helpers);
      break;

    case 'start':
      // Start nodes don't need execution
      nodeResult = { success: true, message: 'Start node' };
      break;

    default:
      console.log(`[Workflow Execution] Skipping node type: ${node.type}`);
      nodeResult = { success: true, message: `Skipped ${node.type} node` };
  }

  return nodeResult;
}

module.exports = {
  addExecutionLog,
  executeNode,
  executeDataSourceNode,
  executeTransformerNode,
  executeJoinNode,
  executeOutputNode
};
