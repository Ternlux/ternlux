const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const Datastore = require('@seald-io/nedb');
const pluginManager = require('./pluginManager');
const {transformNeDB, saveToLocalNeDB} = require('./transfomers/NeDB')
const Sqlite = require('./transfomers/Sqlite');
const { loadSourceData, loadSQLSourceInChunks, insertDataToTempTable, executeLocalSQLiteJoin } = require('./joins/joinExecutionHelpers');
const { executeOutput } = require('./outputs/outputExecutionHelpers');
const { importParquetToSqlite, importAvroToSqlite, importSpreadsheetToSqlite, importCsvToSqlite } = require('./imports/importHelpers');
// Ensure the same userData directory is used in both dev and production,
// so a key saved during development persists when the packaged app is launched.
app.setName('DagFlux');

// Single SQLite database path for all local transformations
let appSqliteDbPath = null;

/**
 * Initialize the single SQLite database for the app
 * All local SQL transformations will create tables in this database
 */
function initializeAppDatabase() {
  const sqlite3 = require('sqlite3').verbose();
  appSqliteDbPath = path.join(app.getPath('userData'), 'app-data.db');

  // Ensure the database file exists
  const db = new sqlite3.Database(appSqliteDbPath, (err) => {
    if (err) {
      console.error('Failed to initialize app database:', err);
    } else {
      console.log('App SQLite database initialized at:', appSqliteDbPath);
    }
  });

  db.close();
  return appSqliteDbPath;
}

// Path to the encrypted config file stored in the app's user-data directory.
// Written only after the app is ready so app.getPath() is safe to call.
function getConfigPath() {
  return path.join(app.getPath('userData'), 'llm-config.dat');
}

// ---------------------------------------------------------------------------
// IPC handlers — registered before createWindow so they are ready immediately
// ---------------------------------------------------------------------------

/**
 * Encrypts and saves an API key for a specific provider.
 * Supports multiple providers - stores as: { claude: "key1", gemini: "key2", chatgpt: "key3" }
 */
ipcMain.handle('api-key:save', (_event, { provider, key }) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'safeStorage is not available on this system' };
    }

    const configPath = getConfigPath();
    // Load existing keys (if any)
    let allKeys = {};
    if (fs.existsSync(configPath)) {
      try {
        const b64 = fs.readFileSync(configPath, 'utf8');
        const buf = Buffer.from(b64, 'base64');
        const payload = safeStorage.decryptString(buf);
        allKeys = JSON.parse(payload);
      } catch (err) {
        console.warn('[api-key:save] Could not load existing keys, starting fresh:', err);
      }
    }

    // Add or update the key for this provider
    allKeys[provider] = key;

    // Encrypt and save all keys
    const payload = JSON.stringify(allKeys);
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(configPath, encrypted.toString('base64'), 'utf8');

    return { success: true };
  } catch (err) {
    console.error('[api-key:save]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Reads llm-config.dat, decrypts it, and returns all provider keys as an object
 * Returns: { claude: "key1", gemini: "key2", chatgpt: "key3" } or null
 */
ipcMain.handle('api-key:load', () => {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;

    if (!safeStorage.isEncryptionAvailable()) return null;

    const b64 = fs.readFileSync(configPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[api-key:load]', err);
    return null;
  }
});

/**
 * Deletes llm-config.dat so the setup screen is shown again on next launch.
 */
ipcMain.handle('api-key:clear', () => {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    return { success: true };
  } catch (err) {
    console.error('[api-key:clear]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Secure database credential storage
// Stores sensitive database credentials (passwords, hosts, etc.) encrypted
// using OS-level safeStorage (Keychain on macOS, Credential Store on Windows)
// ---------------------------------------------------------------------------

function getCredentialsPath() {
  return path.join(app.getPath('userData'), 'db-credentials.dat');
}

/**
 * Load all stored credentials from disk
 * Returns an object mapping connectionId -> { password, host, username, ... }
 */
function loadAllCredentials() {
  try {
    const credsPath = getCredentialsPath();
    if (!fs.existsSync(credsPath)) return {};

    if (!safeStorage.isEncryptionAvailable()) return {};

    const b64 = fs.readFileSync(credsPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[loadAllCredentials]', err);
    return {};
  }
}

/**
 * Save all credentials to disk (encrypted)
 */
function saveAllCredentials(credentials) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage is not available on this system');
    }

    const payload = JSON.stringify(credentials);
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(getCredentialsPath(), encrypted.toString('base64'), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[saveAllCredentials]', err);
    return { success: false, error: err.message };
  }
}

/**
 * Save database credentials for a connection
 * IPC: 'db-credentials:save'
 */
ipcMain.handle('db-credentials:save', (_event, { connectionId, credentials }) => {
  try {
    // console.log('connectionId, credentials: ', connectionId, credentials)
    const allCreds = loadAllCredentials();
    allCreds[connectionId] = credentials;
    return saveAllCredentials(allCreds);
  } catch (err) {
    console.error('[db-credentials:save]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Load database credentials for a connection
 * IPC: 'db-credentials:load'
 * Returns the credentials object or null
 */
ipcMain.handle('db-credentials:load', (_event, { connectionId }) => {
  try {
    const allCreds = loadAllCredentials();
    return allCreds[connectionId] || null;
  } catch (err) {
    console.error('[db-credentials:load]', err);
    return null;
  }
});

/**
 * Update database credentials for a connection
 * IPC: 'db-credentials:update'
 * Completely replaces credentials (does not merge with existing)
 * Also closes any cached connections so they reconnect with new credentials
 */
ipcMain.handle('db-credentials:update', async (_event, { connectionId, credentials, dbType }) => {
  try {
    const allCreds = loadAllCredentials();

    // Replace credentials completely (no merging)
    allCreds[connectionId] = credentials;

    const saveResult = saveAllCredentials(allCreds);

    // Close the cached connection so it reconnects with new credentials
    if (dbType && pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.closeConnection === 'function') {
        try {
          await connector.closeConnection(connectionId);
          console.log(`[db-credentials:update] Closed cached connection for ${connectionId}`);
        } catch (closeErr) {
          console.warn('[db-credentials:update] Error closing connection:', closeErr.message);
        }
      }
    }

    return saveResult;
  } catch (err) {
    console.error('[db-credentials:update]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Delete database credentials for a connection
 * IPC: 'db-credentials:delete'
 */
ipcMain.handle('db-credentials:delete', (_event, { connectionId }) => {
  try {
    const allCreds = loadAllCredentials();
    delete allCreds[connectionId];
    return saveAllCredentials(allCreds);
  } catch (err) {
    console.error('[db-credentials:delete]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Local NeDB datastores — lazily initialized after app is ready so that
// app.getPath('userData') is available.
// ---------------------------------------------------------------------------

const _dbs = {};
const VALID_COLLECTIONS = ['workflows', 'connections', 'executions', 'chatSessions'];

function getDb(collection) {
  if (!VALID_COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown collection: ${collection}`);
  }
  if (!_dbs[collection]) {
    _dbs[collection] = new Datastore({
      filename: path.join(app.getPath('userData'), `dagflux-${collection}.db`),
      autoload: true,
    });
  }
  return _dbs[collection];
}

// db:insert — insert a document into a collection
ipcMain.handle('db:insert', async (_event, { collection, doc }) => {
  const db = getDb(collection);
  return db.insertAsync(doc);
});

// db:find — find documents with optional sort/limit/skip
ipcMain.handle('db:find', async (_event, { collection, query = {}, sort = null, limit = 0, skip = 0 }) => {
  const db = getDb(collection);
  let cursor = db.findAsync(query);
  if (sort)  cursor = cursor.sort(sort);
  if (skip)  cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  return cursor;
});

// db:findOne — return the first matching document or null
ipcMain.handle('db:findOne', async (_event, { collection, query = {} }) => {
  const db = getDb(collection);
  return db.findOneAsync(query);
});

// db:update — update matching documents; options: { multi, upsert, returnUpdatedDocs }
ipcMain.handle('db:update', async (_event, { collection, query = {}, update = {}, options = {} }) => {
  const db = getDb(collection);
  return db.updateAsync(query, update, options);
});

// db:remove — remove matching documents; options: { multi }
ipcMain.handle('db:remove', async (_event, { collection, query = {}, options = {} }) => {
  const db = getDb(collection);
  return db.removeAsync(query, options);
});

// db:count — count documents matching query
ipcMain.handle('db:count', async (_event, { collection, query = {} }) => {
  const db = getDb(collection);
  return db.countAsync(query);
});

// db:read-local-collection — read from a local NeDB or SQLite file
ipcMain.handle('db:read-local-collection', async (_event, { filePath, limit = 100, storageType = 'nedb', sqlPreview = null, tableName = null }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        message: 'Local collection file not found'
      };
    }
    console.log('storageType: ', storageType, filePath, sqlPreview, tableName)
    // Use passed storageType parameter instead of file extension
    const isSqlite = storageType === 'sqlite';

    if (isSqlite) {
      // Read SQLite database
      const sqlite3 = require('sqlite3').verbose();
      const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY);

      return new Promise((resolve) => {
        // If sqlPreview is provided, use it directly
        if (sqlPreview) {
          db.all(sqlPreview, (selectErr, rows) => {
            db.close();
            if (selectErr) {
              resolve({
                success: false,
                message: `Failed to execute preview query: ${selectErr.message}`,
                tables: []
              });
            } else {
              resolve({
                success: true,
                rows: rows,
                rowCount: rows.length,
                json: false,
                tables: [],
                currentTable: tableName || null
              });
            }
          });
        } else if (tableName) {
          // If tableName is provided, query that specific table
          db.all(`SELECT * FROM "${tableName}" LIMIT ${limit}`, (selectErr, rows) => {
            db.close();

            if (selectErr) {
              resolve({
                success: false,
                message: `Failed to read from table "${tableName}": ${selectErr.message}`
              });
            } else {
              resolve({
                success: true,
                rows: rows,
                rowCount: rows.length,
                json: false,
                tables: [tableName],
                currentTable: tableName
              });
            }
          });
        } else {
          // Default behavior: Get list of tables and read from the first one
          db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
            if (err) {
              db.close();
              resolve({
                success: false,
                message: `Failed to read SQLite tables: ${err.message}`
              });
              return;
            }

            if (tables.length === 0) {
              db.close();
              resolve({
                success: true,
                rows: [],
                rowCount: 0,
                json: false,
                tables: []
              });
              return;
            }

            // Read from the first table
            const firstTableName = tables[0].name;
            db.all(`SELECT * FROM "${firstTableName}" LIMIT ${limit}`, (selectErr, rows) => {
              db.close();

              if (selectErr) {
                resolve({
                  success: false,
                  message: `Failed to read from table: ${selectErr.message}`
                });
              } else {
                resolve({
                  success: true,
                  rows: rows,
                  rowCount: rows.length,
                  json: false,
                  tables: tables.map(t => t.name),
                  currentTable: firstTableName
                });
              }
            });
          });
        }
      });
    } else {
      // Read NeDB file
      const localDb = new Datastore({ filename: filePath });

      return new Promise((resolve) => {
        localDb.loadDatabase((loadErr) => {
          if (loadErr) {
            resolve({
              success: false,
              message: `Failed to load local collection: ${loadErr.message}`
            });
            return;
          }

          localDb.find({}).limit(limit).exec((err, docs) => {
            if (err) {
              resolve({
                success: false,
                message: `Failed to read documents: ${err.message}`
              });
            } else {
              resolve({
                success: true,
                rows: docs,
                rowCount: docs.length,
                json: true // NeDB/MongoDB data is JSON
              });
            }
          });
        });
      });
    }
  } catch (error) {
    return {
      success: false,
      message: `Error reading local collection: ${error.message}`
    };
  }
});

// ---------------------------------------------------------------------------
// Native file open dialog
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:open-file', async (_event, options = {}) => {
  const { dialog } = require('electron');
  const defaultOptions = {
    title: 'Select File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  };

  // Merge provided options with defaults
  const dialogOptions = {
    ...defaultOptions,
    ...options,
    properties: options.properties || defaultOptions.properties
  };

  const result = await dialog.showOpenDialog(dialogOptions);
  return result; // { canceled: bool, filePaths: string[] }
});

// ---------------------------------------------------------------------------
// Native file save dialog
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:save-file', async (_event, defaultFileName = 'output.json', fileExtension = 'json') => {
  const { dialog } = require('electron');

  const filters = [];
  switch (fileExtension) {
    case 'json':
      filters.push({ name: 'JSON Files', extensions: ['json'] });
      break;
    case 'csv':
      filters.push({ name: 'CSV Files', extensions: ['csv'] });
      break;
    case 'xlsx':
    case 'excel':
      filters.push({ name: 'Excel Files', extensions: ['xlsx'] });
      break;
    case 'nedb':
      filters.push({ name: 'NeDB Files', extensions: ['nedb', 'db'] });
      break;
    case 'sqlite':
      filters.push({ name: 'SQLite Files', extensions: ['sqlite', 'db'] });
      break;
    case 'parquet':
      filters.push({ name: 'Parquet Files', extensions: ['parquet'] });
      break;
    case 'avro':
      filters.push({ name: 'Avro Files', extensions: ['avro'] });
      break;
    default:
      filters.push({ name: 'All Files', extensions: ['*'] });
  }
  filters.push({ name: 'All Files', extensions: ['*'] });

  const result = await dialog.showSaveDialog({
    title: 'Save File',
    defaultPath: defaultFileName,
    filters: filters,
  });

  return result; // { canceled: bool, filePath: string }
});

// ---------------------------------------------------------------------------
// Local file reading — xlsx/csv via the xlsx package (no upload required)
// ---------------------------------------------------------------------------

/**
 * file:read-rows — read up to `limit` data rows from a local spreadsheet file.
 * Returns { success, sheets, data: { [sheetName]: { columns, rows } } }
 */
ipcMain.handle('file:read-rows', async (_event, { filePath, limit = 1000 }) => {
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath, { sheetRows: limit + 1, cellDates: true, raw: false });
    const data = {};
    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      if (rawRows.length === 0) {
        data[sheetName] = { columns: [], rows: [] };
        return;
      }
      const headers = (rawRows[0] || []).map((h, i) =>
        h !== null && h !== undefined && String(h).trim() !== '' ? String(h) : `Column ${i + 1}`
      );
      const dataRows = rawRows.slice(1, limit + 1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row ? row[i] : null; });
        return obj;
      });
      data[sheetName] = { columns: headers, rows: dataRows };
    });
    return { success: true, sheets: workbook.SheetNames, data };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * import-to-sqlite — Import CSV/Excel/Parquet/Avro file to internal SQLite database
 * Returns { success, dbPath, tableName, rowCount, message }
 */
ipcMain.handle('import-to-sqlite', async (_event, { filePath, tableName, fileType }) => {
  try {
    const sqlite3 = require('sqlite3').verbose();
    const path = require('path');

    // Use the app-wide SQLite database
    if (!appSqliteDbPath) {
      return {
        success: false,
        message: 'App database not initialized'
      };
    }

    // Sanitize the base table name
    let sanitizedTableName = String(tableName)
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^[0-9]/, '_$&') // Prefix with underscore if starts with number
      .substring(0, 64); // Limit length

    // Ensure table name is not empty
    if (!sanitizedTableName || sanitizedTableName === '') {
      sanitizedTableName = 'imported_table';
    }

    const dbPath = appSqliteDbPath;
    const db = new sqlite3.Database(dbPath);

    // Determine file type from extension if not provided
    const ext = path.extname(filePath).toLowerCase();
    const detectedFileType = fileType || (
      ext === '.parquet' ? 'parquet' :
      ext === '.avro' ? 'avro' :
      'spreadsheet'
    );

    // Route to appropriate parser based on file type
    if (detectedFileType === 'parquet') {
      return await importParquetToSqlite(filePath, sanitizedTableName, db, dbPath);
    } else if (detectedFileType === 'avro') {
      return await importAvroToSqlite(filePath, sanitizedTableName, db, dbPath);
    } else {
      // Default: CSV/Excel import
      return await importSpreadsheetToSqlite(filePath, sanitizedTableName, db, dbPath);
    }
  } catch (error) {
    console.error('Import error:', error);
    return {
      success: false,
      message: error.message || 'Failed to import file'
    };
  }
});


/**
 * import-to-nedb — Import JSON file to internal NeDB database
 * Returns { success, dbPath, collectionName, docCount, message }
 */
ipcMain.handle('import-to-nedb', async (_event, { filePath, collectionName }) => {
  try {
    // Create internal databases directory
    const userDataPath = app.getPath('userData');
    const dbDir = path.join(userDataPath, 'internal_databases');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Create database file
    const dbPath = path.join(dbDir, `${collectionName}.nedb`);

    return new Promise((resolve, reject) => {
      // Read JSON file
      const jsonContent = fs.readFileSync(filePath, 'utf8');
      let documents;

      try {
        const parsed = JSON.parse(jsonContent);
        // Handle both array of documents and single document
        documents = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseErr) {
        return resolve({
          success: false,
          message: `Invalid JSON format: ${parseErr.message}`
        });
      }

      if (documents.length === 0) {
        return resolve({
          success: false,
          message: 'No documents found in JSON file'
        });
      }

      // Create NeDB datastore
      const db = new Datastore({ filename: dbPath, autoload: true });

      // Insert documents
      db.insert(documents, (err, newDocs) => {
        if (err) {
          return resolve({
            success: false,
            message: `Failed to insert documents: ${err.message}`
          });
        }

        resolve({
          success: true,
          dbPath,
          collectionName,
          docCount: newDocs.length,
          message: `Imported ${newDocs.length} documents to NeDB`
        });
      });
    });
  } catch (err) {
    console.error('Import to NeDB error:', err);
    return { success: false, message: err.message };
  }
});

// ---------------------------------------------------------------------------
// Direct database connection IPC handlers
// Drivers are require()'d lazily so they don't slow app startup.
// ---------------------------------------------------------------------------

/**
 * Helper function to retrieve and merge connection config with secure credentials
 * @param {string} connectionId - The connection ID
 * @param {Object} baseConfig - The base config with non-sensitive data
 * @returns {Object} - Merged config with credentials
 */
async function getFullConfig(connectionId, baseConfig = {}) {
  if (!connectionId) {
    // If no connectionId, assume baseConfig already has everything (e.g., test connection before saving)
    console.log('[getFullConfig] No connectionId, returning baseConfig:');
    return baseConfig;
  }

  try {
    // Load secure credentials
    const allCredentials = loadAllCredentials();
    const credentials = allCredentials[connectionId];
    // console.log('[getFullConfig] connectionId:', connectionId);
    // console.log('[getFullConfig] available credential IDs:', Object.keys(allCredentials));
    // console.log('[getFullConfig] baseConfig:', baseConfig);
    // console.log('[getFullConfig] loaded credentials:', credentials);

    if (!credentials) {
      // No credentials found - return baseConfig as-is
      console.warn('[getFullConfig] No credentials found for connectionId:', connectionId);
      return baseConfig;
    }

    // Merge baseConfig with credentials
    const fullConfig = {
      ...baseConfig,
      ...credentials
    };
    // console.log('[getFullConfig] merged fullConfig:', fullConfig);
    return fullConfig;
  } catch (err) {
    console.error('[getFullConfig]', err);
    return baseConfig;
  }
}

/**
 * dbconn:test — verify that a connection can be established.
 * Returns { success, message }
 * Accepts either full config (for testing before save) or connectionId + partial config
 */
ipcMain.handle('dbconn:test', async (_event, { dbType, config, connectionId }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.testConnection(fullConfig, connectionId);
    }

    return { success: false, message: `Unsupported dbType: ${dbType}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-tables — list schemas + tables (or MongoDB collections).
 * Returns { success, tables: [{ schema, name, type }] }
 */
ipcMain.handle('dbconn:get-tables', async (_event, { dbType, config, connectionId }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.getTables(fullConfig, connectionId);
    }

    return { success: false, tables: [] };
  } catch (err) {
    return { success: false, message: err.message, tables: [] };
  }
});

/**
 * dbconn:get-columns — list columns for a specific table.
 * Returns { success, columns: [{ name, type, nullable, isPrimary }] }
 */
ipcMain.handle('dbconn:get-columns', async (_event, { dbType, config, connectionId, schema, table }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.getColumns(fullConfig, connectionId, schema, table);
    }

    return { success: false, columns: [] };
  } catch (err) {
    return { success: false, message: err.message, columns: [] };
  }
});

/**
 * dbconn:quote-identifier — quote table/column identifier for specific database type.
 * Returns { success, quotedIdentifier }
 */
ipcMain.handle('dbconn:quote-identifier', async (_event, { dbType, identifier, schema = null, config = null, connectionId = null }) => {
  try {
    // Get full config if connectionId is provided
    let fullConfig = config;
    if (connectionId && !config) {
      fullConfig = await getFullConfig(connectionId, {});
    }

    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.quoteIdentifier === 'function') {
        const quotedIdentifier = connector.quoteIdentifier(identifier, schema, fullConfig);
        return { success: true, quotedIdentifier };
      }
    }

    // Fallback: return unquoted identifier
    const result = schema ? `${schema}.${identifier}` : identifier;
    return { success: true, quotedIdentifier: result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-preview-query — generate database-specific preview SQL query.
 * Returns { success, previewQuery }
 */
ipcMain.handle('dbconn:get-preview-query', async (_event, { dbType, tableName, limit = 100 }) => {
  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.getPreviewQuery === 'function') {
        const previewQuery = connector.getPreviewQuery(tableName, limit);
        return { success: true, previewQuery };
      }
    }

    // Fallback: use standard LIMIT syntax
    return { success: true, previewQuery: `SELECT * FROM ${tableName} LIMIT ${limit}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * google-sheets:import-to-sqlite — Import a Google Sheet to local SQLite database.
 * Returns { success, localPath, tableName, rowCount, message }
 */
ipcMain.handle('google-sheets:import-to-sqlite', async (_event, { config, connectionId, spreadsheetId, sheetName }) => {
  try {
    const fullConfig = await getFullConfig(connectionId, config);

    if (!pluginManager.hasConnector('google-sheets')) {
      return { success: false, message: 'Google Sheets connector not found' };
    }

    const connector = pluginManager.getConnector('google-sheets');

    // Step 1: Fetch data from Google Sheets
    const queryResult = await connector.runQuery(fullConfig, connectionId, {
      spreadsheetId,
      sheetName,
      range: `${sheetName}!A1:ZZ`
    });

    if (!queryResult.success || !queryResult.rows || queryResult.rows.length === 0) {
      return { success: false, message: 'Failed to fetch data from Google Sheet or sheet is empty' };
    }

    const rows = queryResult.rows;
    const columns = queryResult.columns;

    // Step 2: Generate sanitized table name
    const sanitizedTableName = `gs_${spreadsheetId.substring(0, 20)}_${sheetName}`
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .substring(0, 64);

    // Step 3: Sanitize column names and handle duplicates
    const sanitizedColumnNames = [];
    const columnIndexMap = new Map(); // Maps index to sanitized name

    columns.forEach((column, index) => {
      let baseName = (column || `Column_${index + 1}`).replace(/[^a-zA-Z0-9_]/g, '_');

      // Ensure name doesn't start with a number
      if (/^\d/.test(baseName)) {
        baseName = '_' + baseName;
      }

      // Handle duplicates by adding suffix
      let finalName = baseName;
      let suffix = 1;
      while (sanitizedColumnNames.includes(finalName)) {
        finalName = `${baseName}_${suffix}`;
        suffix++;
      }

      sanitizedColumnNames.push(finalName);
      columnIndexMap.set(index, finalName);
    });

    // Step 4: Infer column types from data
    const inferType = (values) => {
      const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
      if (nonNullValues.length === 0) return 'TEXT';

      // Check if all are numbers
      const allNumbers = nonNullValues.every(v => !isNaN(Number(v)));
      if (allNumbers) {
        const allIntegers = nonNullValues.every(v => Number.isInteger(Number(v)));
        return allIntegers ? 'INTEGER' : 'REAL';
      }

      return 'TEXT';
    };

    // Step 5: Build DDL with sanitized column names
    const columnDefs = columns.map((column, index) => {
      const sanitizedName = columnIndexMap.get(index);
      const columnValues = rows.map(row => row[column]);
      const columnType = inferType(columnValues);
      return `"${sanitizedName}" ${columnType}`;
    }).join(', ');

    const ddl = `CREATE TABLE "${sanitizedTableName}" (${columnDefs})`;

    // Step 6: Build INSERT statement with sanitized column names
    const quotedColumns = columns.map((col, index) => {
      const sanitizedName = columnIndexMap.get(index);
      return `"${sanitizedName}"`;
    }).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${sanitizedTableName}" (${quotedColumns}) VALUES (${placeholders})`;

    // Step 7: Use Sqlite.js to insert data into app-data.db
    const { databaseToLocal } = require('./transfomers/Sqlite');

    // Create a fake SQL query (not used since we already have the data)
    const fakeQuery = `SELECT * FROM "${sanitizedTableName}"`;

    // Use databaseToLocal with in-memory data
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(appSqliteDbPath);

    return new Promise((resolve) => {
      db.serialize(() => {
        // Drop table if exists
        db.run(`DROP TABLE IF EXISTS "${sanitizedTableName}"`, (dropErr) => {
          if (dropErr) {
            db.close();
            return resolve({
              success: false,
              message: `Failed to drop existing table: ${dropErr.message}`
            });
          }

          // Create table
          db.run(ddl, (createErr) => {
            if (createErr) {
              db.close();
              return resolve({
                success: false,
                message: `Failed to create table: ${createErr.message}`
              });
            }

            // Insert data in chunks
            const CHUNK_SIZE = 1000;
            let processedRows = 0;

            const processChunk = (startIndex) => {
              const endIndex = Math.min(startIndex + CHUNK_SIZE, rows.length);
              const chunk = rows.slice(startIndex, endIndex);

              const stmt = db.prepare(insertSql);

              for (const row of chunk) {
                const values = columns.map(col => row[col]);
                stmt.run(values, (runErr) => {
                  if (runErr) {
                    console.error('[Google Sheets Import] Insert error:', runErr);
                  }
                });
              }

              stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                  console.error('[Google Sheets Import] Finalize error:', finalizeErr);
                }

                processedRows += chunk.length;

                if (endIndex < rows.length) {
                  // Process next chunk
                  setImmediate(() => processChunk(endIndex));
                } else {
                  // All chunks processed
                  db.close(() => {
                    resolve({
                      success: true,
                      localPath: appSqliteDbPath,
                      tableName: sanitizedTableName,
                      rowCount: processedRows,
                      message: `Imported ${processedRows} rows from Google Sheet`
                    });
                  });
                }
              });
            };

            // Start processing chunks
            processChunk(0);
          });
        });
      });
    });
  } catch (err) {
    console.error('[Google Sheets Import] Error:', err);
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-table-schema — get table schema with inferred types and sample data.
 * Returns { success, tableName, columns: [{ name, type, nullable, isPrimary }], sampleData }
 */
ipcMain.handle('dbconn:get-table-schema', async (_event, { dbType, config, connectionId, tableName, sheetName = null, limit = 5 }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type and has getTableSchema method
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      // If connector has getTableSchema method, use it
      if (typeof connector.getTableSchema === 'function') {
        return await connector.getTableSchema(fullConfig, connectionId, tableName, sheetName, limit);
      }
    }

    return { success: false, message: 'getTableSchema method not implemented for this connector' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:run-query — execute a read-only SQL/MQL query.
 * Returns { success, rows, columns, rowCount }
 */
ipcMain.handle('dbconn:run-query', async (_event, { dbType, config, connectionId, query }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.runQuery(fullConfig, connectionId, query);
    }

    return { success: false, rows: [], columns: [] };
  } catch (err) {
    return { success: false, message: err.message, rows: [], columns: [] };
  }
});

/**
 * dbconn:generate-transform-prompt — generate transformation prompt from a plugin
 * Executes the prompt function in main process and returns the generated string
 */
ipcMain.handle('dbconn:generate-transform-prompt', async (_event, {
  dbType,
  operationMode,
  settings,
  sourceTableInfo,
  settingsContext,
  sourceTableSchema,
  targetTableName,
  sourceConnection,
  targetSchema,
  fullTableName,
  sourceSchema,
  sourceFullTableName
}) => {
  try {
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      if (typeof connector.getTransformPrompts === 'function') {
        const prompts = connector.getTransformPrompts();

        const promptFn = operationMode === 'in_place' ? prompts.inPlace : prompts.newTable;

        if (typeof promptFn === 'function') {
          console.log('sourceSchema || targetSchema: ', sourceSchema, targetSchema)
          let sourceSchemaClean = operationMode === 'in_place' ? (sourceSchema || targetSchema) : (targetSchema)
          sourceSchemaClean = sourceSchemaClean ? sourceSchemaClean : targetTableName.split('.').length > 1 ? targetTableName.split('.')[0] : null;
          console.log('sourceSchemaClean: ', sourceSchemaClean)
          // Execute prompt function in main process with provided parameters
          // For in-place mode, use source table/schema; for new-table mode, use target table/schema
          const prompt = promptFn(
            settings,
            sourceTableInfo,
            settingsContext,
            sourceConnection || sourceTableSchema,
            sourceSchemaClean,
            operationMode === 'in_place' ? (sourceFullTableName || sourceTableSchema?.tableName) : (fullTableName || targetTableName)
          );

          return {
            success: true,
            prompt: prompt
          };
        }

        return {
          success: false,
          message: `Prompt function not found for operation mode: ${operationMode}`
        };
      }
    }

    return {
      success: false,
      message: `Plugin ${dbType} does not support transformation prompts`
    };
  } catch (err) {
    console.error('[dbconn:generate-transform-prompt]', err);
    return {
      success: false,
      message: err.message
    };
  }
});

/**
 * OAuth2.0 Handlers
 */

// Store pending OAuth states
const pendingOAuthStates = new Map();

/**
 * oauth:get-authorization-url - Generate OAuth authorization URL
 */
ipcMain.handle('oauth:get-authorization-url', async (_event, { dbType, config }) => {
  try {
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Connector not found' };
    }

    if (!plugin.getAuthorizationUrl) {
      return { success: false, message: 'Connector does not support OAuth' };
    }

    // Generate random state for CSRF protection
    const state = require('crypto').randomBytes(16).toString('hex');

    const result = plugin.getAuthorizationUrl({ ...config, state });

    if (result.success) {
      // Store state for verification
      pendingOAuthStates.set(state, {
        dbType,
        config,
        timestamp: Date.now()
      });

      // Clean up old states (older than 10 minutes)
      for (const [key, value] of pendingOAuthStates.entries()) {
        if (Date.now() - value.timestamp > 10 * 60 * 1000) {
          pendingOAuthStates.delete(key);
        }
      }
    }

    return result;
  } catch (error) {
    console.error('[oauth:get-authorization-url]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:exchange-code - Exchange authorization code for tokens
 */
ipcMain.handle('oauth:exchange-code', async (_event, { dbType, config, code, state }) => {
  try {
    // Verify state
    const pendingState = pendingOAuthStates.get(state);
    if (!pendingState) {
      return { success: false, message: 'Invalid or expired OAuth state' };
    }

    pendingOAuthStates.delete(state);

    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Connector not found' };
    }

    if (!plugin.exchangeCodeForTokens) {
      return { success: false, message: 'Connector does not support OAuth' };
    }
    
    const result = await plugin.exchangeCodeForTokens(config, code);
    return result;
  } catch (error) {
    console.error('[oauth:exchange-code]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:open-browser - Open browser to OAuth URL
 */
ipcMain.handle('oauth:open-browser', async (_event, { url }) => {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('[oauth:open-browser]', error);
    return { success: false, message: error.message };
  }
});

// Track active OAuth servers by port
const activeOAuthServers = new Map();

/**
 * oauth:start-callback-server - Start local server to handle OAuth callback
 */
ipcMain.handle('oauth:start-callback-server', async (_event, { port = 3000 }) => {
  try {
    const http = require('http');
    const url = require('url');

    // Close any existing server on this port
    if (activeOAuthServers.has(port)) {
      const existingServer = activeOAuthServers.get(port);
      existingServer.server.close();
      if (existingServer.timeoutId) clearTimeout(existingServer.timeoutId);
      activeOAuthServers.delete(port);
    }

    return new Promise((resolve) => {
      let timeoutId = null;
      let resolved = false;

      const cleanupAndResolve = (result) => {
        if (resolved) return;
        resolved = true;

        if (timeoutId) clearTimeout(timeoutId);
        activeOAuthServers.delete(port);
        resolve(result);
      };

      const server = http.createServer((req, res) => {
        const query = url.parse(req.url, true).query;

        if (query.code) {
          // Success - got authorization code
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authorization Successful</title></head>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Authorization Successful!</h1>
                <p>You can close this window and return to DagFlux.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

          server.close();
          cleanupAndResolve({
            success: true,
            code: query.code,
            state: query.state
          });
        } else if (query.error) {
          // Error from OAuth provider
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authorization Failed</title></head>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>✗ Authorization Failed</h1>
                <p>Error: ${query.error}</p>
                <p>${query.error_description || ''}</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);

          server.close();
          cleanupAndResolve({
            success: false,
            error: query.error,
            errorDescription: query.error_description
          });
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(port, () => {
        console.log(`[OAuth] Callback server listening on port ${port}`);
      });

      // Store server reference for cancellation
      timeoutId = setTimeout(() => {
        server.close();
        cleanupAndResolve({
          success: false,
          message: 'OAuth timeout - no response received'
        });
      }, 5 * 60 * 1000);

      activeOAuthServers.set(port, { server, timeoutId, cleanup: cleanupAndResolve });
    });
  } catch (error) {
    console.error('[oauth:start-callback-server]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:cancel-server - Cancel an active OAuth callback server
 */
ipcMain.handle('oauth:cancel-server', async (_event, { port = 3000 }) => {
  try {
    const serverInfo = activeOAuthServers.get(port);

    if (serverInfo) {
      console.log(`[OAuth] Canceling server on port ${port}`);
      serverInfo.server.close();
      if (serverInfo.timeoutId) clearTimeout(serverInfo.timeoutId);
      serverInfo.cleanup({
        success: false,
        message: 'OAuth authorization canceled by user'
      });
      return { success: true };
    }

    return { success: false, message: 'Server not found' };
  } catch (error) {
    console.error('[oauth:cancel-server]', error);
    return { success: false, message: error.message };
  }
});

/**
 * dbconn:list-plugins — list all available connector plugins
 * Returns { success, connectors: [{ id, name, type, icon, version, description, configSchema }] }
 */
ipcMain.handle('dbconn:list-plugins', async () => {
  try {
    const connectors = pluginManager.listConnectors();
    return { success: true, connectors };
  } catch (err) {
    return { success: false, message: err.message, connectors: [] };
  }
});

/**
 * plugins:install — download and install a plugin from the backend server
 * Returns { success, message }
 */
ipcMain.handle('plugins:install', async (_event, { pluginId }) => {
  try {
    const https = require('https');
    const http = require('http');
    const AdmZip = require('adm-zip');

    // Plugin download URL
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    const downloadUrl = `${backendUrl}/api/plugins/download/${pluginId}`;

    console.log(`Downloading plugin ${pluginId} from ${downloadUrl}`);

    // Download plugin zip file
    const protocol = downloadUrl.startsWith('https') ? https : http;

    return new Promise((resolve) => {
      protocol.get(downloadUrl, (response) => {
        if (response.statusCode !== 200) {
          resolve({
            success: false,
            message: `Failed to download plugin: HTTP ${response.statusCode}`
          });
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);

            // Extract zip to plugins directory
            const zip = new AdmZip(buffer);
            const pluginDir = path.join(__dirname, '../plugins/connectors', pluginId);

            // Remove existing plugin directory if it exists
            if (fs.existsSync(pluginDir)) {
              fs.rmSync(pluginDir, { recursive: true, force: true });
            }

            // Create plugin directory
            fs.mkdirSync(pluginDir, { recursive: true });

            // Extract all files (including node_modules)
            zip.extractAllTo(pluginDir, true);

            console.log(`Plugin ${pluginId} installed to ${pluginDir}`);

            // Reload plugins
            pluginManager.loadPlugins();

            resolve({
              success: true,
              message: `Plugin ${pluginId} installed successfully`
            });
          } catch (extractError) {
            console.error('Extract error:', extractError);
            resolve({
              success: false,
              message: `Failed to extract plugin: ${extractError.message}`
            });
          }
        });

        response.on('error', (err) => {
          console.error('Download error:', err);
          resolve({
            success: false,
            message: `Download failed: ${err.message}`
          });
        });
      }).on('error', (err) => {
        console.error('HTTP error:', err);
        resolve({
          success: false,
          message: `Connection failed: ${err.message}`
        });
      });
    });
  } catch (error) {
    console.error('Plugin installation error:', error);
    return {
      success: false,
      message: `Installation failed: ${error.message}`
    };
  }
});

/**
 * plugins:uninstall — remove an installed plugin
 * Returns { success, message }
 */
ipcMain.handle('plugins:uninstall', async (_event, { pluginId }) => {
  try {
    const pluginDir = path.join(__dirname, '../plugins/connectors', pluginId);

    if (!fs.existsSync(pluginDir)) {
      return {
        success: false,
        message: 'Plugin not found'
      };
    }

    // Unload plugin first
    pluginManager.unloadPlugin(pluginId);

    // Remove plugin directory
    fs.rmSync(pluginDir, { recursive: true, force: true });

    console.log(`Plugin ${pluginId} uninstalled`);

    return {
      success: true,
      message: `Plugin ${pluginId} uninstalled successfully`
    };
  } catch (error) {
    console.error('Plugin uninstallation error:', error);
    return {
      success: false,
      message: `Uninstallation failed: ${error.message}`
    };
  }
});

/**
 * Cloud Storage Handlers
 */

// Get containers/buckets from cloud storage
ipcMain.handle('cloud-storage:get-containers', async (_event, { connectionId, dbType }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's getContainers method
    const result = await plugin.getContainers(fullConfig, connectionId);
    return result;
  } catch (error) {
    console.error('Get containers error:', error);
    return { success: false, message: error.message };
  }
});

// List objects in a cloud storage container
ipcMain.handle('cloud-storage:list-objects', async (_event, { connectionId, dbType, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '' }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's listObjects method with pagination and search
    const result = await plugin.listObjects(
      fullConfig,
      connectionId,
      containerName,
      prefix,
      maxKeys,
      continuationToken,
      searchTerm
    );
    return result;
  } catch (error) {
    console.error('List objects error:', error);
    return { success: false, message: error.message };
  }
});

// Download object from cloud storage
ipcMain.handle('cloud-storage:download-object', async (_event, { connectionId, dbType, containerName, objectName }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's downloadObject method
    const result = await plugin.downloadObject(fullConfig, connectionId, containerName, objectName);
    return result;
  } catch (error) {
    console.error('Download object error:', error);
    return { success: false, message: error.message };
  }
});

// Export Google Workspace file
ipcMain.handle('cloud-storage:export-object', async (_event, { connectionId, dbType, fileId, mimeType }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    if (typeof plugin.exportObject !== 'function') {
      return { success: false, message: 'Export not supported for this connector' };
    }

    // Call plugin's exportObject method
    const result = await plugin.exportObject(fullConfig, connectionId, fileId, mimeType);
    return result;
  } catch (error) {
    console.error('Export object error:', error);
    return { success: false, message: error.message };
  }
});

// Analyze Excel file for sheet names
ipcMain.handle('file-reader:analyze-excel', async (_event, fileData) => {
  try {
    const XLSX = require('xlsx');

    // Convert Buffer to workbook
    const workbook = XLSX.read(fileData, { type: 'buffer' });

    return {
      success: true,
      sheets: workbook.SheetNames
    };
  } catch (error) {
    console.error('Excel analysis error:', error);
    return {
      success: false,
      message: error.message,
      sheets: ['Sheet1'] // Fallback
    };
  }
});

// Get Google Picker credentials for frontend integration
ipcMain.handle('cloud-storage:get-picker-credentials', async (_event, { connectionId, dbType }) => {
  try {
    const connectionsDb = getDb('connections');
    const connections = await connectionsDb.findAsync({});
    const connection = connections.find(c => c.id === connectionId);

    if (!connection) {
      return { success: false, message: 'Connection not found' };
    }

    const fullConfig = await getFullConfig(connectionId, connection.dbConfig);

    if (!pluginManager.hasConnector(dbType)) {
      return { success: false, message: `Connector ${dbType} not found` };
    }

    const plugin = pluginManager.getConnector(dbType);

    if (typeof plugin.getPickerCredentials !== 'function') {
      return { success: false, message: 'Picker not supported for this connector' };
    }

    return await plugin.getPickerCredentials(fullConfig, connectionId);
  } catch (error) {
    console.error('[Picker Credentials] Error:', error);
    return { success: false, message: error.message };
  }
});

// Import file from cloud storage to local SQLite/NeDB
ipcMain.handle('cloud-storage:import-file', async (_event, { data, fileName, fileType, sheetName, containerName, connectionName }) => {
  try {
    const tmpDir = path.join(app.getPath('temp'), 'dagflux-cloud-imports');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Extract just the filename (remove any path components)
    const baseFileName = path.basename(fileName);

    // Write data to temporary file
    const tmpFilePath = path.join(tmpDir, baseFileName);
    fs.writeFileSync(tmpFilePath, Buffer.from(data));

    // Determine storage type (SQLite for structured data, NeDB for JSON)
    const ext = path.extname(baseFileName).toLowerCase();
    let result;

    // Sanitize container name for use as table prefix
    const sanitizedContainerName = (containerName || 'cloud')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .substring(0, 32); // Limit prefix length

    console.log('[Cloud Import] File:', baseFileName, 'Container:', containerName, 'Prefix:', sanitizedContainerName)
    if (ext === '.json') {
      // Import to NeDB with container prefix
      const baseCollectionName = path.basename(baseFileName, ext).replace(/[^a-zA-Z0-9_]/g, '_');
      const collectionName = `${sanitizedContainerName}_${baseCollectionName}`;

      console.log('[Cloud Import] Preparing NeDB import:', {
        baseFileName,
        containerName,
        baseCollectionName,
        collectionName
      });

      result = await new Promise((resolve) => {
        // Reuse existing import-to-nedb logic
        const userDataPath = app.getPath('userData');
        const dbDir = path.join(userDataPath, 'internal_databases');
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = path.join(dbDir, `${collectionName}.db`);
        const db = new Datastore({ filename: dbPath });

        db.loadDatabase((err) => {
          if (err) {
            resolve({ success: false, message: err.message });
            return;
          }

          const jsonData = JSON.parse(fs.readFileSync(tmpFilePath, 'utf8'));
          const docs = Array.isArray(jsonData) ? jsonData : [jsonData];

          db.insert(docs, (insertErr, newDocs) => {
            if (insertErr) {
              resolve({ success: false, message: insertErr.message });
            } else {
              resolve({
                success: true,
                localPath: dbPath,
                dbType: 'nedb',
                tables: [collectionName],
                message: `Imported ${newDocs.length} documents`
              });
            }
          });
        });
      });
    } else {
      // Import to SQLite (CSV, Excel, Parquet, Avro, etc.) with container prefix
      const baseTableName = path.basename(baseFileName, ext).replace(/[^a-zA-Z0-9_]/g, '_');
      const tableName = `${sanitizedContainerName}_${baseTableName}`;

      console.log('[Cloud Import] Preparing SQLite import:', {
        baseFileName,
        ext,
        containerName,
        baseTableName,
        tableName,
        tmpFilePath,
        dbPath: appSqliteDbPath
      });

      // If it's Excel with a specific sheet, we need to handle it differently
      if ((ext === '.xlsx' || ext === '.xls') && sheetName) {
        // Use XLSX to extract specific sheet to CSV first
        const XLSX = require('xlsx');
        const workbook = XLSX.readFile(tmpFilePath);
        const worksheet = workbook.Sheets[sheetName];
        const csvData = XLSX.utils.sheet_to_csv(worksheet);

        // Write CSV to temp file
        const csvTmpPath = tmpFilePath.replace(ext, '.csv');
        fs.writeFileSync(csvTmpPath, csvData);

        // Add sheet name to table name
        const sanitizedSheetName = String(sheetName)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/^[0-9]/, '_$&')
          .substring(0, 64);
        const tableNameWithSheet = `${tableName}_${sanitizedSheetName}`;

        // Import CSV to SQLite with sheet name included
        result = await new Promise((resolve) => {
          const sqlite3 = require('sqlite3').verbose();
          const db = new sqlite3.Database(appSqliteDbPath);

          importCsvToSqlite(csvTmpPath, tableNameWithSheet, db, appSqliteDbPath)
            .then(importResult => {
              db.close();
              resolve({
                ...importResult,
                localPath: appSqliteDbPath,
                dbType: 'sqlite',
                sheetName: sheetName // Include original sheet name
                // Use tables from importResult (it returns the correct table name with sheet suffix)
              });
            })
            .catch(err => {
              db.close();
              resolve({ success: false, message: err.message });
            });
        });

        // Clean up CSV temp file
        if (fs.existsSync(csvTmpPath)) {
          fs.unlinkSync(csvTmpPath);
        }
      } else {
        // Standard import
        result = await new Promise((resolve) => {
          const sqlite3 = require('sqlite3').verbose();
          const db = new sqlite3.Database(appSqliteDbPath);


          console.log('[Cloud Import] extension:', ext);

          let importPromise;
          if (ext === '.csv') {
            importPromise = importCsvToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
          } else if (ext === '.parquet') {
            importPromise = importParquetToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
          } else if (ext === '.avro') {
            importPromise = importAvroToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
          } else {
            importPromise = importSpreadsheetToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
          }

          importPromise
            .then(importResult => {
              db.close();
              resolve({
                ...importResult,
                localPath: appSqliteDbPath,
                dbType: 'sqlite',
                tables: [tableName]
              });
            })
            .catch(err => {
              db.close();
              resolve({ success: false, message: err.message });
            });
        });
      }
    }

    // Clean up temp file
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }

    return result;
  } catch (error) {
    console.error('Cloud import error:', error);
    return {
      success: false,
      message: error.message
    };
  }
});

// Handle NeDB (local file) transformations
// ipcMain.handle('dbconn:transform-nedb', async (_event, {
//   sourceLocalPath,
//   targetCollection,
//   operationType,
//   nosqlOperation,
//   transformFunction,
//   operationMode
// }) => {
//   try {
//     if (!sourceLocalPath || !fs.existsSync(sourceLocalPath)) {
//       return { success: false, message: 'Source NeDB file not found' };
//     }

//     // Load source NeDB database
//     const sourceDb = new Datastore({ filename: sourceLocalPath });

//     return new Promise((resolve) => {
//       sourceDb.loadDatabase((loadErr) => {
//         if (loadErr) {
//           resolve({
//             success: false,
//             message: `Failed to load source database: ${loadErr.message}`
//           });
//           return;
//         }

//         let transformFn = null;
//         if (transformFunction) {
//           try {
//             transformFn = eval(`(${transformFunction})`);
//           } catch (err) {
//             resolve({
//               success: false,
//               message: `Failed to parse transform function: ${err.message}`
//             });
//             return;
//           }
//         }

//         // Handle different operation types
//         if (operationType === 'filter' || operationType === 'javascript') {
//           // Parse filter
//           const filter = nosqlOperation ? JSON.parse(nosqlOperation) : {};

//           sourceDb.find(filter, async (err, docs) => {
//             if (err) {
//               resolve({
//                 success: false,
//                 message: `Query failed: ${err.message}`
//               });
//               return;
//             }

//             let transformedDocs = docs;

//             // Apply transformation function if provided
//             if (transformFn) {
//               transformedDocs = docs
//                 .map(doc => transformFn(doc))
//                 .filter(doc => doc !== null && doc !== undefined);
//             }

//             // Save to target collection
//             const targetPath = path.join(app.getPath('userData'), 'local-collections', `${targetCollection}.db`);
//             const targetDir = path.dirname(targetPath);

//             if (!fs.existsSync(targetDir)) {
//               fs.mkdirSync(targetDir, { recursive: true });
//             }

//             // Delete existing file if in new_table mode
//             if (operationMode === 'new_table' && fs.existsSync(targetPath)) {
//               fs.unlinkSync(targetPath);
//             }

//             const targetDb = new Datastore({ filename: targetPath });
//             targetDb.loadDatabase((targetLoadErr) => {
//               if (targetLoadErr) {
//                 resolve({
//                   success: false,
//                   message: `Failed to create target database: ${targetLoadErr.message}`
//                 });
//                 return;
//               }

//               targetDb.insert(transformedDocs, (insertErr, newDocs) => {
//                 if (insertErr) {
//                   resolve({
//                     success: false,
//                     message: `Failed to insert documents: ${insertErr.message}`
//                   });
//                 } else {
//                   resolve({
//                     success: true,
//                     message: `Transformation completed. ${newDocs.length} documents saved to "${targetCollection}"`,
//                     documentsProcessed: docs.length,
//                     documentsInserted: newDocs.length,
//                     localPath: targetPath
//                   });
//                 }
//               });
//             });
//           });
//         } else if (operationType === 'delete') {
//           // Delete operation
//           const filter = JSON.parse(nosqlOperation);

//           if (operationMode === 'in_place') {
//             sourceDb.remove(filter, { multi: true }, (err, numRemoved) => {
//               if (err) {
//                 resolve({
//                   success: false,
//                   message: `Delete failed: ${err.message}`
//                 });
//               } else {
//                 resolve({
//                   success: true,
//                   message: `Deleted ${numRemoved} documents`,
//                   documentsProcessed: numRemoved
//                 });
//               }
//             });
//           } else {
//             resolve({
//               success: false,
//               message: 'Delete operation only supports in_place mode for NeDB'
//             });
//           }
//         } else if (operationType === 'update') {
//           // Update operation
//           const updateOp = JSON.parse(nosqlOperation);

//           if (operationMode === 'in_place') {
//             sourceDb.update(
//               updateOp.filter,
//               updateOp.update,
//               { multi: true },
//               (err, numUpdated) => {
//                 if (err) {
//                   resolve({
//                     success: false,
//                     message: `Update failed: ${err.message}`
//                   });
//                 } else {
//                   resolve({
//                     success: true,
//                     message: `Updated ${numUpdated} documents`,
//                     documentsProcessed: numUpdated
//                   });
//                 }
//               }
//             );
//           } else {
//             resolve({
//               success: false,
//               message: 'Update operation only supports in_place mode for NeDB'
//             });
//           }
//         } else {
//           resolve({
//             success: false,
//             message: `Unsupported operation type: ${operationType}. NeDB supports filter, javascript, delete, and update.`
//           });
//         }
//       });
//     });
//   } catch (error) {
//     return {
//       success: false,
//       message: `Transformation failed: ${error.message}`,
//       error: error.stack
//     };
//   }
// });



// Unified NoSQL transformation handler (routes to appropriate plugin or native NeDB)
ipcMain.handle('dbconn:transform-nosql', async (_event, {
  dbType,
  config,
  connectionId,
  sourceLocalPath,
  sourceCollection,
  targetCollection,
  operationType,
  nosqlOperation,
  transformFunction,
  storageLocation,
  operationMode
}) => {
  try {
    if (dbType === 'nedb') {
      // Use native NeDB transformation (local file operations)
      return await transformNeDB({
        sourceLocalPath,
        targetCollection,
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

      // If plugin indicates local storage is needed, save to local NeDB
      if (result.needsLocalStorage && result.transformedDocs) {
        return await saveToLocalNeDB(
          targetCollection,
          result.transformedDocs,
          operationMode,
          result.totalProcessed
        );
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
});

// SQL transformation handler (for PostgreSQL, MySQL, MSSQL, SQLite, CSV, Excel)
ipcMain.handle('dbconn:transform-sql', async (_event, {
  dbType,
  config,
  connectionId,
  ddl,
  sql,
  previewSql,
  storageLocation,
  operationMode,
  targetTableName,
  sourceLocalPath = null,
  insertSql = null
}) => {
  try {
    // LOCAL SQL
    if(dbType === 'sqlite'){
      if (operationMode === 'in_place') {
        // For SQLite in-place operations, execute DDL (ALTER TABLE) and/or UPDATE/DELETE on the app database
        return Sqlite.inPlaceLocalUpdate(appSqliteDbPath, ddl, sql, targetTableName)
      } else {
        // For SQLite new table operations, create table and execute INSERT
        return Sqlite.createLocalTable(appSqliteDbPath, ddl, sql, targetTableName)
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
          const dropQuery = `DROP TABLE IF EXISTS ${targetTableName}`;
          await plugin.runQuery(fullConfig, connectionId, { query: dropQuery });
        }

        // Execute DDL
        const ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
        if (!ddlResult.success) {
          return {
            success: false,
            message: `DDL execution failed: ${ddlResult.message}`
          };
        }

        // Execute INSERT
        const sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
        if (!sqlResult.success) {
          return {
            success: false,
            message: `SQL execution failed: ${sqlResult.message}`
          };
        }

        // Success - return result
        return {
          success: true,
          message: `Table created and ${sqlResult.rowCount || 0} rows inserted`,
          rowCount: sqlResult.rowCount || 0
        };

      } else if (storageLocation === 'local') {
        // Pull data from remote database and save to local SQLite app database
        // This works for all SQL databases (PostgreSQL, MySQL, MSSQL)
        const fullConfig = await getFullConfig(connectionId, config);

        if (!pluginManager.hasConnector(dbType)) {
          return {
            success: false,
            message: `Database type ${dbType} is not supported. Cannot pull data to local storage.`
          };
        }

        const plugin = pluginManager.getConnector(dbType);
        return Sqlite.databaseToLocal(fullConfig, plugin, connectionId, sql, ddl, insertSql, targetTableName, appSqliteDbPath)
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
});

/**
 * Execute Join Operation
 * Handles joining multiple data sources with SQL or NoSQL destinations
 */
ipcMain.handle('dbconn:execute-join', async (_event, {
  destinationConnection,
  joinConfig,
  operationMode = 'new_table'
}) => {
  try {
    const CHUNK_SIZE = 1000;
    const isNoSQL = ['mongodb', 'nedb'].includes(destinationConnection.dbType);
    const isLocalStorage = ['sqlite', 'nedb'].includes(destinationConnection.dbType);
    const targetTableName = joinConfig.targetTableName || joinConfig.targetCollection;

    console.log(`[Join] Starting ${isNoSQL ? 'NoSQL' : 'SQL'} join operation`);
    console.log(`[Join] Destination: ${destinationConnection.dbType}, Mode: ${operationMode}`);

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

        const sourceData = await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);

        console.log(`[NoSQL Join] Loaded ${sourceData.length} rows from source ${i + 1}`);
        sourceDataArrays.push(sourceData);
      }

      // Step 2: Execute JavaScript join function
      console.log(`[NoSQL Join] Executing join function...`);
      const joinFunction = eval(`(${javascriptFunction})`);
      const joinedResults = joinFunction(...sourceDataArrays);

      console.log(`Join_produced:`, destinationConnection);

      // Step 3: Insert into destination
      if (isLocalStorage) {
        // Save to local NeDB
        const result = await saveToLocalNeDB(
          targetTableName,
          joinedResults,
          operationMode,
          joinedResults.length
        );
        return result;
      } else {
        // Insert into remote NoSQL database
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

      // Check if destination is local SQLite
      const isLocalSQLite = destinationConnection.dbType === 'sqlite';
      // console.log('sourcesConfig: ', joinSql, targetDdl, sourcesConfig)
      if (isLocalSQLite) {
        // ===== LOCAL SQLITE JOIN =====
        return await executeLocalSQLiteJoin(
          appSqliteDbPath,
          sourcesConfig,
          targetDdl,
          joinSql,
          targetTableName,
          operationMode,
          pluginManager,
          getFullConfig
        );
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
          // For temp tables, use the name as provided in the config (already properly formatted in DDL)
          // Don't add additional quoting/schema qualification as it may already be included
          await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${tempTableName}`});
        } catch (err) {
          // Ignore errors if table doesn't exist
          console.log(`Ignoring drop table error for ${tempTableName}: ${err.message}`);
        }

        // Create temp table
        await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: sourceConfig.ddl});

        // Load data from source
        const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
        const isNoSQLSource = ['mongodb', 'nedb'].includes(sourceConnection.dbType);

        // Get selectedColumns from sourceConfig
        const selectedColumns = sourceConfig.selectedColumns;
        if (!selectedColumns || selectedColumns.length === 0) {
          throw new Error(`No selectedColumns found for source ${sourceConfig.sourceNodeId}`);
        }

        let totalInserted = 0;

        if (isNoSQLSource) {
          // NoSQL source: Load all data into memory, then batch insert
          // console.log(`[SQL Join] Loading NoSQL source ${i + 1}...`);

          const sourceData = await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);
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
            }
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
          await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${targetTableName}`});
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
    console.error('Join execution error:', error);
    return {
      success: false,
      message: `Join execution failed: ${error.message}`,
      error: error.stack
    };
  }
});

/**
 * Execute Output Operation
 * Handles exporting data to local files or database connections
 */
ipcMain.handle('dbconn:execute-output', async (_event, sourceConnection, sourceTableSchema, outputSettings) => {
  return await executeOutput(
    sourceConnection,
    sourceTableSchema,
    outputSettings,
    pluginManager,
    getFullConfig,
    getDb
  );
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'DagFlux',
    show: false,
  });

  if (!app.isPackaged) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../build/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Initialize single SQLite database for the app
  initializeAppDatabase();

  // Load connector plugins
  pluginManager.loadPlugins();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
