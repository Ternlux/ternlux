/**
 * Local DuckDB helper. Same shape as lib/sqlite.js — runQuery({ dbPath, query })
 * plus getTables / getColumns — so the skill-helper layer can address local
 * data the same way it addresses any other local store.
 *
 * `dbPath` is one of two things:
 *
 *   • a workflow database (`*.duckdb`) — node outputs are tables in it, and a
 *     query names them directly: `SELECT * FROM orders_clean`.
 *   • a data file (csv / json / parquet) — not a database. It is registered as
 *     a view named after itself, so `SELECT * FROM orders` means the file.
 */

const path = require('path');
const duck = require('../duckdb');

/** True when the path is a database rather than a data file. */
const isDb = (dbPath) => /\.duckdb$/i.test(String(dbPath || ''));

/** The view name a bare file is addressable by. */
const viewNameFor = (dbPath) => path.basename(dbPath, path.extname(dbPath)) || 'data';

/**
 * Make `dbPath` queryable by name on the shared connection.
 *
 * For a database this attaches it and returns the alias; for a file it
 * (re)creates the view, recreated per call so a file rewritten on disk — a node
 * output being overwritten — is picked up.
 */
async function ensureView(dbPath) {
  if (!dbPath) throw new Error('DuckDB runQuery requires dbPath');
  if (isDb(dbPath)) return duck.attachDb(dbPath);
  const name = viewNameFor(dbPath);
  const ref = await duck.tableRef(dbPath);
  await duck.exec(`CREATE OR REPLACE VIEW ${duck.quoteIdentifier(name)} AS SELECT * FROM ${ref}`);
  return name;
}

/**
 * runQuery({ dbPath, query })                      — read, returns rows
 * runQuery({ dbPath, operation: 'insert', docs })  — write rows
 *
 * The write form mirrors the NeDB lib's shape, so a caller that used to write a
 * local collection can address local data the same way. Where the rows land
 * follows the path: a database gets a table (`tableName` required), a file is
 * written as Parquet. `mode: 'append'` only applies to a table — a Parquet file
 * is always replaced.
 */
async function runQuery({ dbPath, query, operation, docs, tableName, mode = 'replace' } = {}) {
  if (operation) {
    if (operation !== 'insert') {
      throw new Error(`DuckDB runQuery does not support operation "${operation}" — write rows with { operation: 'insert', docs }, or send SQL as \`query\`.`);
    }
    if (!dbPath) throw new Error('Writing rows requires dbPath');
    const rows = Array.isArray(docs) ? docs : [];
    if (rows.length === 0) throw new Error('DuckDB write requires at least one row');
    if (mode !== 'replace' && mode !== 'append') {
      throw new Error(`Unsupported write mode "${mode}" — use 'replace' or 'append'.`);
    }
    if (!isDb(dbPath)) {
      if (mode === 'append') {
        throw new Error('Appending needs a database path (*.duckdb); a Parquet file is rewritten whole.');
      }
      return duck.ingestRows(rows, dbPath);
    }
    if (!tableName) throw new Error('Writing rows to a database requires a tableName');
    // ...At — this helper is given a database PATH, not a workflow id.
    return duck.ingestRowsToTableAt(rows, dbPath, tableName, { mode });
  }

  if (!query) throw new Error('DuckDB runQuery requires a query string');
  const scope = await ensureView(dbPath);
  const sql = typeof query === 'string' ? query : query.query;
  if (!sql) throw new Error('DuckDB runQuery requires a query string');
  // A database's tables are reached through its alias, so an unqualified name
  // in the caller's SQL resolves there for the duration of this query.
  if (isDb(dbPath)) return (await duck.queryIn(scope, sql)).rows;
  const result = await duck.query(sql);
  return result.rows;
}

async function getTables({ dbPath } = {}) {
  if (isDb(dbPath)) return duck.tablesAt(dbPath);
  await ensureView(dbPath);
  return [viewNameFor(dbPath)];
}

async function getColumns({ dbPath, table } = {}) {
  if (isDb(dbPath)) {
    const alias = await duck.attachDb(dbPath);
    const columns = await duck.describe(
      `${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(duck.sanitizeIdentifier(table))}`,
    );
    return columns.map((c) => ({ name: c.name, type: c.type }));
  }
  const name = await ensureView(dbPath);
  const columns = await duck.describe(duck.quoteIdentifier(table || name));
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

module.exports = { runQuery, getTables, getColumns, ensureView, viewNameFor };
