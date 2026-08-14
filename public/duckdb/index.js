/**
 * DuckDB — the query engine for local files.
 *
 * Local files are no longer imported into SQLite/NeDB before they can be used.
 * They stay where the user put them and are queried in place: a CSV, JSON or
 * Parquet file is addressed by path and read straight off disk, so opening a
 * 5 GB file costs the same as opening a 5 MB one.
 *
 * The instance itself is in-memory: source files are read where they lie, so
 * there is nothing to persist at this level.
 *
 * Node outputs (transformer / join / API results) DO persist — as tables in
 * their workflow's own database, `workflow-data/<workflowId>.duckdb`, attached
 * to this same connection. One database per workflow means two workflows
 * running at once never touch the same file, and a node's result supports
 * ALTER / UPDATE / DELETE like any other table. See the "Workflow databases"
 * section below.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Formats DuckDB reads natively. Anything else is converted to Parquet once,
// at add time, by public/imports/toParquet.js.
const FORMAT_BY_EXT = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.json': 'json',
  '.ndjson': 'json',
  '.jsonl': 'json',
  '.parquet': 'parquet',
};

// DuckDB type names that should render and aggregate as numbers.
const NUMERIC_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;

// Integer types come back from getRowObjectsJson as strings so nothing is lost
// on the way out of C++. Anything that fits a JS number is converted back, so
// the UI and downstream JS see 42 rather than "42"; genuinely huge ids stay
// strings rather than silently losing their last digits.
const INTEGER_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)/i;

let connectionPromise = null;

/**
 * The shared connection. Created on first use — an Electron main process that
 * never touches a local file never pays for loading the native binding.
 */
async function getConnection() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const { DuckDBInstance } = require('@duckdb/node-api');
      const instance = await DuckDBInstance.create(':memory:');
      return instance.connect();
    })().catch((err) => {
      connectionPromise = null; // let a later call retry
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Errors that leave the DATABASE unusable rather than just the statement.
 *
 * DuckDB answers an internal error by invalidating the whole instance: every
 * call after one gets "database has been invalidated … must be restarted",
 * forever, because the instance here is a process-wide singleton. Since these
 * come from statements a user is entitled to write — `ALTER TABLE t ADD COLUMN
 * c STRUCT(…) DEFAULT {…}` is one, on any table past a single vector of rows —
 * a session that cannot recover from one means the Data Explorer stays broken
 * until the app is restarted.
 *
 * Recognised by what DuckDB calls itself. The two are one condition: the
 * INTERNAL error is the statement that poisons the instance, the FATAL error is
 * every statement after it.
 */
const isFatalError = (err) => /^(INTERNAL|FATAL) Error/.test(String(err && err.message));

/**
 * Drop the poisoned instance so the NEXT call builds a fresh one.
 *
 * Everything the old instance held goes with it — attachments, the views the
 * connectors register over files, anything created in the session — so the
 * attachment cache is cleared too, or a re-attach would be skipped as already
 * done. The connectors re-register on their next query (their views are
 * CREATE OR REPLACE and their attach is cached here), so recovery costs the
 * session its temporary tables and nothing else.
 *
 * The statement that hit the error still fails. Only the ones after it are
 * saved.
 */
function resetConnection() {
  connectionPromise = null;
  attached.clear();
}

/**
 * Run something against the shared connection, watching for the kind of failure
 * that takes the connection with it.
 */
async function withConnection(fn) {
  const connection = await getConnection();
  try {
    return await fn(connection);
  } catch (err) {
    if (isFatalError(err)) resetConnection();
    throw err;
  }
}

/** Escape a value for inclusion as a SQL string literal. */
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Escape an identifier for inclusion in SQL. */
const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Format for a path, from its extension. Null when DuckDB can't read it. */
const detectFormat = (filePath) => FORMAT_BY_EXT[path.extname(String(filePath)).toLowerCase()] || null;

const isReadable = (filePath) => detectFormat(filePath) !== null;

/**
 * The FROM expression for a file — this is what makes a path behave like a
 * table. `union_by_name` keeps JSON files with varying keys readable.
 */
function sourceRef(filePath, format = null) {
  const resolved = format || detectFormat(filePath);
  const literal = quoteLiteral(filePath);
  switch (resolved) {
    case 'csv':
      return `read_csv_auto(${literal})`;
    case 'json':
      return `read_json_auto(${literal}, union_by_name = true)`;
    case 'parquet':
      return `read_parquet(${literal})`;
    default:
      throw new Error(`DuckDB cannot read "${path.basename(String(filePath))}" directly — convert it to Parquet first`);
  }
}

// A CSV column whose values overflow BIGINT is sniffed as DOUBLE, which
// silently rounds it — 12345678901234567890 comes back as ...567000. Order
// numbers and external ids land in exactly that range, so those columns are
// forced to VARCHAR instead. 16+ digits is the threshold: 2^63 is 19 digits,
// and a JS double is only exact to 15.
const PRECISION_LOSING_INTEGER = /^[+-]?[0-9]{16,}$/;
const TYPE_OVERRIDE_SAMPLE = 1000;

// Keyed by `path@mtime` so an edited file is re-inspected but a stable one is
// inspected once per session.
const typeOverrideCache = new Map();

const cacheKeyFor = (filePath) => {
  try { return `${filePath}@${fs.statSync(filePath).mtimeMs}`; } catch { return filePath; }
};

/**
 * Columns that must be read as text to survive intact. Sampled — a value that
 * only appears far into a huge file can still be missed, exactly as DuckDB's
 * own sniffer can miss it.
 */
async function csvTypeOverrides(filePath) {
  const key = cacheKeyFor(filePath);
  if (typeOverrideCache.has(key)) return typeOverrideCache.get(key);

  let overrides = [];
  try {
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_csv(${quoteLiteral(filePath)}, all_varchar = true) LIMIT ${TYPE_OVERRIDE_SAMPLE}`,
    );
    const rows = reader.getRowObjectsJson();
    overrides = reader.columnNames().filter((name) =>
      rows.some((row) => typeof row[name] === 'string' && PRECISION_LOSING_INTEGER.test(row[name])));
  } catch {
    // An unreadable file will fail again, with a better message, on the real
    // read — don't turn a sniffing problem into a different error here.
  }

  typeOverrideCache.set(key, overrides);
  return overrides;
}

/**
 * The FROM expression to use for a file, with type corrections applied.
 *
 * Prefer this over `sourceRef` wherever the call site can await — it is what
 * keeps long numeric ids intact. `sourceRef` remains the raw primitive.
 */
async function tableRef(filePath, format = null) {
  const resolved = format || detectFormat(filePath);
  if (resolved !== 'csv') return sourceRef(filePath, resolved);

  const overrides = await csvTypeOverrides(filePath);
  if (overrides.length === 0) return sourceRef(filePath, resolved);

  const types = overrides.map((name) => `${quoteLiteral(name)}: 'VARCHAR'`).join(', ');
  return `read_csv(${quoteLiteral(filePath)}, auto_detect = true, types = {${types}})`;
}

/** Column descriptors in the shape the Data Explorer and previews expect. */
const describeColumns = (reader) => {
  const names = reader.deduplicatedColumnNames
    ? reader.deduplicatedColumnNames()
    : reader.columnNames();
  const types = reader.columnTypes().map((t) => String(t));
  return names.map((name, i) => ({
    name,
    type: types[i],
    numeric: NUMERIC_TYPES.test(types[i]),
    nullable: true,
    isPrimary: false,
  }));
};

/** Undo the string-encoding of integer columns where it is safe to do so. */
function coerceRows(rows, columns) {
  const integerCols = columns.filter((c) => INTEGER_TYPES.test(c.type)).map((c) => c.name);
  if (integerCols.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const name of integerCols) {
      const value = out[name];
      if (typeof value !== 'string' || value === '') continue;
      const num = Number(value);
      if (Number.isSafeInteger(num)) out[name] = num;
    }
    return out;
  });
}

/**
 * Run a statement and read the whole result.
 * @returns {Promise<{ rows: object[], columns: object[], rowCount: number, ms: number }>}
 */
async function query(sql, { params = null } = {}) {
  return withConnection(async (connection) => {
    const started = Date.now();
    const reader = params && params.length
      ? await connection.runAndReadAll(sql, params)
      : await connection.runAndReadAll(sql);
    const columns = describeColumns(reader);
    const rows = coerceRows(reader.getRowObjectsJson(), columns);
    return { rows, columns, rowCount: rows.length, ms: Date.now() - started };
  });
}

/**
 * Run a statement and read AT MOST `maxRows` rows, streaming.
 *
 * DuckDB produces the result in chunks (~2048 rows) and only computes the next
 * one when asked, so a `SELECT *` over a hundred-million-row file costs one
 * chunk here rather than the whole table in this process's heap. The user's SQL
 * is passed through untouched — no injected LIMIT, no wrapping subquery, which
 * would break statements DuckDB accepts but a rewrite wouldn't survive.
 *
 * Because rows arrive a chunk at a time the reader usually overshoots the
 * target; the caller gets the exact cap it asked for and `truncated` tells it
 * whether more was waiting.
 *
 * @returns {Promise<{rows, columns, rowCount, ms, truncated: boolean}>}
 */
async function queryUpTo(sql, maxRows, { params = null } = {}) {
  return withConnection(async (connection) => {
    const started = Date.now();
    const cap = Math.max(1, Number(maxRows) || 1);

    const reader = params && params.length
      ? await connection.streamAndRead(sql, params)
      : await connection.streamAndRead(sql);

    // One past the cap, so "is there more?" is observed rather than assumed.
    await reader.readUntil(cap + 1);

    const columns = describeColumns(reader);
    const all = coerceRows(reader.getRowObjectsJson(), columns);
    const rows = all.slice(0, cap);

    return {
      rows,
      columns,
      rowCount: rows.length,
      ms: Date.now() - started,
      // More rows exist if we saw past the cap, or if the stream isn't drained.
      truncated: all.length > cap || !reader.done,
    };
  });
}

/** Run a statement for its side effects. */
async function exec(sql) {
  await withConnection((connection) => connection.run(sql));
}

/** The trailing semicolon a worksheet leaves behind, dropped. */
const trimStatement = (sql) => String(sql || '').trim().replace(/;+\s*$/, '');

/**
 * How many statements DuckDB sees in this script.
 *
 * Not the same as how many the user typed, in BOTH directions. A worksheet may
 * hold several, and DuckDB expands some single statements into a transaction of
 * its own making: `ALTER TABLE t ADD COLUMN c … DEFAULT <expr>` becomes BEGIN,
 * the ADD COLUMN, an UPDATE that backfills the rows that already exist, a SET
 * DEFAULT, COMMIT — five — for every default but a bare literal. (`true` is a
 * cast to the parser, not a literal, so it expands too.)
 *
 * Extraction parses without binding: a syntax error throws here, an unknown
 * table does not.
 */
async function statementCount(sql) {
  return withConnection(async (connection) => {
    const extracted = await connection.extractStatements(trimStatement(sql));
    return Number(extracted.count) || 0;
  });
}

/**
 * What KIND of statement number `index` is, straight from DuckDB: `SELECT`,
 * `UPDATE`, `INSERT`, `DELETE`, `ALTER`, `COPY`, `MERGE_INTO`, `TRANSACTION`, …
 *
 * This is how a caller asks the ENGINE what a statement is instead of reading
 * its text: `WITH x AS (…) INSERT …` starts with a keyword that says SELECT,
 * and no amount of pattern matching gets that right. Preparing a statement
 * plans and binds it but runs NOTHING, so asking is free of side effects.
 *
 * Because it binds, a statement that cannot run as written throws HERE, before
 * anything has been read or copied. Callers use that: the throw is the answer.
 * In particular DuckDB refuses to bind a write against a view, which is how the
 * connectors tell a write apart from a read over a file.
 *
 * One statement at a time, by index, because `prepare` takes exactly one and
 * refuses a script outright — which is what an expanded ALTER looks like to it.
 * A statement is re-extracted on every call: an extracted statement can only be
 * prepared ONCE, and the same index is asked about repeatedly while a caller
 * works out what a script touches.
 *
 * Binding a statement mid-script can fail for a reason that is not a fault —
 * the backfilling UPDATE above names a column the ADD COLUMN in front of it has
 * not created yet. So a throw means "not as the catalog stands right now",
 * which is only the whole answer for the statement a script starts with.
 *
 * @returns {Promise<string>} a StatementType name
 */
async function statementType(sql, index = 0) {
  return withConnection(async (connection) => {
    // Required here rather than at module load for the same reason the instance
    // is: a main process that never opens a local file never loads the binding.
    const { StatementType } = require('@duckdb/node-api');
    const extracted = await connection.extractStatements(trimStatement(sql));
    const prepared = await extracted.prepare(index);
    try {
      // The enum maps both ways, so a numeric type reads back as its name.
      return StatementType[prepared.statementType] || String(prepared.statementType);
    } finally {
      prepared.destroySync();
    }
  });
}

/**
 * A cheap signature for a table: its column shape, its row count, and an
 * order-independent hash of its rows, as one string.
 *
 * Used to tell whether a statement actually changed a table, so only what
 * changed gets written back to disk. Two different signatures are proof of a
 * change; identical ones mean no change short of a hash collision, which at 64
 * bits is not a thing that happens by accident. Row ORDER is deliberately not
 * part of it — a rewrite that only reshuffles rows is not worth rewriting a
 * file for.
 *
 * The SHAPE — column names and types, in order — is part of it because DDL is a
 * change the rows do not show. `ADD COLUMN c INTEGER[]` fills every row with
 * NULL, and a NULL list contributes nothing to `hash(row)`: DuckDB hashes the
 * widened column to exactly what the row hashed to without it, so a
 * content-only signature calls the ALTER a no-op and the column is never
 * written to the file. RENAME COLUMN and a type change are invisible to row
 * content for the same reason — they do not touch a value. Reading the shape
 * costs no rows; `SELECT * … LIMIT 0` is answered from the catalog.
 *
 * Rows are summed rather than XORed. XOR is self-inverse, so identical rows
 * cancel in PAIRS: a table whose every distinct row appears an even number of
 * times hashes to 0 no matter what those rows hold, and an UPDATE across them
 * lands on 0 again. Summing has no such identity — duplicate rows accumulate
 * instead of erasing each other — and it stays order-independent, which is the
 * one property XOR was chosen for. The cast to HUGEINT is what keeps the sum
 * from overflowing a 64-bit accumulator.
 */
async function fingerprint(ref) {
  const { columns } = await query(`SELECT * FROM ${ref} LIMIT 0`);
  const shape = columns.map((c) => `${c.name}:${c.type}`).join(',');
  const { rows } = await query(
    `SELECT count(*) AS n, sum(hash(t)::HUGEINT) AS h FROM ${ref} t`,
  );
  const row = rows[0] || {};
  return `${shape}|${row.n ?? 0}:${row.h ?? 'empty'}`;
}

/**
 * Columns of a file (or of any FROM expression) without reading its rows.
 * DESCRIBE only touches enough of the file to infer the schema.
 */
async function describe(fromExpression) {
  const { columns } = await query(`SELECT * FROM ${fromExpression} LIMIT 0`);
  return columns;
}

/** First `limit` rows of a file, plus its columns. The preview primitive. */
async function readHead(filePath, limit = 1000, format = null) {
  const ref = await tableRef(filePath, format);
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/** Total rows in a file. Cheap for Parquet (metadata), a scan for CSV/JSON. */
async function countRows(filePath, format = null) {
  const ref = await tableRef(filePath, format);
  const { rows } = await query(`SELECT count(*) AS c FROM ${ref}`);
  return Number(rows[0]?.c ?? 0);
}

/**
 * Schema in the `{ tableName, columns, sampleData }` shape the node chats,
 * prompts and preview grid all already speak.
 */
async function fileSchema(filePath, { sampleLimit = 5, format = null } = {}) {
  const { rows, columns } = await readHead(filePath, sampleLimit, format);
  const sampleData = rows.map((row) => {
    const trimmed = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      trimmed[key] = (typeof value === 'string' && value.length > 100)
        ? `${value.substring(0, 100)}...`
        : value;
    }
    return trimmed;
  });
  return {
    tableName: path.basename(filePath, path.extname(filePath)),
    columns: columns.map(({ name, type, nullable, isPrimary }) => ({ name, type, nullable, isPrimary })),
    sampleData,
  };
}

/** Make sure a node output's folder exists before writing into it. */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** COPY options per format, so a file is rewritten in the format it already is. */
function copyOptionsFor(format, outPath) {
  switch (format) {
    case 'csv': {
      // Keep the delimiter the file already uses; .tsv is still 'csv' to us.
      const delimiter = /\.tsv$/i.test(outPath) ? '\t' : ',';
      return `FORMAT CSV, HEADER, DELIMITER ${quoteLiteral(delimiter)}`;
    }
    case 'json':
      // A .json file is an array; .ndjson / .jsonl are one object per line.
      return /\.(ndjson|jsonl)$/i.test(outPath) ? 'FORMAT JSON' : 'FORMAT JSON, ARRAY true';
    case 'parquet':
      return 'FORMAT PARQUET';
    default:
      throw new Error(`Cannot write ${format || 'this format'} — expected csv, json or parquet`);
  }
}

/**
 * Materialise a query as a data file, in the format the path implies.
 *
 * The write goes to a sibling temp file and is renamed into place, so a failed
 * run can't leave a half-written file behind, and so a caller can safely
 * overwrite the same path it read from.
 */
async function copyToFile(selectSql, outPath, format = null) {
  const resolved = format || detectFormat(outPath);
  const options = copyOptionsFor(resolved, outPath);
  ensureDir(outPath);
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await exec(`COPY (${selectSql}) TO ${quoteLiteral(tempPath)} (${options})`);
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return outPath;
}

const copyToParquet = (selectSql, outPath) => copyToFile(selectSql, outPath, 'parquet');

/**
 * Spool rows to a newline-delimited JSON file and hand the path back.
 *
 * DuckDB infers the column types from the staged file — better inference than
 * we could do in JS, and it keeps the streaming readers on the producing side
 * unchanged. The caller owns the file and must delete it.
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {{ onProgress?: (info: {rows: number}) => void }} options
 * @returns {Promise<{ stagePath: string, count: number }>}
 */
async function stageRowsAsNdjson(rows, { onProgress = null } = {}) {
  const stagePath = path.join(
    os.tmpdir(),
    `ternlux-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ndjson`,
  );
  const stage = fs.createWriteStream(stagePath);
  let count = 0;
  let lastReport = 0;

  const write = async (chunk) => {
    if (!stage.write(chunk)) await new Promise((resolve) => stage.once('drain', resolve));
  };

  try {
    let buffer = '';
    for await (const row of rows) {
      buffer += `${JSON.stringify(row)}\n`;
      count++;
      if (buffer.length > (1 << 20)) { await write(buffer); buffer = ''; }
      if (onProgress && Date.now() - lastReport >= 250) {
        lastReport = Date.now();
        onProgress({ rows: count });
      }
    }
    if (buffer) await write(buffer);
    await new Promise((resolve, reject) => {
      stage.on('error', reject);
      stage.end(resolve);
    });
    return { stagePath, count };
  } catch (error) {
    fs.rmSync(stagePath, { force: true });
    throw error;
  }
}

/** The FROM expression that reads a staged NDJSON file back. */
const stagedRef = (stagePath) =>
  `read_json_auto(${quoteLiteral(stagePath)}, format = 'newline_delimited', union_by_name = true)`;

/**
 * Write rows from an async iterable to Parquet.
 *
 * Used for the formats DuckDB can't read (xls/xlsx/avro) at import time. Node
 * outputs no longer come through here — those are tables in the workflow's own
 * database (see ingestRowsToTable).
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {string} outPath
 * @param {{ onProgress?: (info: {rows: number}) => void }} options
 */
async function ingestRows(rows, outPath, { onProgress = null } = {}) {
  ensureDir(outPath);
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    await copyToParquet(`SELECT * FROM ${stagedRef(stagePath)}`, outPath);
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, path: outPath };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Workflow databases
//
// A node's output is a TABLE in its workflow's own database file,
// `workflow-data/<workflowId>.duckdb`, attached to the shared connection under
// a stable alias. Two things follow from that:
//
//   • ALTER / UPDATE / DELETE / INSERT work directly. An in-place transform is
//     the statement the user asked for, not a full-file rewrite expressed as a
//     SELECT projection (which silently dropped any column the model forgot to
//     list).
//   • One database per workflow, so two workflows running at once never touch
//     the same file. Within a workflow, writes are serialized by
//     withWorkflowLock — the same workflow can be triggered twice at once
//     (a cron firing while the user hits Execute), and DuckDB would otherwise
//     fail the second writer rather than queue it.
//
// Everything is attached to the ONE in-memory instance, so a node can join its
// own table against a Parquet/CSV source file in a single query.
// ───────────────────────────────────────────────────────────────────────────

/** `[^a-zA-Z0-9_]` collapsed, so the result is always a legal identifier. */
const sanitizeIdentifier = (value) => String(value || '')
  .replace(/[^a-zA-Z0-9_]/g, '_')
  .slice(0, 80);

/** Where a workflow's database lives. */
function workflowDbPath(workflowId) {
  if (!workflowId) throw new Error('A workflow id is required to resolve its database');
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'workflow-data', `${sanitizeIdentifier(workflowId)}.duckdb`);
}

/**
 * The alias a database file is attached under. Derived from the file, so the
 * same database gets the same alias whether the caller has the workflow id or
 * only the path recorded on a node's config.
 */
const aliasForDbPath = (dbPath) => `wf_${sanitizeIdentifier(path.basename(String(dbPath), '.duckdb'))}`;

/** The alias a workflow's database is attached under. */
const workflowAlias = (workflowId) => aliasForDbPath(workflowDbPath(workflowId));

// alias → promise of the completed ATTACH. Cached so concurrent callers share
// one attach rather than racing to issue it twice.
const attached = new Map();

/**
 * Attach a database file (once per session) and return its alias.
 * Creates the file if it does not exist yet.
 */
async function attachDb(dbPath) {
  const alias = aliasForDbPath(dbPath);
  if (!attached.has(alias)) {
    const pending = (async () => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      await exec(`ATTACH IF NOT EXISTS ${quoteLiteral(dbPath)} AS ${quoteIdentifier(alias)}`);
      return alias;
    })().catch((err) => {
      attached.delete(alias); // let a later call retry
      throw err;
    });
    attached.set(alias, pending);
  }
  return attached.get(alias);
}

/** Attach a workflow's database and return its alias. */
const attachWorkflow = (workflowId) => attachDb(workflowDbPath(workflowId));

/** First `limit` rows of a table in a database addressed by PATH. */
async function readTableHeadAt(dbPath, tableName, limit = 1000) {
  const alias = await attachDb(dbPath);
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/** Tables held in a database addressed by PATH. */
async function tablesAt(dbPath) {
  const alias = await attachDb(dbPath);
  const { rows } = await query(
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ${quoteLiteral(alias)} ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Detach a workflow's database — used when its file is being replaced/removed. */
async function detachWorkflow(workflowId) {
  const alias = workflowAlias(workflowId);
  if (!attached.has(alias)) return;
  attached.delete(alias);
  try {
    await exec(`DETACH ${quoteIdentifier(alias)}`);
  } catch {
    // Already gone, or never finished attaching. Either way there is nothing
    // left to release.
  }
}

/**
 * The qualified reference for a node's output table, e.g. `"wf_abc"."orders"`.
 * Attaches the database first, so this is the only call a writer needs.
 */
async function workflowTableRef(workflowId, tableName) {
  const alias = await attachWorkflow(workflowId);
  return `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
}

// workflowId → tail of its write queue. Keyed by id, so unrelated workflows
// never wait on each other.
const workflowLocks = new Map();

/** Run `fn` with exclusive access to one workflow's database. */
function withWorkflowLock(workflowId, fn) {
  const key = workflowAlias(workflowId);
  const previous = workflowLocks.get(key) || Promise.resolve();
  // Chain off the previous holder's SETTLEMENT, not its value — one failed
  // write must not poison every write queued behind it.
  const next = previous.then(fn, fn);
  // Keep the queue tail non-rejecting for the same reason.
  workflowLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

// Guards anything that changes CONNECTION state rather than one database's
// contents. There is a single shared connection, so a `USE` issued for one
// workflow is visible to every other caller that runs between our statements.
let sessionQueue = Promise.resolve();
function withSession(fn) {
  const next = sessionQueue.then(fn, fn);
  sessionQueue = next.then(() => {}, () => {});
  return next;
}

// The catalog the connection starts in, to return to after a `USE`.
let defaultDatabase = null;
async function currentDatabase() {
  if (!defaultDatabase) {
    const { rows } = await query('SELECT current_database() AS d');
    defaultDatabase = rows[0]?.d || 'memory';
  }
  return defaultDatabase;
}

/**
 * Run `fn` with `alias` as the current catalog, so an unqualified `orders`
 * means that database's orders table.
 *
 * Qualifying the identifiers instead would mean rewriting the SQL the model
 * wrote, and wrapping the table in a view is not an option — DuckDB can only
 * update a base table.
 *
 * Takes the session lock, so callers that also hold a workflow lock must take
 * that one FIRST to keep the ordering consistent and avoid deadlock.
 */
async function withCatalog(alias, fn) {
  const home = await currentDatabase();
  return withSession(async () => {
    await exec(`USE ${quoteIdentifier(alias)}`);
    try {
      return await fn();
    } finally {
      await exec(`USE ${quoteIdentifier(home)}`);
    }
  });
}

/**
 * Run statements against a workflow's database. `sql` may contain several
 * separated by semicolons; they run as one unit.
 */
async function execInWorkflow(workflowId, sql) {
  const alias = await attachWorkflow(workflowId);
  return withCatalog(alias, () => exec(sql));
}

/**
 * Run statements against the database at `dbPath`, addressed by path rather
 * than by workflow id. Unqualified names resolve inside it, so a statement can
 * modify one of its tables directly — no copy, no write-back.
 */
async function execInDb(dbPath, sql) {
  const alias = await attachDb(dbPath);
  return withCatalog(alias, () => exec(sql));
}

/** Row count of a table in the database at `dbPath`. */
async function tableRowCountIn(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const { rows } = await queryIn(alias, `SELECT count(*) AS c FROM ${quoteIdentifier(tableName)}`);
  return Number(rows[0]?.c ?? 0);
}

/** Run a read against an attached database, resolving unqualified names in it. */
async function queryIn(alias, sql) {
  return withCatalog(alias, () => query(sql));
}

/** Replace a node's output table with the result of `selectSql`. */
async function createTableAs(workflowId, tableName, selectSql) {
  const ref = await workflowTableRef(workflowId, tableName);
  await exec(`CREATE OR REPLACE TABLE ${ref} AS ${selectSql}`);
  return ref;
}

/** Does the database at this PATH already hold that table? */
async function tableExistsAt(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const { rows } = await query(
    `SELECT count(*) AS c FROM duckdb_tables()
      WHERE database_name = ${quoteLiteral(alias)} AND table_name = ${quoteLiteral(sanitizeIdentifier(tableName))}`,
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

/** Does this workflow's database already hold that table? */
const tableExists = (workflowId, tableName) => tableExistsAt(workflowDbPath(workflowId), tableName);

/** Rows currently in a table, in a database addressed by PATH. */
async function tableRowCountAt(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  const { rows } = await query(`SELECT count(*) AS c FROM ${ref}`);
  return Number(rows[0]?.c ?? 0);
}

/** Rows currently in a node's output table. */
const tableRowCount = (workflowId, tableName) =>
  tableRowCountAt(workflowDbPath(workflowId), tableName);

/** First `limit` rows of a node's output table, plus its columns. */
async function readTableHead(workflowId, tableName, limit = 1000) {
  const ref = await workflowTableRef(workflowId, tableName);
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/**
 * Write rows from an async iterable into a table, in a database addressed by
 * PATH.
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {{ mode?: 'replace'|'append', onProgress?: function }} options
 */
async function ingestRowsToTableAt(rows, dbPath, tableName, { mode = 'replace', onProgress = null } = {}) {
  const alias = await attachDb(dbPath);
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    if (mode === 'append' && await tableExistsAt(dbPath, tableName)) {
      // BY NAME so a row missing a column lands as NULL instead of failing on
      // column order. It does NOT cover the other direction — a batch carrying
      // a field the table has never seen errors — so add those columns first.
      // These rows come from schemaless places (an API response, a JS
      // transform), where a new field appearing is ordinary.
      const existing = new Set((await describe(ref)).map((c) => c.name));
      const incoming = await describe(stagedRef(stagePath));
      for (const column of incoming.filter((c) => !existing.has(c.name))) {
        await exec(`ALTER TABLE ${ref} ADD COLUMN ${quoteIdentifier(column.name)} ${column.type}`);
      }
      await exec(`INSERT INTO ${ref} BY NAME SELECT * FROM ${stagedRef(stagePath)}`);
    } else {
      await exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${stagedRef(stagePath)}`);
    }
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, tableName: sanitizeIdentifier(tableName) };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

/** Write rows into a table in a workflow's database. */
const ingestRowsToTable = (rows, workflowId, tableName, options = {}) =>
  ingestRowsToTableAt(rows, workflowDbPath(workflowId), tableName, options);

// ── staging ────────────────────────────────────────────────────────────────
//
// Work that only has to survive one operation — a join source pulled from a
// remote database, the scratch copy an in-place file update mutates — lives in
// a schema of its own inside the workflow's database. Keeping it there rather
// than in the OS temp directory means one file holds everything a workflow
// touches, and a staging table can be joined against a node's output without
// leaving the database.
//
// The schema is separate from `main` so a staging table may safely carry the
// same name as a node output: the model writes `UPDATE people ...` about the
// source it was given, and that must not overwrite a node output called
// `people`.
const STAGING_SCHEMA = 'ternlux_staging';

/** The staging schema in a database, created on first use. Returns its alias. */
async function ensureStagingSchema(dbPath) {
  const alias = await attachDb(dbPath);
  await exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(alias)}.${quoteIdentifier(STAGING_SCHEMA)}`);
  return alias;
}

/** Fully-qualified reference to a staging table. */
async function stagingRef(dbPath, tableName) {
  const alias = await ensureStagingSchema(dbPath);
  return `${quoteIdentifier(alias)}.${quoteIdentifier(STAGING_SCHEMA)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
}

/** Load rows into a staging table in `dbPath`, replacing any previous one. */
async function ingestRowsToStaging(rows, dbPath, tableName, { onProgress = null } = {}) {
  const ref = await stagingRef(dbPath, tableName);
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    await exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${stagedRef(stagePath)}`);
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, ref };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

/**
 * Run statements with the staging schema first on the search path, so an
 * unqualified name in the caller's SQL means its staging table.
 */
async function execInStaging(dbPath, sql) {
  const alias = await ensureStagingSchema(dbPath);
  return withCatalog(alias, async () => {
    await exec(`SET search_path = ${quoteLiteral(`${STAGING_SCHEMA},main`)}`);
    try {
      return await exec(sql);
    } finally {
      await exec("SET search_path = 'main'");
    }
  });
}

/** Drop staging tables once the operation that created them is done. */
async function dropStaging(dbPath, tableNames) {
  for (const name of tableNames || []) {
    try {
      await exec(`DROP TABLE IF EXISTS ${await stagingRef(dbPath, name)}`);
    } catch (err) {
      console.warn('[duckdb] Could not drop staging table', name, err.message);
    }
  }
}

/** Delete a workflow's database entirely — called when the workflow is deleted. */
async function dropWorkflowDb(workflowId) {
  await detachWorkflow(workflowId);
  const dbPath = workflowDbPath(workflowId);
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}.wal`, { force: true });
}

/** Release the connection — called on app shutdown. */
async function close() {
  if (!connectionPromise) return;
  const pending = connectionPromise;
  connectionPromise = null;
  try {
    const connection = await pending;
    // Fold each workflow database's write-ahead log into the database itself.
    // Without this every workflow-data folder is left holding a `.duckdb.wal`
    // beside its database — recoverable (DuckDB replays it on the next attach)
    // but alarming to find, and it keeps growing across sessions.
    for (const alias of attached.keys()) {
      try { await connection.run(`CHECKPOINT ${quoteIdentifier(alias)}`); } catch { /* nothing to flush */ }
    }
    attached.clear();
    connection.closeSync();
  } catch {
    // Already gone; nothing to release.
  }
}

module.exports = {
  getConnection,
  query,
  queryUpTo,
  exec,
  statementCount,
  statementType,
  fingerprint,
  describe,
  describeColumns,
  readHead,
  countRows,
  fileSchema,
  copyToParquet,
  copyToFile,
  ingestRows,
  sourceRef,
  tableRef,
  detectFormat,
  isReadable,
  quoteLiteral,
  quoteIdentifier,
  close,
  FORMAT_BY_EXT,
  // Workflow databases — a node output is a table in its workflow's own file.
  workflowDbPath,
  workflowAlias,
  aliasForDbPath,
  attachDb,
  attachWorkflow,
  detachWorkflow,
  readTableHeadAt,
  tablesAt,
  workflowTableRef,
  withWorkflowLock,
  withSession,
  withCatalog,
  currentDatabase,
  execInWorkflow,
  execInDb,
  tableRowCountIn,
  queryIn,
  createTableAs,
  tableExists,
  tableExistsAt,
  tableRowCount,
  tableRowCountAt,
  readTableHead,
  ingestRowsToTable,
  ingestRowsToTableAt,
  ingestRowsToStaging,
  stagingRef,
  execInStaging,
  dropStaging,
  STAGING_SCHEMA,
  dropWorkflowDb,
  sanitizeIdentifier,
};
