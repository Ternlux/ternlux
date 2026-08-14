/**
 * SQLite Connector Plugin for Ternlux
 *
 * Backs local file connections — spreadsheet/CSV imports and node outputs that
 * were landed into a SQLite file. sqlite3 comes from the app's own
 * dependencies; each call opens its own handle, matching public/lib/sqlite.js
 * (the driver does its own locking, and the app DB pool is owned elsewhere).
 *
 * Config: { dbPath, tables? }
 *   dbPath  the .db file
 *   tables  optional allow-list. Several connections can share one file — an
 *           import lands its own tables into the shared app database — so a
 *           connection only shows the tables it actually owns.
 */

const fs = require('fs');

function openDb(dbPath, readonly = false) {
  if (!dbPath) throw new Error('SQLite requires a dbPath');
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite file not found: ${dbPath}`);
  // eslint-disable-next-line global-require
  const sqlite3 = require('sqlite3');
  return new sqlite3.Database(dbPath, readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE);
}

const closeDb = (db) => new Promise((resolve) => db.close(() => resolve()));

/**
 * Run a statement, optionally stopping after `maxRows`.
 *
 * Whether a statement returns rows is decided by SQLite, not by inspecting the
 * text. Guessing from the leading keyword gets `WITH new AS (…) INSERT …`
 * wrong twice over — it looks like a SELECT, so it would be dispatched as a
 * read AND the file opened read-only, failing a statement that is perfectly
 * valid. Stepping the prepared statement asks the engine instead.
 *
 * Rows are pulled one at a time so a cap costs only the rows asked for; the
 * rest of the result set is never stepped. A statement that returns none has
 * still executed by then, and `changes()` on this connection reports what it
 * did (the connection is opened per call, so nothing earlier can leak in).
 */
async function query(dbPath, sql, params = [], { maxRows = 0 } = {}) {
  const db = openDb(dbPath);
  try {
    const stmt = await new Promise((resolve, reject) => {
      let prepared;
      prepared = db.prepare(sql, params, (err) => (err ? reject(err) : resolve(prepared)));
    });
    const step = () => new Promise((resolve, reject) => {
      stmt.get((err, row) => (err ? reject(err) : resolve(row)));
    });

    const rows = [];
    try {
      // One past the cap, so "is there more?" is observed rather than assumed.
      const ceiling = maxRows > 0 ? maxRows + 1 : Infinity;
      for (;;) {
        if (rows.length >= ceiling) break;
        const row = await step();
        if (row === undefined) break;
        rows.push(row);
      }
    } finally {
      await new Promise((resolve) => stmt.finalize(() => resolve()));
    }

    if (rows.length > 0) return rows;

    const changed = await new Promise((resolve, reject) => {
      db.get('SELECT changes() AS n', (err, row) => (err ? reject(err) : resolve(row ? row.n : 0)));
    });
    return changed > 0 ? { changes: changed } : [];
  } finally {
    await closeDb(db);
  }
}

/** SQLite quotes identifiers with double quotes; an inner one is doubled. */
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

module.exports = {
  type: 'connector',
  id: 'sqlite',
  name: 'SQLite',
  dbCategory: 'SQL',

  testConnection: async (config) => {
    try {
      await query(config.dbPath, 'SELECT 1');
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List tables and views. `main` is SQLite's default schema, so that is what
   * the tree groups under.
   */
  getTables: async (config) => {
    try {
      const rows = await query(
        config.dbPath,
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      );

      // Restrict to this connection's own tables when it declares them. The
      // filter is strict on purpose: many connections can point at the same
      // shared file, so falling back to "show everything" would surface other
      // connections' tables and make them all look identical.
      const owned = Array.isArray(config.tables) && config.tables.length
        ? config.tables
        : null;
      const use = owned ? rows.filter((r) => owned.includes(r.name)) : rows;

      return {
        success: true,
        tables: use.map((r) => ({
          schema: 'main',
          name: r.name,
          type: r.type === 'view' ? 'VIEW' : 'BASE TABLE',
        })),
      };
    } catch (error) {
      return { success: false, message: error.message, tables: [] };
    }
  },

  getColumns: async (config, connectionId, schema, table) => {
    try {
      const rows = await query(config.dbPath, `PRAGMA table_info(${quote(table)})`);
      return {
        success: true,
        columns: rows.map((r) => ({
          name: r.name,
          type: r.type || 'BLOB',
          nullable: !r.notnull,
          isPrimary: Boolean(r.pk),
          defaultValue: r.dflt_value,
        })),
      };
    } catch (error) {
      return { success: false, message: error.message, columns: [] };
    }
  },

  /**
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows. Honoured by
   *   stepping the prepared statement, so the SQL the user wrote is the SQL
   *   SQLite runs — no LIMIT is appended.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    try {
      const sql = queryObj && queryObj.query ? queryObj.query : queryObj;
      const maxRows = Number(options.maxRows) > 0 ? Number(options.maxRows) : 0;
      const result = await query(config.dbPath, sql, [], { maxRows });

      if (Array.isArray(result)) {
        const rows = maxRows ? result.slice(0, maxRows) : result;
        return {
          success: true,
          rows,
          columns: rows.length ? Object.keys(rows[0]) : [],
          rowCount: rows.length,
          ...(maxRows ? { truncated: result.length > maxRows } : {}),
        };
      }

      return {
        success: true,
        rows: [],
        columns: [],
        rowCount: result.changes,
        message: `${result.changes} row(s) affected`,
      };
    } catch (error) {
      return { success: false, message: error.message, rows: [], columns: [] };
    }
  },

  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    if (!rows || rows.length === 0) return { success: true, rowsInserted: 0 };

    const db = openDb(config.dbPath);
    try {
      const placeholders = `(${columns.map(() => '?').join(', ')})`;
      const sql = `INSERT INTO ${quote(tableName)} (${columns.map(quote).join(', ')}) VALUES ${placeholders}`;

      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(sql);
          for (const row of rows) {
            stmt.run(columns.map((c) => {
              const v = row[c];
              if (v === undefined) return null;
              if (v instanceof Date) return v.toISOString();
              if (v !== null && typeof v === 'object') return JSON.stringify(v);
              return v;
            }));
          }
          stmt.finalize((err) => {
            if (err) { db.run('ROLLBACK'); reject(err); return; }
            db.run('COMMIT', (commitErr) => (commitErr ? reject(commitErr) : resolve()));
          });
        });
      });

      return { success: true, rowsInserted: rows.length };
    } catch (error) {
      return { success: false, message: error.message };
    } finally {
      await closeDb(db);
    }
  },

  // Handles are per-call, so there is nothing pooled to tear down.
  closeConnection: async () => {},

  configSchema: {
    fields: [
      {
        name: 'dbPath',
        type: 'string',
        label: 'Database file',
        placeholder: '/path/to/database.db',
        required: true,
        sensitive: false,
      },
    ],
  },

  /**
   * `main` is implicit and prefixing it breaks nothing but reads badly, so
   * only the table itself is quoted.
   */
  quoteIdentifier: (identifier, schema = null) => (
    schema && schema !== 'main' ? `${quote(schema)}.${quote(identifier)}` : quote(identifier)
  ),

  getPreviewQuery: (tableName, limit = 100) => `SELECT * FROM ${tableName} LIMIT ${limit}`,

  /**
   * Data Explorer dialect. Read by public/database/dialect.js — keyword and
   * function lists are unioned with the shared ANSI baseline, so only what is
   * distinctly SQLite belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'SQLite',
    formatter: 'sqlite',
    // runQuery honours { maxRows } by stepping the statement — see the note there.
    maxRowsOption: true,
    // SQLite has no schema layer; attached files are the closest thing.
    container: 'Database',
    objectLabel: 'Table',
    quote: '"',
    keywords: [
      'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'AUTOINCREMENT',
      'WITHOUT ROWID', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE', 'RETURNING',
      'GLOB', 'REGEXP', 'INDEXED BY', 'EXPLAIN QUERY PLAN', 'ROWID',
    ],
    functions: [
      'IFNULL', 'GROUP_CONCAT', 'JULIANDAY', 'STRFTIME', 'DATE', 'DATETIME',
      'TIME', 'UNIXEPOCH', 'TYPEOF', 'HEX', 'RANDOM', 'INSTR', 'SUBSTR',
      'JSON_EXTRACT', 'JSON_ARRAY', 'JSON_OBJECT', 'JSON_EACH', 'PRINTF',
    ],
  },
};
