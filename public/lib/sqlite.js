/**
 * Local SQLite helper. Single entry point: runQuery({ dbPath, query, params })
 * plus getTables / getColumns.
 *
 * Each call opens its own sqlite3 connection — sqlite3 handles its own locking.
 * This is now the ONLY way the app reads SQLite: the shared connection pool it
 * used to share the job with is gone, along with the transform, join and import
 * paths that wrote through it. Every SQLite file is a user's own file, opened by
 * path — a database they picked, or one an output node wrote.
 */

const fs = require('fs');
const path = require('path');

function openDb(dbPath) {
  if (!dbPath) throw new Error('SQLite runQuery requires dbPath');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line global-require
  const sqlite3 = require('sqlite3').verbose();
  return new sqlite3.Database(dbPath);
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function isReadOnly(sql) {
  const t = String(sql || '').trim().toLowerCase();
  return t.startsWith('select') || t.startsWith('pragma') || t.startsWith('with') || t.startsWith('explain');
}

/**
 * runQuery({ dbPath, query, params? })
 *  - SELECT/PRAGMA/WITH/EXPLAIN → returns array of rows.
 *  - Any other statement       → returns [] after running it.
 */
async function runQuery({ dbPath, query, params = [] } = {}) {
  if (!query) throw new Error('SQLite runQuery requires a query string');
  const db = openDb(dbPath);
  try {
    if (isReadOnly(query)) {
      return await new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
    }
    await new Promise((resolve, reject) => {
      db.run(query, params, (err) => (err ? reject(err) : resolve()));
    });
    return [];
  } finally {
    await close(db);
  }
}

async function getTables({ dbPath } = {}) {
  const rows = await runQuery({
    dbPath,
    query: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  });
  return rows.map((r) => r.name);
}

async function getColumns({ dbPath, table } = {}) {
  if (!table) return [];
  const rows = await runQuery({
    dbPath,
    query: `PRAGMA table_info(${table})`
  });
  return rows.map((r) => ({ name: r.name, type: r.type, nullable: !r.notnull, isPrimary: !!r.pk }));
}

module.exports = { runQuery, getTables, getColumns };
