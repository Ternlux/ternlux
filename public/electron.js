const { app, BrowserWindow, shell, ipcMain, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Datastore = require('@seald-io/nedb');
const pluginManager = require('./pluginManager');
const aiProviders = require('./aiProviders');
const analytics = require('./analytics');

// Patch ipcMain.handle FIRST so every IPC handler registered below is
// automatically wrapped with anonymous analytics tracking (channel name,
// duration, success). Opt-in is OFF until the renderer pushes the user's
// choice via `analytics:set-opt-in`.
analytics.patchIpcMain(ipcMain);

// Vector libs live at host level (public/lib) so they're available even when
// the vector-db-executor plugin isn't installed. They're imported once here
// and shared with every skill via the helpers bundle, so no skill ever has
// to require across plugin directories.
const vectorEmbeddings = require('./lib/embeddings');
const vectorLanceDB    = require('./lib/lancedb');
const localNeDB        = require('./lib/nedb');
const localSQLite      = require('./lib/sqlite');
const { executeOutput } = require('./NodeExecution/outputExecutionHelpers');
const { addExecutionLog, executeNode } = require('./NodeExecution/workflowExecutionHelpers');
const nodeExecution = require('./NodeExecution/NodeExecution');
const apiFetch = require('./NodeExecution/ApiFetch');
const { importParquetToSqlite, importAvroToSqlite, importSpreadsheetToSqlite, importCsvToSqlite } = require('./imports/importHelpers');
const SqliteConnectionPool = require('./SqliteConnectionPool');
const { registerCronJob, unregisterCronJob, getActiveCronJobs, stopAllCronJobs } = require('./triggers/cronTriggers');
const { registerFileWatcher, unregisterFileWatcher, getActiveFileWatchers, stopAllFileWatchers } = require('./triggers/fileWatchTriggers');
const { registerAllWorkflowTriggers } = require('./triggers/registerAllTriggers');
const chatAssistant = require('./chat/chatAssistant');

// Ensure the same userData directory is used in both dev and production,
// so a key saved during development persists when the packaged app is launched.
app.setName('DagFlux');

// Single SQLite database path for all local transformations
let appSqliteDbPath = null;
let sqlitePool = null;

// Per-path NeDB Datastore cache. NeDB's loadDatabase rewrites `<file>.db~`
// and renames it to `<file>.db`; running two Datastore instances concurrently
// on the same path races that rename and one fails with ENOENT. Sharing a
// single instance per path serializes operations through NeDB's executor.
const nedbInstanceCache = new Map();
async function getOrLoadNedb(filePath) {
  let entry = nedbInstanceCache.get(filePath);
  if (!entry) {
    const db = new Datastore({ filename: filePath, autoload: false });
    const loaded = new Promise((resolve, reject) => {
      db.loadDatabase((err) => (err ? reject(err) : resolve(db)));
    });
    entry = { db, loaded };
    nedbInstanceCache.set(filePath, entry);
    try {
      await loaded;
    } catch (err) {
      nedbInstanceCache.delete(filePath);
      throw err;
    }
  } else {
    await entry.loaded;
  }
  return entry.db;
}

/**
 * Initialize the SQLite connection pool
 * All local SQL transformations will use this persistent connection
 */
async function initializeAppDatabase() {
  appSqliteDbPath = path.join(app.getPath('userData'), 'app-data.db');

  // Create and initialize the connection pool
  sqlitePool = new SqliteConnectionPool(appSqliteDbPath);
  await sqlitePool.initialize();

  console.log('App SQLite connection pool initialized at:', appSqliteDbPath);
  return appSqliteDbPath;
}

// Path to the encrypted config file stored in the app's user-data directory.
// Written only after the app is ready so app.getPath() is safe to call.
function getConfigPath() {
  return path.join(app.getPath('userData'), 'llm-config.dat');
}

/**
 * Load all API keys from encrypted storage
 * @returns {Object|null} - Object with provider keys { claude, gemini, chatgpt, openai, huggingface } or null
 */
function loadApiKeys() {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;

    const b64 = fs.readFileSync(configPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[loadApiKeys]', err);
    return null;
  }
}

/**
 * Check if an API key exists for a specific provider
 * @param {string} provider - Provider name (openai, huggingface, claude, gemini, chatgpt)
 * @returns {boolean}
 */
function hasApiKeyForProvider(provider) {
  const allKeys = loadApiKeys();
  if (!allKeys) return false;

  // Normalize provider name
  const providerMap = {
    'chatgpt': 'chatgpt',
    'gemini': 'gemini',
    'claude': 'claude',
    'openai': 'chatgpt', // OpenAI uses chatgpt key
    'huggingface': 'huggingface'
  };

  const normalizedProvider = providerMap[provider.toLowerCase()] || provider.toLowerCase();
  return !!(allKeys[normalizedProvider]);
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

// Terms & Conditions acceptance is persisted to a file in userData so it
// survives across launches reliably — renderer localStorage was unreliable
// here because the productName/package name mismatch can shift the storage
// origin between dev and packaged runs.
function getTermsConfigPath() {
  return path.join(app.getPath('userData'), 'terms-acceptance.json');
}

ipcMain.handle('terms:get', () => {
  try {
    const p = getTermsConfigPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('[terms:get]', err);
    return null;
  }
});

ipcMain.handle('terms:save', (_event, record = {}) => {
  try {
    const p = getTermsConfigPath();
    fs.writeFileSync(p, JSON.stringify(record), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[terms:save]', err);
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
      // Read NeDB file via shared per-path Datastore (avoids rename race).
      let localDb;
      try {
        localDb = await getOrLoadNedb(filePath);
      } catch (loadErr) {
        return {
          success: false,
          message: `Failed to load local collection: ${loadErr.message}`
        };
      }

      return new Promise((resolve) => {
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
ipcMain.handle('import-to-sqlite', async (_event, { filePath, tableName, fileType, sheets = [] }) => {
  try {
    const path = require('path');

    // Use the app-wide SQLite database
    if (!appSqliteDbPath) {
      return {
        success: false,
        message: 'App database not initialized'
      };
    }

    if (!sqlitePool) {
      return {
        success: false,
        message: 'SQLite connection pool not initialized'
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

    // Determine file type from extension if not provided
    const ext = path.extname(filePath).toLowerCase();
    const detectedFileType = fileType || (
      ext === '.parquet' ? 'parquet' :
      ext === '.avro' ? 'avro' :
      'spreadsheet'
    );

    // Use connection pool for import
    return await sqlitePool.executeWrite(async (db) => {
      // Route to appropriate parser based on file type
      if (detectedFileType === 'parquet') {
        return await importParquetToSqlite(filePath, sanitizedTableName, db, dbPath);
      } else if (detectedFileType === 'avro') {
        return await importAvroToSqlite(filePath, sanitizedTableName, db, dbPath);
      } else {
        // Default: CSV/Excel import
        // sheets parameter: empty array = import all sheets, specific sheets = import only those
        return await importSpreadsheetToSqlite(filePath, sanitizedTableName, db, dbPath, sheets);
      }
    });
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

/**
 * list-lancedb-tables — List all tables in a LanceDB database directory
 * Returns { success, tables: string[], message }
 */
ipcMain.handle('list-lancedb-tables', async (_event, dbPath) => {
  try {
    if (!dbPath || !fs.existsSync(dbPath)) {
      return {
        success: false,
        message: 'LanceDB directory not found',
        tables: []
      };
    }

    // Get vector-db-executor skill via pluginManager
    const vectorSkill = pluginManager.getSkill('vector-db-executor');
    if (!vectorSkill) {
      return {
        success: false,
        message: 'Vector database executor skill not found. Please install the vector-db-executor skill.',
        tables: []
      };
    }

    // Call the skill's method to list tables
    const helpers = await buildSkillHelpers();
    const result = await vectorSkill.listLanceDBTables({ dbPath, helpers });

    return result;
  } catch (err) {
    console.error('List LanceDB tables error:', err);
    return {
      success: false,
      message: err.message,
      tables: []
    };
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

    // Step 7: Use connection pool to insert data into app-data.db
    if (!sqlitePool) {
      return {
        success: false,
        message: 'SQLite connection pool not initialized'
      };
    }

    return await sqlitePool.executeWrite(async (db) => {
      // Drop table if exists
      await new Promise((resolve, reject) => {
        db.run(`DROP TABLE IF EXISTS "${sanitizedTableName}"`, (dropErr) => {
          if (dropErr) reject(new Error(`Failed to drop existing table: ${dropErr.message}`));
          else resolve();
        });
      });

      // Create table
      await new Promise((resolve, reject) => {
        db.run(ddl, (createErr) => {
          if (createErr) reject(new Error(`Failed to create table: ${createErr.message}`));
          else resolve();
        });
      });

      // Insert data in chunks
      const CHUNK_SIZE = 1000;
      let processedRows = 0;

      const processChunk = async (startIndex) => {
        const endIndex = Math.min(startIndex + CHUNK_SIZE, rows.length);
        const chunk = rows.slice(startIndex, endIndex);

        await new Promise((resolve, reject) => {
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
              reject(finalizeErr);
            } else {
              processedRows += chunk.length;
              resolve();
            }
          });
        });

        if (endIndex < rows.length) {
          // Process next chunk
          await processChunk(endIndex);
        }
      };

      // Start processing chunks
      await processChunk(0);

      return {
        success: true,
        localPath: appSqliteDbPath,
        tableName: sanitizedTableName,
        rowCount: processedRows,
        message: `Imported ${processedRows} rows from Google Sheet`
      };
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
          // console.log('sourceSchemaClean: ', sourceSchemaClean)
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
    pluginManager.unloadConnector(pluginId);

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
 * Skills Plugin Handlers
 */

/**
 * skills:listInstalled — list all installed skill plugins
 * Returns { success, skills: [...] }
 */
ipcMain.handle('skills:listInstalled', async () => {
  try {
    const skills = pluginManager.listSkills();
    return { success: true, skills };
  } catch (err) {
    return { success: false, message: err.message, skills: [] };
  }
});

/**
 * skills:getByCategory — get skills filtered by category
 * Returns { success, skills: [...] }
 */
ipcMain.handle('skills:getByCategory', async (_event, category) => {
  try {
    const skills = pluginManager.getSkillsByCategory(category);
    return { success: true, skills };
  } catch (err) {
    return { success: false, message: err.message, skills: [] };
  }
});

// ---------------------------------------------------------------------------
// AI provider IPC — the renderer never sees decrypted keys; everything goes
// through these handlers, which delegate to public/aiProviders.js.
// ---------------------------------------------------------------------------

/**
 * ai:call — invoke the configured/requested AI provider with the prompt.
 * Returns { success, text } or { success: false, message }.
 */
ipcMain.handle('ai:call', async (_event, { prompt, options = {} } = {}) => {
  try {
    const apiKeys = loadApiKeys();
    if (!apiKeys) {
      return { success: false, message: 'No API keys configured. Set one up in settings.' };
    }
    const text = await aiProviders.callAIWithKeys(prompt, { ...options, apiKeys });
    return { success: true, text };
  } catch (err) {
    console.error('[ai:call]', err);
    return { success: false, message: err.message };
  }
});

/**
 * ai:listProviders — providers that have a usable key configured.
 * Returns { success, providers: ['openai', ...] }.
 */
ipcMain.handle('ai:listProviders', async () => {
  const apiKeys = loadApiKeys() || {};
  return { success: true, providers: aiProviders.listAvailableProviders(apiKeys) };
});

/**
 * chat:step — one turn of the agentic chat assistant. The renderer drives
 * the loop: each call performs ONE AI turn, executes whatever tools the
 * model asked for (possibly several in a single turn), and returns the
 * step result. The renderer issues another `chat:step` (with the previous
 * step appended to `scratchpad`) until `done: true`. Cancel = stop calling.
 * See public/chat/chatAssistant.js for the tool catalogue.
 */
ipcMain.handle('chat:step', async (_event, {
  message,
  history = [],
  scratchpad = [],
  activeContext = null,
  provider = null,
} = {}) => {
  try {
    const helpers = await buildSkillHelpers();
    return await chatAssistant.runStep({
      message,
      history,
      scratchpad,
      activeContext,
      provider,
      getDb,
      helpers,
    });
  } catch (err) {
    console.error('[chat:step]', err);
    return { success: false, message: err.message };
  }
});

// ---------------------------------------------------------------------------
// Analytics opt-in control. The renderer pushes the current value at startup
// (App.js) and whenever the user toggles it (PrivacySettings / Terms).
// ---------------------------------------------------------------------------

ipcMain.handle('analytics:set-opt-in', async (_event, { optIn } = {}) => {
  try {
    analytics.setOptIn(!!optIn);
    return { success: true, optIn: analytics.getOptIn() };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------------------------------------------------------------------------
// Skill helpers — a single bundle of injectables given to skills via params,
// so a skill never has to require anything outside its own directory or
// node_modules.
// ---------------------------------------------------------------------------

/**
 * Look up a saved connection by name or id from a connections array.
 */
function findConnection(connections, ref) {
  if (!ref) return null;
  return (
    connections.find((c) => (c.id || c._id) === ref) ||
    connections.find((c) => c.name === ref) ||
    null
  );
}

async function loadConnectionsFromDb() {
  try {
    const db = getDb('connections');
    return await db.findAsync({});
  } catch (e) {
    console.warn('[skill helpers] Could not load connections:', e.message);
    return [];
  }
}

/**
 * Build the helper bundle injected into every skill IPC call. The skill (and
 * any AI-generated function it runs) only needs these helpers — never an
 * import that reaches across plugin folders or into the renderer source.
 */
/**
 * @param {string|null} [defaultDbPath] - Optional fallback for local file
 *   connections (nedb / sqlite / lancedb). When a runQuery / getTables /
 *   getColumns call passes its own `dbPath`, that wins. When neither is
 *   provided, the call is treated as a saved-connection lookup.
 */
async function buildSkillHelpers(defaultDbPath = null) {
  const apiKeys = loadApiKeys() || {};
  const connections = await loadConnectionsFromDb();

  const LOCAL_DB_TYPES = new Set(['nedb', 'sqlite', 'lancedb']);
  const localLib = (dbType) => {
    if (dbType === 'nedb')    return localNeDB;
    if (dbType === 'sqlite')  return localSQLite;
    if (dbType === 'lancedb') return vectorLanceDB;
    return null;
  };

  /**
   * Decide whether a call should be served by a local lib (returns
   * { dbType, dbPath, lib }) or by a saved-connection lookup (returns null).
   *
   * Routing rule: local iff a dbPath is available (per-call or default) AND
   * `connection` identifies one of the local dbTypes — either a string name
   * matching nedb/sqlite/lancedb, or an object that carries a matching
   * `dbType`.
   */
  const resolveLocal = (connection, perCallDbPath) => {
    const dbPath = perCallDbPath || defaultDbPath;
    if (!dbPath) return null;
    let dbType = null;
    if (typeof connection === 'string' && LOCAL_DB_TYPES.has(connection)) {
      dbType = connection;
    } else if (connection && typeof connection === 'object' && LOCAL_DB_TYPES.has(connection.dbType)) {
      dbType = connection.dbType;
    }
    if (!dbType) return null;
    return { dbType, dbPath, lib: localLib(dbType) };
  };

  const requireConnection = (ref) => {
    const conn = findConnection(connections, ref);
    if (!conn) {
      const names = connections.map((c) => c.name).join(', ');
      throw new Error(`Connection not found: ${ref}. Available: ${names || 'none'}`);
    }
    return conn;
  };

  const requireConnector = (conn) => {
    const connector = pluginManager.getConnector(conn.dbType);
    if (!connector) throw new Error(`No connector registered for dbType: ${conn.dbType}`);
    return connector;
  };

  /**
   * runQuery(connection, query, dbPath = null)
   *  - dbPath is non-null → local file (nedb / sqlite / lancedb), connection
   *    is the dbType string ('nedb' | 'sqlite' | 'lancedb')
   *  - dbPath is null     → saved connection looked up by name/id
   *
   * Replaces the old separate sqliteQuery / nedbReadFile / nedbWriteFile /
   * writeLanceDB helpers — every store is reachable through this one entry.
   */
  async function runQuery(connection, query, dbPath = null) {
    const local = resolveLocal(connection, dbPath);
    if (local) {
      const queryObj = (query && typeof query === 'object') ? query : { query };
      return local.lib.runQuery({ ...queryObj, dbPath: local.dbPath });
    }
    const conn = requireConnection(connection);
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    const queryObj = typeof query === 'string'
      ? { query, limit: 1000000 }
      : { limit: 1000000, ...query };
    const result = await connector.runQuery(fullConfig, id, queryObj);
    if (result && result.success === false) throw new Error(result.message || 'runQuery failed');
    return result.rows || result.data || [];
  }

  async function getTables(connection, dbPath = null) {
    const local = resolveLocal(connection, dbPath);
    if (local) return local.lib.getTables({ dbPath: local.dbPath });
    const conn = requireConnection(connection);
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    const result = await connector.getTables(fullConfig, id);
    return result.tables || [];
  }

  async function getColumns(connection, table, schema = null, dbPath = null) {
    const local = resolveLocal(connection, dbPath);
    if (local) return local.lib.getColumns({ dbPath: local.dbPath, table });
    const conn = requireConnection(connection);
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    const result = await connector.getColumns(fullConfig, id, schema, table);
    return result.columns || [];
  }

  /** Call AI from inside a skill or from generated code. Routes through aiProviders. */
  async function callAI(prompt, options = {}) {
    return aiProviders.callAIWithKeys(prompt, { ...options, apiKeys });
  }

  /** Generate embeddings using the shared vector-embeddings library. */
  async function vectorize(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const provider = options.provider || (apiKeys.chatgpt || apiKeys.openai ? 'openai' : 'huggingface');
    const apiKey = provider === 'openai'
      ? (apiKeys.chatgpt || apiKeys.openai)
      : apiKeys.huggingface;
    if (!apiKey) throw new Error(`No API key configured for embedding provider "${provider}"`);
    const model = options.model || (provider === 'openai'
      ? 'text-embedding-3-small'
      : 'sentence-transformers/all-MiniLM-L6-v2');
    const data = texts.map((t, idx) => ({ __idx: idx, text: typeof t === 'string' ? t : String(t) }));
    const result = await vectorEmbeddings.generateEmbeddings({ data, columnToEmbed: 'text', provider, model, apiKey });
    return result.map((r) => r.vector);
  }

  return {
    apiKeys,                                   // raw map (read-only use; do NOT echo to renderer)
    aiProviders: aiProviders.listAvailableProviders(apiKeys),
    embeddingProviders: [
      ...(apiKeys.chatgpt || apiKeys.openai ? ['openai'] : []),
      ...(apiKeys.huggingface ? ['huggingface'] : [])
    ],
    connections,                               // [{ _id/id, name, dbType, dbCategory, dbConfig, ... }]
    getConnection: requireConnection,
    callAI,
    runQuery,
    getTables,
    getColumns,
    vectorize,
    axios,
    // Full vector-lib modules — exposed so skills like vector-db-executor can
    // use every export (estimateOpenAICost, listTables, ...) without having
    // to require across plugin directories.
    embeddings: vectorEmbeddings,
    lancedb: vectorLanceDB,
    appSqliteDbPath,
    sqlitePool,
    pluginManager,
    getFullConfig
  };
}

/**
 * skills:getDescriptions — get skill descriptions for AI context
 * Returns { success, descriptions: [...] }
 */
ipcMain.handle('skills:getDescriptions', async (_event, category = null, context = {}) => {
  try {
    const descriptions = pluginManager.getSkillDescriptions(category, context);
    return { success: true, descriptions };
  } catch (err) {
    return { success: false, message: err.message, descriptions: [] };
  }
});

/**
 * skills:analyze — analyze a skill request and get follow-up questions or confirmation
 * Returns { success, action, followUpQuestion, questionsNeeded, skillParams, ... }
 */
ipcMain.handle('skills:analyze', async (_event, { skillId, params }) => {
  try {
    const result = await pluginManager.analyzeSkillRequest(skillId, params);
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:buildPrompt — build skill prompt for AI
 * Returns { success, prompt, context }
 */
ipcMain.handle('skills:buildPrompt', async (_event, { skillId, params }) => {
  try {
    params.helpers = await buildSkillHelpers();

    // Backward compatibility for vector-db-executor (kept until it migrates to helpers).
    if (skillId === 'vector-db-executor') {
      params.apiKeys = params.helpers.apiKeys;
      params.vectorConnectors = pluginManager.listConnectors()
        .filter((c) => c.dbCategory === 'Vector')
        .map((c) => ({ id: c.id, name: c.name }));
      params.pluginManager = pluginManager;
      params.getFullConfig = getFullConfig;
    }

    const result = await pluginManager.buildSkillPrompt(skillId, params);
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:processResponse — process AI response through skill
 * Returns { success, action, pythonCode, explanation, followUpQuestion, directAnswer, ... }
 */
ipcMain.handle('skills:processResponse', async (_event, { skillId, aiResponse, operationType, currentState = {}, availableConnections = [] }) => {
  try {
    const helpers = await buildSkillHelpers();
    const connections = availableConnections && availableConnections.length > 0
      ? availableConnections
      : helpers.connections;
    const result = await pluginManager.processSkillResponse(
      skillId,
      aiResponse,
      operationType,
      currentState,
      connections,
      helpers
    );
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message,
      action: 'ask_questions',
      followUpQuestion: `Error processing response: ${err.message}`
    };
  }
});

/**
 * skills:execute — execute a skill with given parameters
 * Returns { success, data, recordCount, ... }
 */
ipcMain.handle('skills:execute', async (_event, { skillId, params }) => {
  try {
    const helpers = await buildSkillHelpers();

    // Backward compatibility for vector-db-executor (kept until it migrates to helpers).
    let embeddingApiKey = params.embeddingApiKey;
    if (skillId === 'vector-db-executor' && !embeddingApiKey && params.embeddingProvider) {
      const apiKeys = helpers.apiKeys;
      if (params.embeddingProvider === 'openai') embeddingApiKey = apiKeys.chatgpt;
      else if (params.embeddingProvider === 'huggingface') embeddingApiKey = apiKeys.huggingface;
    }

    const enhancedParams = {
      ...params,
      helpers,
      // Legacy keys still consumed by vector-db-executor; new skills should
      // read everything from `helpers`.
      embeddingApiKey: embeddingApiKey || params.embeddingApiKey,
      pluginManager,
      getFullConfig,
      appSqliteDbPath,
      sqlitePool
    };

    const result = await pluginManager.executeSkill(skillId, enhancedParams);
    return result;
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:queryVectorPreview — get preview data from vector database
 * Returns { success, data, recordCount, isJson, storageType }
 */
ipcMain.handle('skills:queryVectorPreview', async (_event, params) => {
  try {
    const helpers = await buildSkillHelpers();
    const enhancedParams = {
      ...params,
      helpers,
      pluginManager,
      getFullConfig
    };

    const skill = pluginManager.getSkill('vector-db-executor');
    if (!skill || typeof skill.queryVectorPreview !== 'function') {
      return {
        success: false,
        message: 'Vector preview not available'
      };
    }

    const result = await skill.queryVectorPreview(enhancedParams);
    return result;
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
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
ipcMain.handle('cloud-storage:import-file', async (_event, { data, fileName, fileType, sheetName, sheets = [], containerName, connectionName }) => {
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

    // Support both old sheetName (string) and new sheets (array) parameters
    // If sheetName is provided (backward compatibility), convert to sheets array
    const sheetsToImport = sheets.length > 0 ? sheets : (sheetName ? [sheetName] : []);

    console.log('[Cloud Import] File:', baseFileName, 'Container:', containerName, 'Prefix:', sanitizedContainerName, 'Sheets:', sheetsToImport)
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

      // Standard import using connection pool
      if (!sqlitePool) {
        result = { success: false, message: 'SQLite connection pool not initialized' };
      } else {
        console.log('[Cloud Import] extension:', ext, 'sheets:', sheetsToImport);

        result = await sqlitePool.executeWrite(async (db) => {
          try {
            let importResult;
            if (ext === '.csv') {
              importResult = await importCsvToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
            } else if (ext === '.parquet') {
              importResult = await importParquetToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
            } else if (ext === '.avro') {
              importResult = await importAvroToSqlite(tmpFilePath, tableName, db, appSqliteDbPath);
            } else {
              // Pass sheets array to importSpreadsheetToSqlite
              // Empty array = import all sheets, specific sheets = import only those
              importResult = await importSpreadsheetToSqlite(tmpFilePath, tableName, db, appSqliteDbPath, sheetsToImport);
            }

            return {
              ...importResult,
              localPath: appSqliteDbPath,
              dbType: 'sqlite',
              sheets: sheetsToImport.length > 0 ? sheetsToImport : undefined // Include selected sheets info
            };
          } catch (err) {
            return { success: false, message: err.message };
          }
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


// Unified NoSQL transformation handler (routes to appropriate plugin or native NeDB)
ipcMain.handle('dbconn:transform-nosql', async (_event, params) => {
  return await nodeExecution.handleTransformNoSQL(params);
});

// SQL transformation handler (for PostgreSQL, MySQL, MSSQL, SQLite, CSV, Excel)
ipcMain.handle('dbconn:transform-sql', async (_event, params) => {
  console.log('params: ', params)
  return await nodeExecution.handleTransformSQL(params);
});

ipcMain.handle('dbconn:execute-join', async (_event, params) => {
  return await nodeExecution.handleExecuteJoin(params);
});

ipcMain.handle('dbconn:execute-branch', async (_event, params) => {
  return await nodeExecution.handleExecuteBranch(params);
});

/**
 * IPC: 'rest-api:execute-fetch'
 * Runs a REST API fetch plan authored on a DataSource node and materialises the
 * response into NeDB. Decrypts credentials in the main process only; never
 * returns resolved URL/headers/body to the renderer.
 */
ipcMain.handle('rest-api:execute-fetch', async (_event, params) => {
  return await apiFetch.handleExecuteApiFetch(params);
});

/**
 * Execute Output Operation
 * Handles exporting data to local files or database connections
 */
ipcMain.handle('dbconn:execute-output', async (_event, sourceConnection, sourceTableSchema, outputSettings) => {
  const skillHelpers = await buildSkillHelpers();
  return await executeOutput(
    sourceConnection,
    sourceTableSchema,
    outputSettings,
    pluginManager,
    getFullConfig,
    getDb,
    skillHelpers
  );
});

// ---------------------------------------------------------------------------
// Workflow Execution
// ---------------------------------------------------------------------------

/**
 * Execute an entire workflow using executionSteps from the workflow
 * Logs each step to the executions collection
 */
ipcMain.handle('workflow:execute', async (_event, { workflowId, workflowName, nodes, edges, executionSteps }) => {
  const executionsDb = getDb('executions');
  const startTime = new Date().toISOString();

  // Generate unique execution ID
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Create initial execution record
  const executionRecord = {
    executionId,
    workflowId,
    workflowName,
    status: 'running',
    startTime,
    endTime: null,
    duration: null,
    nodeExecutions: [],
    logs: [],
    results: {
      totalRecordsProcessed: 0,
      summary: ''
    },
    trigger: {
      type: 'manual',
      user: 'local'
    },
    username: 'local'
  };

  try {
    await executionsDb.insertAsync(executionRecord);

    // Build a map of node IDs to nodes
    const nodeMap = new Map();
    nodes.forEach(node => nodeMap.set(node.id, node));

    // Use executionSteps if provided, otherwise extract node IDs from nodes array
    const stepsToExecute = executionSteps && executionSteps.length > 0
      ? executionSteps.sort((a, b) => a.order - b.order)
      : nodes.map((node, index) => ({ nodeId: node.id, order: index }));

    const executionOrder = stepsToExecute.map(step => step.nodeId);

    console.log(`[Workflow Execution] Starting execution ${executionId}`);
    console.log(`[Workflow Execution] Execution order:`, executionOrder);

    // Add log entry
    await addExecutionLog(executionsDb, executionId, 'info', `Starting workflow execution: ${workflowName}`);

    let totalRecordsProcessed = 0;
    const nodeResults = new Map();

    // Prepare helpers object for node execution
    const helpers = {
      pluginManager,
      getFullConfig,
      getDb,
      appSqliteDbPath,
      sqlitePool,
      buildSkillHelpers          // available for output / vector skill calls
    };

    // Execute each node in order from executionSteps
    for (const step of stepsToExecute) {
      const nodeId = step.nodeId;
      const node = nodeMap.get(nodeId);

      if (!node) {
        console.warn(`[Workflow Execution] Node ${nodeId} not found in node map`);
        continue;
      }

      const nodeStartTime = Date.now();
      const nodeLabel = step.customName || step.nodeLabel || node.data?.label || node.id;

      await addExecutionLog(executionsDb, executionId, 'info', `Executing node: ${nodeLabel} (${node.type})`);

      try {
        // Execute the node using the helper function
        const nodeResult = await executeNode(node, nodeMap, edges, helpers);

        const nodeDuration = Date.now() - nodeStartTime;

        // Store node result
        nodeResults.set(nodeId, nodeResult);

        // Update node execution record
        const nodeExecution = {
          nodeId,
          nodeName: nodeLabel,
          nodeType: node.type,
          status: nodeResult?.success ? 'completed' : 'failed',
          startTime: new Date(nodeStartTime).toISOString(),
          duration: nodeDuration,
          error: nodeResult?.success ? null : { message: nodeResult?.message || 'Unknown error' },
          metrics: {
            recordsProcessed: nodeResult?.recordsProcessed || 0,
            recordsSuccess: nodeResult?.recordsProcessed || 0,
            recordsFailed: 0
          }
        };

        executionRecord.nodeExecutions.push(nodeExecution);

        if (nodeResult?.success) {
          totalRecordsProcessed += nodeResult?.recordsProcessed || 0;
          await addExecutionLog(executionsDb, executionId, 'info', `Node ${nodeLabel} completed successfully`);
        } else {
          await addExecutionLog(executionsDb, executionId, 'error', `Node ${nodeLabel} failed: ${nodeResult?.message || 'Unknown error'}`, nodeId);
          throw new Error(`Node ${nodeLabel} failed: ${nodeResult?.message || 'Unknown error'}`);
        }

      } catch (nodeError) {
        console.error(`[Workflow Execution] Error executing node ${nodeId}:`, nodeError);

        const nodeDuration = Date.now() - nodeStartTime;

        executionRecord.nodeExecutions.push({
          nodeId,
          nodeName: nodeLabel,
          nodeType: node.type,
          status: 'failed',
          startTime: new Date(nodeStartTime).toISOString(),
          duration: nodeDuration,
          error: { message: nodeError.message },
          metrics: {
            recordsProcessed: 0,
            recordsSuccess: 0,
            recordsFailed: 0
          }
        });

        await addExecutionLog(executionsDb, executionId, 'error', `Node execution failed: ${nodeError.message}`, nodeId);
        throw nodeError;
      }
    }

    // Workflow completed successfully
    const endTime = new Date().toISOString();
    const duration = Date.now() - new Date(startTime).getTime();

    executionRecord.status = 'completed';
    executionRecord.endTime = endTime;
    executionRecord.duration = duration;
    executionRecord.results.totalRecordsProcessed = totalRecordsProcessed;
    executionRecord.results.summary = `Successfully executed ${executionOrder.length} nodes`;
    executionRecord.executionOrder = executionOrder;

    await executionsDb.updateAsync(
      { executionId },
      { $set: executionRecord },
      {}
    );

    await addExecutionLog(executionsDb, executionId, 'info', `Workflow execution completed successfully`);

    console.log(`[Workflow Execution] Execution ${executionId} completed successfully`);

    return {
      success: true,
      executionId,
      message: 'Workflow executed successfully',
      results: executionRecord.results
    };

  } catch (error) {
    console.error(`[Workflow Execution] Execution ${executionId} failed:`, error);

    const endTime = new Date().toISOString();
    const duration = Date.now() - new Date(startTime).getTime();

    executionRecord.status = 'failed';
    executionRecord.endTime = endTime;
    executionRecord.duration = duration;
    executionRecord.error = {
      message: error.message,
      stack: error.stack
    };

    await executionsDb.updateAsync(
      { executionId },
      { $set: executionRecord },
      {}
    );

    await addExecutionLog(executionsDb, executionId, 'error', `Workflow execution failed: ${error.message}`);

    return {
      success: false,
      executionId,
      message: error.message,
      error: error.message
    };
  }
});

// ---------------------------------------------------------------------------
// Start Trigger Management (CRON and File Watchers)
// ---------------------------------------------------------------------------

// Track active workflow executions to prevent concurrent runs
const activeWorkflowExecutions = new Map();

/**
 * Execute a workflow from a trigger (CRON or file watcher)
 * @param {String} workflowId - Workflow ID to execute
 * @param {String} nodeId - Trigger node ID
 * @param {Object} triggerInfo - Information about the trigger
 * @returns {Promise<Object>} Execution result
 */
async function executeWorkflowFromTrigger(workflowId, nodeId, triggerInfo) {
  try {
    console.log('activeWorkflowExecutions: ', activeWorkflowExecutions)
    // Check if workflow is already executing
    if (activeWorkflowExecutions.has(workflowId)) {
      console.log(`[Trigger] Workflow ${workflowId} is already executing, skipping trigger`);
      return {
        success: false,
        message: 'Workflow is already executing',
        skipped: true
      };
    }

    // Mark workflow as executing
    activeWorkflowExecutions.set(workflowId, {
      startTime: new Date().toISOString(),
      nodeId: nodeId,
      trigger: triggerInfo
    });

    // Load workflow from database
    const workflowsDb = getDb('workflows');
    const workflow = await workflowsDb.findOneAsync({ id: workflowId });

    // console.log('workflow: ', workflow)
    if (!workflow) {
      console.error(`[Trigger] Workflow ${workflowId} not found`);
      activeWorkflowExecutions.delete(workflowId);
      return { success: false, message: 'Workflow not found' };
    }

    console.log(`[Trigger] Executing workflow: ${workflow.name}`);


    const notificationOptions = {
      title: 'DagFlux',
      body: `Workflow "${workflow.name}" is now running...`,
    };

    if (Notification.isSupported()) {
      new Notification(notificationOptions).show();
    }

    // Execute workflow
    const executionsDb = getDb('executions');
    const startTime = new Date().toISOString();
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create execution record
    const executionRecord = {
      executionId,
      workflowId,
      workflowName: workflow.name,
      status: 'running',
      startTime,
      endTime: null,
      duration: null,
      nodeExecutions: [],
      logs: [],
      results: {
        totalRecordsProcessed: 0,
        summary: ''
      },
      trigger: {
        ...triggerInfo,
        nodeId: nodeId
      },
      username: 'system'
    };

    await executionsDb.insertAsync(executionRecord);

    // Build node map
    const nodeMap = new Map();
    workflow.nodes.forEach(node => nodeMap.set(node.id, node));

    // Get execution steps
    const stepsToExecute = workflow.executionSteps && workflow.executionSteps.length > 0
      ? workflow.executionSteps.sort((a, b) => a.order - b.order)
      : workflow.nodes.map((node, index) => ({ nodeId: node.id, order: index }));

    await addExecutionLog(
      executionsDb,
      executionId,
      'info',
      `Starting workflow execution: ${workflow.name} (triggered by ${triggerInfo.type}: ${triggerInfo.description})`
    );

    // Prepare helpers
    const helpers = {
      pluginManager,
      getFullConfig,
      getDb,
      appSqliteDbPath,
      sqlitePool,
      buildSkillHelpers          // available for output / vector skill calls
    };

    let totalRecordsProcessed = 0;

    // Execute each node
    for (const step of stepsToExecute) {
      const node = nodeMap.get(step.nodeId);
      if (!node) continue;

      const nodeStartTime = Date.now();
      const nodeLabel = step.customName || step.nodeLabel || node.data?.label || node.id;

      await addExecutionLog(
        executionsDb,
        executionId,
        'info',
        `Executing node: ${nodeLabel} (${node.type})`
      );

      try {
        const nodeResult = await executeNode(node, nodeMap, workflow.edges, helpers);
        const nodeDuration = Date.now() - nodeStartTime;

        const nodeExec = {
          nodeId: node.id,
          nodeName: nodeLabel,
          nodeType: node.type,
          status: nodeResult?.success ? 'completed' : 'failed',
          startTime: new Date(nodeStartTime).toISOString(),
          duration: nodeDuration,
          error: nodeResult?.success ? null : { message: nodeResult?.message || 'Unknown error' },
          metrics: {
            recordsProcessed: nodeResult?.recordsProcessed || 0,
            recordsSuccess: nodeResult?.recordsProcessed || 0,
            recordsFailed: 0
          }
        };

        await executionsDb.updateAsync(
          { executionId },
          { $push: { nodeExecutions: nodeExec } }
        );

        if (!nodeResult?.success) {
          throw new Error(nodeResult?.message || 'Node execution failed');
        }

        totalRecordsProcessed += nodeResult?.recordsProcessed || 0;
      } catch (error) {
        await addExecutionLog(
          executionsDb,
          executionId,
          'error',
          `Node execution failed: ${error.message}`
        );

        // Mark as failed
        const endTime = new Date().toISOString();
        const duration = new Date(endTime) - new Date(startTime);

        await executionsDb.updateAsync(
          { executionId },
          {
            $set: {
              status: 'failed',
              endTime,
              duration,
              'results.totalRecordsProcessed': totalRecordsProcessed,
              'results.summary': `Workflow failed: ${error.message}`
            }
          }
        );


        if (Notification.isSupported()) {
          new Notification({
            title: 'DagFlux - Workflow Failed',
            body: `Workflow "${workflow.name}" failed: ${error.message}`,
          }).show();
        }

        throw error;
      }
    }

    // Mark as completed
    const endTime = new Date().toISOString();
    const duration = new Date(endTime) - new Date(startTime);

    await executionsDb.updateAsync(
      { executionId },
      {
        $set: {
          status: 'completed',
          endTime,
          duration,
          'results.totalRecordsProcessed': totalRecordsProcessed,
          'results.summary': `Workflow completed successfully. Processed ${totalRecordsProcessed} records.`
        }
      }
    );

    await addExecutionLog(
      executionsDb,
      executionId,
      'info',
      `Workflow execution completed: ${workflow.name}`
    );

    console.log(`[Trigger] Workflow ${workflowId} executed successfully`);


    if (Notification.isSupported()) {
      new Notification({
        title: 'DagFlux - Workflow Completed',
        body: `Workflow "${workflow.name}" executed successfully!`,
      }).show();
    }
    console.log('activeWorkflowExecutionsdelete: ', activeWorkflowExecutions)

    // Remove from active executions
    activeWorkflowExecutions.delete(workflowId);

    return {
      success: true,
      executionId,
      message: 'Workflow executed successfully',
      recordsProcessed: totalRecordsProcessed
    };
  } catch (error) {
    console.error(`[Trigger] Failed to execute workflow ${workflowId}:`, error);

    // Remove from active executions
    activeWorkflowExecutions.delete(workflowId);

    // Get workflow name if available
    let workflowName = 'Unknown Workflow';
    try {
      const workflowsDb = getDb('workflows');
      const workflow = await workflowsDb.findOneAsync({ _id: workflowId });

      if (workflow) {
        workflowName = workflow.name;
      }
    } catch (err) {
      // Ignore error, use default name
    }

    if (Notification.isSupported()) {
      new Notification({
        title: 'DagFlux - Workflow Error',
        body: `Workflow "${workflowName}" encountered an error: ${error.message}`,
      }).show();
    }

    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Register a CRON job for time-based workflow triggers
 */
ipcMain.handle('start-trigger:register-cron', async (_event, params) => {
  return await registerCronJob(params, executeWorkflowFromTrigger);
});

/**
 * Unregister a CRON job
 */
ipcMain.handle('start-trigger:unregister-cron', async (_event, params) => {
  return await unregisterCronJob(params);
});

/**
 * Register a file watcher for file/directory change triggers
 */
ipcMain.handle('start-trigger:register-file-watch', async (_event, params) => {
  return await registerFileWatcher(params, executeWorkflowFromTrigger);
});

/**
 * Unregister a file watcher
 */
ipcMain.handle('start-trigger:unregister-file-watch', async (_event, params) => {
  return await unregisterFileWatcher(params);
});

/**
 * Get all active triggers (CRON jobs and file watchers)
 */
ipcMain.handle('start-trigger:get-active', async () => {
  try {
    return {
      success: true,
      triggers: {
        cron: getActiveCronJobs(),
        file: getActiveFileWatchers()
      }
    };
  } catch (error) {
    console.error('[Triggers] Get active error:', error);
    return {
      success: false,
      message: error.message
    };
  }
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
    titleBarStyle: 'default',
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

app.whenReady().then(async () => {
  // Initialize SQLite connection pool
  await initializeAppDatabase();

  // Initialize node execution module with dependencies (skill helpers
  // builder is passed so vector-DB join hooks can access embedding libs).
  nodeExecution.initialize(appSqliteDbPath, getFullConfig, sqlitePool, buildSkillHelpers);
  apiFetch.initialize(getFullConfig);

  // Load connector plugins
  pluginManager.loadPlugins();

  // Register all workflow triggers (CRON jobs and file watchers)
  await registerAllWorkflowTriggers(getDb, executeWorkflowFromTrigger);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Gracefully close SQLite connection pool and stop all triggers on app quit
app.on('before-quit', async (event) => {
  event.preventDefault();

  // Stop all CRON jobs
  console.log('[Electron] Stopping all CRON jobs...');
  stopAllCronJobs();

  // Stop all file watchers
  console.log('[Electron] Stopping all file watchers...');
  await stopAllFileWatchers();

  // Close SQLite connection pool
  if (sqlitePool) {
    console.log('[Electron] Closing SQLite connection pool...');
    await sqlitePool.close();
    sqlitePool = null;
  }

  app.exit(0);
});
