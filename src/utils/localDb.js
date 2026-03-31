/**
 * localDb.js — Local NeDB storage for offline / guest users (no JWT).
 *
 * In Electron the datastores are file-backed and run in the main process.
 * The renderer accesses them via window.electronAPI.db (IPC + contextBridge).
 *
 * In a plain browser session (npm start without Electron) four in-memory
 * NeDB instances are created directly in the renderer as a fallback.
 * Data is NOT persisted across page reloads in that mode.
 *
 * Collections
 *  - workflows
 *  - connections
 *  - executions
 *  - chatSessions  (messages embedded inside each session document)
 *
 * Exported namespaces
 *  workflowsDb, connectionsDb, executionsDb, chatDb
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isElectron() {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}

/** Generate a simple UUID v4. */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Browser-only in-memory fallback datastores (lazy-created)
// ---------------------------------------------------------------------------

let _browserDbs = null;

async function getBrowserDbs() {
  if (_browserDbs) return _browserDbs;
  // Dynamic import so CRA/webpack can tree-shake for Electron builds
  const Datastore = (await import('@seald-io/nedb')).default;
  _browserDbs = {
    workflows:    new Datastore({ inMemoryOnly: true }),
    connections:  new Datastore({ inMemoryOnly: true }),
    executions:   new Datastore({ inMemoryOnly: true }),
    chatSessions: new Datastore({ inMemoryOnly: true }),
  };
  return _browserDbs;
}

// ---------------------------------------------------------------------------
// Low-level adapters — route through IPC or in-memory NeDB
// ---------------------------------------------------------------------------

async function dbInsert(collection, doc) {
  if (isElectron()) return window.electronAPI.db.insert(collection, doc);
  const dbs = await getBrowserDbs();
  return dbs[collection].insertAsync(doc);
}

async function dbFind(collection, query = {}, sort = null, limit = 0, skip = 0) {
  if (isElectron()) return window.electronAPI.db.find(collection, query, sort, limit, skip);
  const dbs = await getBrowserDbs();
  let cursor = dbs[collection].findAsync(query);
  if (sort)  cursor = cursor.sort(sort);
  if (skip)  cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  return cursor;
}

async function dbFindOne(collection, query = {}) {
  if (isElectron()) return window.electronAPI.db.findOne(collection, query);
  const dbs = await getBrowserDbs();
  return dbs[collection].findOneAsync(query);
}

async function dbUpdate(collection, query, update, options = {}) {
  if (isElectron()) return window.electronAPI.db.update(collection, query, update, options);
  const dbs = await getBrowserDbs();
  return dbs[collection].updateAsync(query, update, options);
}

async function dbRemove(collection, query, options = {}) {
  if (isElectron()) return window.electronAPI.db.remove(collection, query, options);
  const dbs = await getBrowserDbs();
  return dbs[collection].removeAsync(query, options);
}

async function dbCount(collection, query = {}) {
  if (isElectron()) return window.electronAPI.db.count(collection, query);
  const dbs = await getBrowserDbs();
  return dbs[collection].countAsync(query);
}

// ---------------------------------------------------------------------------
// workflowsDb
// ---------------------------------------------------------------------------

export const workflowsDb = {
  /**
   * Insert a new workflow.
   * @param {object} workflow - Workflow data (name, description, nodes, edges, …)
   * @returns {Promise<object>} Inserted doc with _id and id fields
   */
  async save(workflow) {
    const now = new Date().toISOString();
    const doc = {
      ...workflow,
      id: workflow.id || uuid(),
      createdAt: workflow.createdAt || now,
      updatedAt: now,
      createdBy: workflow.createdBy || 'local',
    };
    return dbInsert('workflows', doc);
  },

  /**
   * Return all workflows sorted by updatedAt descending.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return dbFind('workflows', {}, { updatedAt: -1 });
  },

  /**
   * Find one workflow by its public id field.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    return dbFindOne('workflows', { id });
  },

  /**
   * Update a workflow by its public id.
   * @param {string} id
   * @param {object} data - Fields to merge
   * @returns {Promise<object>} NeDB update result
   */
  async update(id, data) {
    const now = new Date().toISOString();
    return dbUpdate('workflows', { id }, { $set: { ...data, updatedAt: now } });
  },

  /**
   * Delete a workflow by its public id.
   * @param {string} id
   * @returns {Promise<number>} Number of removed docs
   */
  async delete(id) {
    return dbRemove('workflows', { id });
  },
};

// ---------------------------------------------------------------------------
// connectionsDb
// ---------------------------------------------------------------------------

export const connectionsDb = {
  /**
   * Insert a new connection.
   * @param {object} connection
   * @returns {Promise<object>}
   */
  async save(connection) {
    const doc = {
      ...connection,
      id: connection.id || uuid(),
      createdAt: connection.createdAt || new Date().toISOString(),
    };
    return dbInsert('connections', doc);
  },

  /**
   * Return all connections sorted by createdAt descending.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return dbFind('connections', {}, { createdAt: -1 });
  },

  /**
   * Find one connection by its public id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    return dbFindOne('connections', { id });
  },

  /**
   * Update a connection by its public id.
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object>}
   */
  async update(id, data) {
    return dbUpdate('connections', { id }, { $set: data });
  },

  /**
   * Delete a connection by its public id.
   * @param {string} id
   * @returns {Promise<number>}
   */
  async delete(id) {
    return dbRemove('connections', { id });
  },
};

// ---------------------------------------------------------------------------
// executionsDb
// ---------------------------------------------------------------------------

export const executionsDb = {
  /**
   * Insert a new execution record.
   * @param {object} execution
   * @returns {Promise<object>}
   */
  async save(execution) {
    const doc = {
      ...execution,
      executionId: execution.executionId || uuid(),
      startTime: execution.startTime || new Date().toISOString(),
    };
    return dbInsert('executions', doc);
  },

  /**
   * Return paginated executions sorted by startTime descending.
   * @param {{ page?: number, limit?: number }} options
   * @returns {Promise<{ docs: object[], total: number, hasMore: boolean }>}
   */
  async getAll({ page = 1, limit = 10 } = {}) {
    const skip = (page - 1) * limit;
    const [docs, total] = await Promise.all([
      dbFind('executions', {}, { startTime: -1 }, limit, skip),
      dbCount('executions', {}),
    ]);
    return { docs, total, hasMore: skip + docs.length < total };
  },

  /**
   * Find one execution by its executionId.
   * @param {string} executionId
   * @returns {Promise<object|null>}
   */
  async getById(executionId) {
    return dbFindOne('executions', { executionId });
  },

  /**
   * Delete an execution by executionId.
   * @param {string} executionId
   * @returns {Promise<number>}
   */
  async delete(executionId) {
    return dbRemove('executions', { executionId });
  },

  /**
   * Compute aggregate stats across all local executions.
   * @returns {Promise<{ totalExecutions: number, completedExecutions: number, failedExecutions: number, successRate: number }>}
   */
  async getStats() {
    const [total, completed, failed] = await Promise.all([
      dbCount('executions', {}),
      dbCount('executions', { status: 'completed' }),
      dbCount('executions', { status: 'failed' }),
    ]);
    return {
      totalExecutions: total,
      completedExecutions: completed,
      failedExecutions: failed,
      successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  },
};

// ---------------------------------------------------------------------------
// chatDb
// ---------------------------------------------------------------------------

export const chatDb = {
  /**
   * Create a new chat session with an empty messages array.
   * @param {string} chatId - UUID for the new session
   * @param {string} title  - Display title
   * @returns {Promise<object>} Inserted session doc
   */
  async saveSession(chatId, title = 'New Chat') {
    const now = new Date().toISOString();
    return dbInsert('chatSessions', {
      chatId: chatId || uuid(),
      title,
      status: 'pending',
      lastMessageAt: now,
      messages: [],
    });
  },

  /**
   * Return all sessions sorted by lastMessageAt descending (without messages array).
   * @returns {Promise<Array<{ chatId, title, status, lastMessageAt }>>}
   */
  async getSessions() {
    const sessions = await dbFind('chatSessions', {}, { lastMessageAt: -1 });
    return sessions.map(({ _id, chatId, title, status, lastMessageAt }) => ({
      _id, chatId, title, status, lastMessageAt,
    }));
  },

  /**
   * Return one full session (including messages) by chatId.
   * @param {string} chatId
   * @returns {Promise<object|null>}
   */
  async getSession(chatId) {
    return dbFindOne('chatSessions', { chatId });
  },

  /**
   * Update session metadata (title, status, lastMessageAt, …).
   * @param {string} chatId
   * @param {object} data - Fields to $set
   * @returns {Promise<object>}
   */
  async updateSession(chatId, data) {
    return dbUpdate('chatSessions', { chatId }, { $set: data });
  },

  /**
   * Delete a session and all its embedded messages.
   * @param {string} chatId
   * @returns {Promise<number>}
   */
  async deleteSession(chatId) {
    return dbRemove('chatSessions', { chatId });
  },

  /**
   * Append a message to a session's embedded messages array.
   * Also updates lastMessageAt and sets status to 'completed'.
   * @param {string} chatId
   * @param {object} message - { id, text, sender, timestamp, …}
   * @returns {Promise<object>}
   */
  async appendMessage(chatId, message) {
    const now = new Date().toISOString();
    return dbUpdate(
      'chatSessions',
      { chatId },
      {
        $push: { messages: message },
        $set: { lastMessageAt: now, status: 'completed' },
      },
    );
  },

  /**
   * Return just the messages array for a session.
   * @param {string} chatId
   * @returns {Promise<object[]>}
   */
  async getMessages(chatId) {
    const session = await dbFindOne('chatSessions', { chatId });
    return session ? session.messages : [];
  },
};
