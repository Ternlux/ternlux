/**
 * SQLite Connection Pool
 * Manages a single persistent connection to the app SQLite database
 * with queued writes to prevent locking issues and support concurrent access
 */

class SqliteConnectionPool {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.writeQueue = [];
    this.isWriting = false;
    this.isInitialized = false;
  }

  /**
   * Initialize the connection pool
   * Enables WAL mode for better concurrency
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[SqliteConnectionPool] Already initialized');
      return;
    }

    const sqlite3 = require('sqlite3').verbose();

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          console.error('[SqliteConnectionPool] Failed to open database:', err);
          reject(err);
          return;
        }

        try {
          // Enable WAL mode for better concurrency (allows concurrent reads during writes)
          await this.run('PRAGMA journal_mode=WAL');

          // NORMAL is a good balance between safety and performance
          await this.run('PRAGMA synchronous=NORMAL');

          // Auto-checkpoint every 1000 pages to prevent WAL from growing too large
          await this.run('PRAGMA wal_autocheckpoint=1000');

          this.isInitialized = true;
          console.log('[SqliteConnectionPool] Initialized with WAL mode at:', this.dbPath);
          resolve();
        } catch (error) {
          console.error('[SqliteConnectionPool] Failed to configure database:', error);
          reject(error);
        }
      });
    });
  }

  /**
   * Get the raw database connection for read operations
   * Safe for concurrent reads
   */
  getConnection() {
    if (!this.isInitialized) {
      throw new Error('[SqliteConnectionPool] Connection pool not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a write operation (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP)
   * Queues writes to prevent "database locked" errors
   * @param {Function} callback - Function that receives the db connection and performs the write
   * @returns {Promise} - Resolves with the callback result
   */
  async executeWrite(callback) {
    if (!this.isInitialized) {
      throw new Error('[SqliteConnectionPool] Connection pool not initialized. Call initialize() first.');
    }

    return new Promise((resolve, reject) => {
      this.writeQueue.push({ callback, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process the write queue sequentially
   */
  async processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;

    this.isWriting = true;
    const { callback, resolve, reject } = this.writeQueue.shift();

    try {
      const result = await callback(this.db);
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.isWriting = false;
      // Process next item in queue
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Execute a single SQL statement (helper for PRAGMA commands)
   */
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('[SqliteConnectionPool] Database not initialized'));
        return;
      }

      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  /**
   * Execute a query and return all results
   */
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('[SqliteConnectionPool] Database not initialized'));
        return;
      }

      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Execute a query and return first result
   */
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('[SqliteConnectionPool] Database not initialized'));
        return;
      }

      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /**
   * Close the connection pool
   * Should be called on app shutdown
   */
  close() {
    return new Promise((resolve) => {
      if (this.db) {
        console.log('[SqliteConnectionPool] Closing connection pool');
        this.db.close((err) => {
          if (err) {
            console.error('[SqliteConnectionPool] Error closing database:', err);
          } else {
            console.log('[SqliteConnectionPool] Connection pool closed');
          }
          this.db = null;
          this.isInitialized = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = SqliteConnectionPool;
