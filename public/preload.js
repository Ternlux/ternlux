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

  listLanceDBTables: (dbPath) =>
    ipcRenderer.invoke('list-lancedb-tables', dbPath),

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
    transformNoSQL: (dbType, config, connectionId, sourceLocalPath, sourceCollection, targetCollection, operationType, nosqlOperation, transformFunction, storageLocation, operationMode, targetLocalPath = null) =>
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
        operationMode,
        targetLocalPath
      }),

    /** SQL transformation (for PostgreSQL, MySQL, MSSQL, SQLite, CSV/Excel files). */
    transformSQL: (dbType, config, connectionId, ddl, sql, previewSql, storageLocation, operationMode, targetSchema, targetTableName, sourceLocalPath = null, insertSql = null) =>
      ipcRenderer.invoke('dbconn:transform-sql', {
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
        insertSql
      }),

    /** Execute join operation (combines multiple sources into destination). */
    executeJoin: (destinationConnection, joinConfig, operationMode) =>
      ipcRenderer.invoke('dbconn:execute-join', {
        destinationConnection,
        joinConfig,
        operationMode
      }),

    /**
     * Execute branch validation plan.
     * params: {
     *   sources: Array<{ sourceNodeId, connection, tableName }>,
     *   steps:   Array<{ stepNumber, sourceNodeId, sql?, nosqlOperation?, selectedColumns? }>,
     *   validationFunction: string (JS function expression),
     *   outputRoutes: { true: string, false: string }
     * }
     * returns: { success, result:boolean, route, stepResults }
     */
    executeBranch: (params) =>
      ipcRenderer.invoke('dbconn:execute-branch', params),

    /**
     * Execute a REST API fetch function and materialise the response into NeDB.
     * params: {
     *   apiConnectionId: string,
     *   apiConnectionConfig: object,     // public config (no secrets)
     *   apiFetchCode: string,            // async JS function expression with
     *                                    // {{PLACEHOLDER}} tokens
     *   nedbCollection: string,
     *   operationMode?: 'new_table' | 'append'
     * }
     * returns: { success, rowCount, collection, localPath, sampleRow, error? }
     *
     * Secrets are decrypted and substituted into the code string in the main
     * process, then the function is evaluated and invoked. The resolved code
     * is never returned across this IPC.
     */
    executeRestApiFetch: (params) =>
      ipcRenderer.invoke('rest-api:execute-fetch', params),

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
   * Account authentication helpers.
   * The Google OAuth loopback flow must run in the main process (system
   * browser + local callback server); the renderer exchanges the returned
   * code with the backend for a JWT.
   */
  auth: {
    /** Run Google sign-in. Returns { success, code, redirectUri, codeVerifier } or { success: false, message }. */
    googleLogin: () =>
      ipcRenderer.invoke('auth:google-login'),

    /* Apple sign-in disabled
    appleLogin: () =>
      ipcRenderer.invoke('auth:apple-login'),
    */
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
   * AI provider operations. The renderer never sees decrypted API keys —
   * everything is dispatched through these handlers in the main process.
   */
  ai: {
    /**
     * Call the configured/requested AI provider with a prompt.
     * @param {Object} args - { prompt, options }
     * @param {string} args.prompt
     * @param {Object} [args.options] - { provider?, model?, maxTokens?, systemPrompt?, chatHistory? }
     * @returns {Promise<{success: boolean, text?: string, message?: string}>}
     */
    call: ({ prompt, options = {} } = {}) =>
      ipcRenderer.invoke('ai:call', { prompt, options }),

    /** List providers that have a usable API key configured. */
    listProviders: () =>
      ipcRenderer.invoke('ai:listProviders'),

    /** List the models a provider currently offers (fetched live via its SDK). */
    listModels: (provider) =>
      ipcRenderer.invoke('ai:listModels', { provider }),

    /** Read the persisted default provider (used by backend-internal calls). */
    getDefaultProvider: () =>
      ipcRenderer.invoke('ai:getDefaultProvider'),

    /** Non-secret config { hasKey, baseURL, model } for an OpenAI-compatible provider. */
    getCompatProvider: (provider) =>
      ipcRenderer.invoke('ai:getCompatProvider', { provider }),

    /** Save { apiKey, baseURL, model } for a compat provider; blank apiKey keeps the existing key. */
    saveCompatProvider: (provider, config) =>
      ipcRenderer.invoke('ai:saveCompatProvider', { provider, config }),

    /** Persist the user's default provider so the main process honors it. */
    setDefaultProvider: (provider) =>
      ipcRenderer.invoke('ai:setDefaultProvider', { provider }),
  },

  /**
   * Agentic chat assistant — one step at a time. The renderer drives the
   * loop, passing the running `scratchpad` back on each call until `done`.
   * Cancellation = stop calling step().
   *
   * @param {Object} args
   * @param {string} args.message           The user's original question.
   * @param {Array}  [args.history]         Prior cross-turn chat: [{ role, text }]
   * @param {Array}  [args.scratchpad]      Steps taken so far for this question.
   * @param {Object} [args.activeContext]   { kind, id, name, summary }
   * @param {string} [args.provider]
   * @returns {Promise<{
   *   success: boolean,
   *   done: boolean,
   *   thought: string,
   *   actions: Array<{ tool, args, ok, error?, result? }>,
   *   finalAnswer: string|null,
   *   step: object,
   * } | { success:false, message:string }>}
   */
  chat: {
    step: ({
      message,
      history = [],
      scratchpad = [],
      activeContext = null,
      provider = null,
      agentMode = 'main',
      workflowSession = null,
    } = {}) => ipcRenderer.invoke('chat:step', {
      message, history, scratchpad, activeContext, provider, agentMode, workflowSession,
    }),
    /**
     * Ask the AI to produce a 3-5 word topic title for a new conversation.
     * Returns { success, title } — fall back to a synchronous truncation
     * if success=false.
     */
    generateTitle: ({ message, provider = null } = {}) =>
      ipcRenderer.invoke('chat:generateTitle', { message, provider }),
    /**
     * Drive one round-trip with a skill subagent. Used while a node
     * build is paused on a skill that returned ask_questions /
     * answer_directly. Returns:
     *   { success, action, question?, directAnswer?, executionParams?, state, explanation? }
     * where action ∈ { execute, ask_questions, answer_directly, unrelateSkill }.
     */
    skillStep: ({ skillId, userMessage, currentState = {}, context = {} } = {}) =>
      ipcRenderer.invoke('chat:skillStep', { skillId, userMessage, currentState, context }),
  },

  /**
   * Workflow operations.
   * - executeBuild: applies a plan_workflow_build envelope directly (wired from
   *   the renderer's "Accept plan" button so confirmations don't burn a turn).
   * - executeWorkflow: runs a workflow's nodes in topological order.
   */
  workflow: {
    /**
     * @param {Object} args
     * @param {Object} args.plan  Plan envelope from plan_workflow_build,
     *                            with action='plan' and a steps[] array.
     * @returns {Promise<{ success, workflowId?, workflowName?, nodeCount?, edgeCount?, warnings?, message? }>}
     */
    executeBuild: ({ plan } = {}) => ipcRenderer.invoke('workflow:executeBuild', { plan }),

    /**
     * Subscribe to live build-progress events emitted by executeBuild while a
     * plan is being applied. The callback receives one event object per step:
     *   { phase: 'start', mode, totalSteps }
     *   { phase: 'step', status: 'running'|'done', stepIndex, stepType, label, action }
     *   { phase: 'done', workflowId, workflowName, nodeCount, edgeCount }
     * Returns an unsubscribe function — call it on cleanup to avoid leaks.
     * @param {(evt: object) => void} callback
     * @returns {() => void}
     */
    onBuildProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload);
      ipcRenderer.on('workflow:buildProgress', listener);
      return () => ipcRenderer.removeListener('workflow:buildProgress', listener);
    },

    /**
     * @param {object} params - { workflowId, workflowName, nodes, edges }
     * @returns {Promise<{ success, executionId, message, results }>}
     */
    executeWorkflow: (params) => ipcRenderer.invoke('workflow:execute', params),

    /**
     * Start watching the open workflow's externalized-code folder
     * ({userData}/workflow-code/{workflow}). When a code file changes on disk
     * the main process emits 'workflow:codeChanged' — subscribe with
     * onCodeChanged to reload the editor. Editor sync only; does not run the
     * workflow.
     * @param {string} workflowId
     * @returns {Promise<{ success, message, watching? }>}
     */
    watchCode: (workflowId) => ipcRenderer.invoke('workflow:watchCode', { workflowId }),

    /**
     * Stop watching a workflow's code folder.
     * @param {string} workflowId
     * @returns {Promise<{ success, message }>}
     */
    unwatchCode: (workflowId) => ipcRenderer.invoke('workflow:unwatchCode', { workflowId }),

    /**
     * Subscribe to code-file changes for watched workflows. The callback
     * receives { workflowId, event, path }. Returns an unsubscribe function —
     * call it on cleanup to avoid leaks.
     * @param {(evt: { workflowId: string, event: string, path: string }) => void} callback
     * @returns {() => void}
     */
    onCodeChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload);
      ipcRenderer.on('workflow:codeChanged', listener);
      return () => ipcRenderer.removeListener('workflow:codeChanged', listener);
    },
  },

  /**
   * Anonymous usage analytics. The renderer pushes the user's opt-in choice;
   * the main process gates all outbound events on this flag.
   */
  analytics: {
    setOptIn: (optIn) =>
      ipcRenderer.invoke('analytics:set-opt-in', { optIn: !!optIn }),
  },

  /**
   * Terms & Conditions acceptance, persisted to userData via the main process
   * so it survives across launches.
   */
  terms: {
    get: () => ipcRenderer.invoke('terms:get'),
    save: (record) => ipcRenderer.invoke('terms:save', record),
  },

  /**
   * Skills Plugin operations
   */
  skills: {
    /** List installed skill plugins. Returns { success, skills: [{id, name, category, version, ...}] }. */
    listInstalled: () =>
      ipcRenderer.invoke('skills:listInstalled'),

    /** Get skills by category (transformer/join). Returns { success, skills: [...] }. */
    getByCategory: (category) =>
      ipcRenderer.invoke('skills:getByCategory', category),

    /** Get skill descriptions for AI context. Returns { success, descriptions: [...] }. */
    getDescriptions: (category = null, context = {}) =>
      ipcRenderer.invoke('skills:getDescriptions', category, context),

    /** Analyze a skill request. Returns { success, action, followUpQuestion, questionsNeeded, skillParams, ... }. */
    analyze: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:analyze', { skillId, params }),

    /** Build skill prompt for AI. Returns { success, prompt, context }. */
    buildPrompt: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:buildPrompt', { skillId, params }),

    /** Process AI response through skill. Returns { success, action, pythonCode, explanation, followUpQuestion, directAnswer, ... }. */
    processResponse: ({ skillId, aiResponse, operationType, currentState, availableConnections }) =>
      ipcRenderer.invoke('skills:processResponse', { skillId, aiResponse, operationType, currentState, availableConnections }),

    /** Execute a skill. Returns { success, data, recordCount, ... }. */
    execute: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:execute', { skillId, params }),

    /** Query vector database for preview. Returns { success, data, recordCount, isJson, storageType }. */
    queryVectorPreview: (params) =>
      ipcRenderer.invoke('skills:queryVectorPreview', params),
  },

  /**
   * Chat prompt builders sourced from public/ChatPrompts. The renderer passes
   * a "moduleName.methodName" key and the argument array; the main process
   * calls the matching prompt function and returns { success, prompt }.
   */
  chatPrompts: {
    build: (key, args = []) =>
      ipcRenderer.invoke('chatPrompts:build', key, args),
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

  /**
   * Start trigger management for workflow automation.
   * Register and manage CRON jobs and file watchers.
   */
  startTriggers: {
    /**
     * Register a CRON job for time-based workflow triggers.
     * @param {object} params - { nodeId, workflowId, cronExpression, description }
     * Returns { success, message, cronExpression, nextRun }
     */
    registerCron: (params) =>
      ipcRenderer.invoke('start-trigger:register-cron', params),

    /**
     * Unregister a CRON job.
     * @param {object} params - { nodeId, workflowId }
     * Returns { success, message }
     */
    unregisterCron: (params) =>
      ipcRenderer.invoke('start-trigger:unregister-cron', params),

    /**
     * Register a file watcher for file/directory change triggers.
     * @param {object} params - { nodeId, workflowId, path, events, pattern }
     * Returns { success, message, path, events }
     */
    registerFileWatch: (params) =>
      ipcRenderer.invoke('start-trigger:register-file-watch', params),

    /**
     * Unregister a file watcher.
     * @param {object} params - { nodeId, workflowId }
     * Returns { success, message }
     */
    unregisterFileWatch: (params) =>
      ipcRenderer.invoke('start-trigger:unregister-file-watch', params),

    /**
     * Get all active triggers (CRON jobs and file watchers).
     * Returns { success, triggers: { cron, file } }
     */
    getActiveTriggers: () =>
      ipcRenderer.invoke('start-trigger:get-active'),
  },
});
