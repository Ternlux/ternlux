const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Exposes a minimal, safe API to the renderer process via contextBridge.
 * The renderer accesses these methods via window.electronAPI.
 *
 * All LLM key storage/retrieval is handled by the main process using
 * Electron safeStorage (OS-level encryption via keychain / Credential Store).
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Encrypts and persists the LLM provider key to disk.
   * @param {string} provider - 'claude' | 'gemini' | 'chatgpt'
   * @param {string} key      - The raw API key
   * @returns {Promise<{success: boolean}>}
   */
  saveApiKey: (provider, key) =>
    ipcRenderer.invoke('api-key:save', { provider, key }),

  /**
   * Loads and decrypts the stored LLM provider key.
   * @returns {Promise<{provider: string, key: string} | null>}
   */
  loadApiKey: () =>
    ipcRenderer.invoke('api-key:load'),

  /**
   * Deletes the stored LLM provider key file.
   * @returns {Promise<{success: boolean}>}
   */
  clearApiKey: () =>
    ipcRenderer.invoke('api-key:clear'),

  /**
   * Generic local NeDB database access.
   * Collections: 'workflows' | 'connections' | 'executions' | 'chatSessions'
   */
  db: {
    /** Insert a document. Returns the inserted doc (with _id). */
    insert: (collection, doc) =>
      ipcRenderer.invoke('db:insert', { collection, doc }),

    /** Find documents. Returns an array. */
    find: (collection, query = {}, sort = null, limit = 0, skip = 0) =>
      ipcRenderer.invoke('db:find', { collection, query, sort, limit, skip }),

    /** Return the first matching document or null. */
    findOne: (collection, query = {}) =>
      ipcRenderer.invoke('db:findOne', { collection, query }),

    /** Update matching documents. Returns { numReplaced, ... }. */
    update: (collection, query, update, options = {}) =>
      ipcRenderer.invoke('db:update', { collection, query, update, options }),

    /** Remove matching documents. Returns numRemoved. */
    remove: (collection, query, options = {}) =>
      ipcRenderer.invoke('db:remove', { collection, query, options }),

    /** Count documents matching query. Returns a number. */
    count: (collection, query = {}) =>
      ipcRenderer.invoke('db:count', { collection, query }),

    /** Read from a local NeDB or SQLite file. Returns { success, rows, rowCount, json }. */
    readLocalCollection: (filePath, limit = 100, storageType = 'nedb', sqlPreview = null, tableName = null) =>
      ipcRenderer.invoke('db:read-local-collection', { filePath, limit, storageType, sqlPreview, tableName }),
  },

  /**
   * Open the native OS file picker and return the selected file path.
   * Returns { canceled: bool, filePaths: string[] }
   */
  openFileDialog: (options) =>
    ipcRenderer.invoke('dialog:open-file', options),

  /**
   * Extract the real system path from a File object (for drag-and-drop).
   * @param {File} file - The File object from drag-and-drop
   * @returns {string} The absolute file path
   */
  getFilePath: (file) => webUtils.getPathForFile(file),

  /**
   * Open the native OS save file dialog and return the selected file path.
   * Returns { canceled: bool, filePath: string }
   */
  selectSavePath: (defaultFileName, fileExtension) =>
    ipcRenderer.invoke('dialog:save-file', defaultFileName, fileExtension),

  /**
   * Read rows from a local spreadsheet file (xlsx / xls / csv).
   * No upload — reads directly from the filesystem path.
   */
  fileReader: {
    /** Read up to `limit` rows from a local file. Returns { success, sheets, data }. */
    readRows: (filePath, limit = 1000) =>
      ipcRenderer.invoke('file:read-rows', { filePath, limit }),
  },

  /**
   * Import files into internal databases
   */
  importToSqlite: (params) =>
    ipcRenderer.invoke('import-to-sqlite', params),

  importToNeDB: (params) =>
    ipcRenderer.invoke('import-to-nedb', params),

  /**
   * Direct database connections (runs in main process via native drivers).
   * No backend server required.
   */
  dbConnect: {
    /** Test connectivity. Returns { success, message }. */
    test: (dbType, config, connectionId = null) =>
      ipcRenderer.invoke('dbconn:test', { dbType, config, connectionId }),

    /** List tables/collections. Returns { success, tables: [{schema, name, type}] }. */
    getTables: (dbType, config, connectionId = null) =>
      ipcRenderer.invoke('dbconn:get-tables', { dbType, config, connectionId }),

    /** List columns for a table. Returns { success, columns: [{name, type, nullable, isPrimary}] }. */
    getColumns: (dbType, config, schema, table, connectionId = null) =>
      ipcRenderer.invoke('dbconn:get-columns', { dbType, config, connectionId, schema, table }),

    /** Get table schema with inferred types and sample data. Returns { success, tableName, columns, sampleData }. */
    getTableSchema: (dbType, config, connectionId, tableName, sheetName = null, limit = 5) =>
      ipcRenderer.invoke('dbconn:get-table-schema', { dbType, config, connectionId, tableName, sheetName, limit }),

    /** Run a SQL query or MongoDB JSON query. Returns { success, rows, columns, rowCount }. */
    runQuery: (dbType, config, query, connectionId = null) =>
      ipcRenderer.invoke('dbconn:run-query', { dbType, config, connectionId, query }),



    /** Transform NeDB (local file) data. Returns { success, message, documentsProcessed, documentsInserted, localPath }. */
    // transformNeDB: (sourceLocalPath, targetCollection, operationType, nosqlOperation, transformFunction, operationMode) =>
    //   ipcRenderer.invoke('dbconn:transform-nedb', {
    //     sourceLocalPath,
    //     targetCollection,
    //     operationType,
    //     nosqlOperation,
    //     transformFunction,
    //     operationMode
    //   }),

    /** Unified NoSQL transformation (routes to MongoDB or NeDB based on dbType). */
    transformNoSQL: (dbType, config, connectionId, sourceLocalPath, sourceCollection, targetCollection, operationType, nosqlOperation, transformFunction, storageLocation, operationMode) =>
      ipcRenderer.invoke('dbconn:transform-nosql', {
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
      }),

    /** SQL transformation (for PostgreSQL, MySQL, MSSQL, SQLite, CSV/Excel files). */
    transformSQL: (dbType, config, connectionId, ddl, sql, previewSql, storageLocation, operationMode, targetTableName, sourceLocalPath = null, insertSql = null) =>
      ipcRenderer.invoke('dbconn:transform-sql', {
        dbType,
        config,
        connectionId,
        ddl,
        sql,
        previewSql,
        storageLocation,
        operationMode,
        targetTableName,
        sourceLocalPath,
        insertSql
      }),

    /** Execute join operation (combines multiple sources into destination). */
    executeJoin: (destinationConnection, joinConfig, operationMode) =>
      ipcRenderer.invoke('dbconn:execute-join', {
        destinationConnection,
        joinConfig,
        operationMode
      }),

    /** Execute output operation (export to file or insert to connection). */
    executeOutput: (sourceConnection, sourceTableSchema, outputSettings) =>
      ipcRenderer.invoke('dbconn:execute-output', sourceConnection, sourceTableSchema, outputSettings),

    /** List all available connector plugins. Returns { success, connectors: [{id, name, type, icon, version, description, configSchema}] }. */
    listPlugins: () =>
      ipcRenderer.invoke('dbconn:list-plugins'),

    /** Generate transformation prompt from a plugin. Returns { success, prompt: string }. */
    generateTransformPrompt: (dbType, operationMode, settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName, sourceConnection = null, targetSchema = null, fullTableName = null, sourceSchema = null, sourceFullTableName = null) =>
      ipcRenderer.invoke('dbconn:generate-transform-prompt', {
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
      }),

    /** Quote identifier for specific database type. Returns { success, quotedIdentifier }. */
    quoteIdentifier: (dbType, identifier, schema = null, config = null, connectionId = null) =>
      ipcRenderer.invoke('dbconn:quote-identifier', { dbType, identifier, schema, config, connectionId }),

    /** Get database-specific preview query. Returns { success, previewQuery }. */
    getPreviewQuery: (dbType, tableName, limit = 100) =>
      ipcRenderer.invoke('dbconn:get-preview-query', { dbType, tableName, limit }),

    /** Import Google Sheet to local SQLite database. Returns { success, localPath, tableName, rowCount, message }. */
    importGoogleSheetToSqlite: (config, connectionId, spreadsheetId, sheetName) =>
      ipcRenderer.invoke('google-sheets:import-to-sqlite', { config, connectionId, spreadsheetId, sheetName }),
  },

  /**
   * Secure database credential storage.
   * Credentials are encrypted using OS-level safeStorage.
   */
  dbCredentials: {
    /** Save credentials for a connection. Returns { success }. */
    save: (connectionId, credentials) =>
      ipcRenderer.invoke('db-credentials:save', { connectionId, credentials }),

    /** Load credentials for a connection. Returns credentials object or null. */
    load: (connectionId) =>
      ipcRenderer.invoke('db-credentials:load', { connectionId }),

    /** Update credentials for a connection (replaces all credentials and closes cached connection). Returns { success }. */
    update: (connectionId, credentials, dbType) =>
      ipcRenderer.invoke('db-credentials:update', { connectionId, credentials, dbType }),

    /** Delete credentials for a connection. Returns { success }. */
    delete: (connectionId) =>
      ipcRenderer.invoke('db-credentials:delete', { connectionId }),
  },

  /**
   * Plugin management.
   * Install, uninstall, and list connector plugins.
   */
  plugins: {
    /** List installed connector plugins. Returns { success, connectors: [{id, name, type, version, ...}] }. */
    listInstalled: () =>
      ipcRenderer.invoke('dbconn:list-plugins'),

    /** Install a plugin from the backend server. Returns { success, message }. */
    install: (pluginId) =>
      ipcRenderer.invoke('plugins:install', { pluginId }),

    /** Uninstall an installed plugin. Returns { success, message }. */
    uninstall: (pluginId) =>
      ipcRenderer.invoke('plugins:uninstall', { pluginId }),
  },

  /**
   * Cloud Storage operations
   */
  cloudStorage: {
    /** Get list of containers/buckets. Returns { success, containers, message }. */
    getContainers: (connectionId, dbType) =>
      ipcRenderer.invoke('cloud-storage:get-containers', { connectionId, dbType }),

    /**
     * List objects in a container with pagination and search support.
     * @param {number} maxKeys - Maximum objects per page (default 100)
     * @param {string} continuationToken - Pagination token from previous response
     * @param {string} searchTerm - Search term for server-side filtering
     * Returns { success, objects, isTruncated, nextContinuationToken, totalCount, message }
     */
    listObjects: (connectionId, dbType, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '') =>
      ipcRenderer.invoke('cloud-storage:list-objects', { connectionId, dbType, containerName, prefix, maxKeys, continuationToken, searchTerm }),

    /** Download an object from cloud storage. Returns { success, data, contentType, message }. */
    downloadObject: (connectionId, dbType, containerName, objectName) =>
      ipcRenderer.invoke('cloud-storage:download-object', { connectionId, dbType, containerName, objectName }),

    /** Export Google Workspace file (Sheets, Docs, etc.). Returns { success, data, name, mimeType, message }. */
    exportObject: (connectionId, dbType, fileId, mimeType) =>
      ipcRenderer.invoke('cloud-storage:export-object', { connectionId, dbType, fileId, mimeType }),

    /** Import a file from cloud storage to local SQLite/NeDB. Returns { success, localPath, dbType, tables, message }. */
    importFile: (params) =>
      ipcRenderer.invoke('cloud-storage:import-file', params),

    /** Analyze Excel file for sheet names. Returns { success, sheets: string[] }. */
    analyzeExcelFile: (fileData) =>
      ipcRenderer.invoke('cloud-storage:analyze-excel', fileData),

    /** Get Google Picker credentials for frontend integration. Returns { success, accessToken, apiKey, clientId, message }. */
    getPickerCredentials: (connectionId, dbType) =>
      ipcRenderer.invoke('cloud-storage:get-picker-credentials', { connectionId, dbType }),
  },

  /**
   * Enhanced file reader operations
   */
  fileReaderEnhanced: {
    /** Analyze Excel file and return sheet names. Returns { success, sheets: string[] }. */
    analyzeExcel: (fileData) =>
      ipcRenderer.invoke('file-reader:analyze-excel', fileData),
  },

  /**
   * OAuth2.0 operations
   */
  oauth: {
    /**
     * Generate OAuth2.0 authorization URL for a connector.
     * @param {string} dbType - Connector type (e.g., 'google-sheets', 'dropbox')
     * @param {object} config - OAuth config (clientId, clientSecret, redirectUri)
     * Returns { success, authUrl, scopes, state }
     */
    getAuthorizationUrl: (dbType, config) =>
      ipcRenderer.invoke('oauth:get-authorization-url', { dbType, config }),

    /**
     * Exchange authorization code for access/refresh tokens.
     * @param {string} dbType - Connector type
     * @param {object} config - OAuth config
     * @param {string} code - Authorization code from OAuth callback
     * @param {string} state - CSRF state token
     * Returns { success, tokens: { accessToken, refreshToken, expiryDate, ... } }
     */
    exchangeCode: (dbType, config, code, state) =>
      ipcRenderer.invoke('oauth:exchange-code', { dbType, config, code, state }),

    /**
     * Open system browser to OAuth authorization URL.
     * @param {string} url - Authorization URL to open
     * Returns { success }
     */
    openBrowser: (url) =>
      ipcRenderer.invoke('oauth:open-browser', { url }),

    /**
     * Start local HTTP server to handle OAuth callback.
     * @param {number} port - Port to listen on (default 3000)
     * Returns { success, code, state, error, errorDescription }
     */
    startCallbackServer: (port = 3000) =>
      ipcRenderer.invoke('oauth:start-callback-server', { port }),

    /**
     * Cancel an active OAuth callback server.
     * @param {number} port - Port of the server to cancel (default 3000)
     * Returns { success }
     */
    cancelServer: (port = 3000) =>
      ipcRenderer.invoke('oauth:cancel-server', { port }),
  },
});
