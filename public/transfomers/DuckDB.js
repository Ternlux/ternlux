/**
 * Local transformations, on DuckDB.
 *
 * By default a workflow owns one database file — `workflow-data/<workflowId>.duckdb`
 * — and a node's output is an ordinary table inside it. One database per
 * workflow means two workflows running at once never touch the same file, and
 * table names need no per-workflow prefix the way they did when every transform
 * shared one SQLite database.
 *
 * Storing results as tables is what makes `in_place` honest: the model writes
 * the ALTER / UPDATE / DELETE it means, against the rows it means. Nothing is
 * rewritten wholesale, so a change to one column cannot drop the others.
 *
 * A NEW table is always written to that database, never to a data file.
 *
 * `in_place` is the other half: it changes the source itself. A DuckDB table
 * is modified directly; a CSV/JSON/Parquet file is materialised, mutated and
 * written back over itself, since no file format supports row mutation.
 *
 * Sources are read where they lie: a CSV/JSON/Parquet file is registered as a
 * view and queried in place, never imported first.
 *
 * So a node config records `targetLocalPath` — its workflow's database for a
 * new table, the source itself for in-place — plus `targetTableName`.
 */

const fs = require('fs');
const path = require('path');

const duck = require('../duckdb');

/**
 * The table an in-place file update is staged under.
 *
 * Derived from the node id, so it is unique: two transformers updating the
 * same file at once get their own staging tables instead of fighting over one
 * name. Both the prompt (which tells the model what to write statements
 * against) and the executor call this, so the name the model uses and the name
 * that exists can never drift apart.
 */
function stagingTableFor(nodeId, fallback = null) {
  if (!nodeId) return fallback;
  return `transformer_${String(nodeId).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** Where a node's output goes: its workflow's database. */
function resolveOutputPath(_targetName, { workflowId = null } = {}) {
  if (!workflowId) {
    throw new Error('A node output needs a workflow id to resolve its database');
  }
  return duck.workflowDbPath(workflowId);
}

/**
 * The database a node writes to.
 *
 * `targetLocalPath` is honoured only when it names a DuckDB database. A node
 * config that points at a data file is resolved to the workflow's database
 * instead, so outputs are always tables.
 */
function resolveTargetDb(targetLocalPath, scope) {
  return isWorkflowDb(targetLocalPath) ? targetLocalPath : resolveOutputPath(null, scope);
}

/** True when a path is a workflow database rather than a data file. */
const isWorkflowDb = (filePath) => /\.duckdb$/i.test(String(filePath || ''));

/**
 * Make the source addressable by the name the transform SQL refers to.
 *
 * The model writes `SELECT … FROM orders`, so `orders` has to resolve. The
 * source is either another node's table in a workflow database, or a file on
 * disk; both end up as a view under the expected name. A file is also
 * registered under its own basename, since the two don't always agree.
 */
async function registerSource(sourceLocalPath, tableName, format = null, { workflowId = null, connectionName = null } = {}) {
  if (!sourceLocalPath) throw new Error('DuckDB transform requires a source');

  // Upstream node output — already a table in a workflow database. The attach
  // makes `<workflowAlias>.<table>` resolve on its own, so only the bare view
  // has to be added. There is no connection to name a schema after.
  if (isWorkflowDb(sourceLocalPath)) {
    if (!tableName) throw new Error('Reading a workflow table requires its name');
    const ref = await duck.workflowTableRef(workflowId, tableName);
    await duck.registerAddressableViews({
      body: `SELECT * FROM ${ref}`,
      names: [tableName],
    });
    return ref;
  }

  if (!fs.existsSync(sourceLocalPath)) throw new Error(`Source file not found: ${sourceLocalPath}`);
  // For a workbook the table name is the sheet; for everything else it is just
  // a label and this resolves to null.
  const ref = await duck.tableRef(sourceLocalPath, format, {
    sheet: duck.sheetFor(sourceLocalPath, tableName),
  });
  // Bare AND `<connection>.<table>`, so SQL written against what the Data
  // Explorer displays runs here too. `connectionName` falls back to the file's
  // own basename, which is what registerLocalFile names an imported file after.
  await duck.registerAddressableViews({
    body: `SELECT * FROM ${ref}`,
    names: [tableName, path.basename(sourceLocalPath, path.extname(sourceLocalPath))],
    connectionName: connectionName || path.basename(sourceLocalPath, path.extname(sourceLocalPath)),
  });
  return ref;
}

/**
 * The shape — and optionally a few example rows — a transform WOULD produce,
 * without producing it.
 *
 * A node records its output schema at build time so the next node can be
 * configured against it, but the transform hasn't run yet, so the schema has to
 * be derived. DuckDB can answer this over a tiny relation: the source is read
 * `LIMIT n`, the statements are applied to that copy, and the result described.
 *
 * `sampleRows` (default 0) also reads that many rows back. Those rows are what
 * downstream builders see as "Sample rows" when they are configured against
 * this node, so an empty sample leaves the next node's prompt with column names
 * and no values. Costs stay bounded because only `sampleRows` rows are ever
 * materialised for an in-place transform, and the new-table path streams with
 * `queryUpTo` rather than reading a whole result.
 *
 * Caveat worth knowing: sampling runs the statements over a SLICE of the
 * source, so values that depend on the whole table (aggregates, window
 * functions, a subquery over the same source) are indicative of shape, not of
 * what the real run will compute. A filter that matches none of the sampled
 * rows yields an empty sample.
 *
 * Returns `null` when the shape can't be determined — the caller falls back to
 * assuming the source's own columns rather than failing the build. A failure to
 * read SAMPLE rows never costs the columns; the sample just comes back empty.
 *
 * @returns {Promise<{columns: Array<{name, type}>, sampleData: object[]}|null>}
 */
async function describeResult({
  sourceLocalPath,
  sql,
  operationMode,
  targetTableName,
  sourceTableName = null,
  sourceFormat = null,
  // Names the schema the source is also registered under, so SQL written as
  // `<connection>.<table>` (what the Data Explorer shows) resolves here too.
  connectionName = null,
  workflowId = null,
  nodeId = null,
  sampleRows = 0,
}) {
  if (!sql || !sourceLocalPath) return null;

  const limit = Math.max(0, Number(sampleRows) || 0);
  const asColumns = (cols) => cols.map((c) => ({ name: c.name, type: c.type }));

  try {
    const sourceName = sourceTableName || targetTableName;

    // A new table is just the shape of its SELECT.
    if (operationMode !== 'in_place') {
      const clean = String(sql).replace(/;\s*$/, '');
      return await duck.withSession(async () => {
        await registerSource(sourceLocalPath, sourceName, sourceFormat, { workflowId, connectionName });
        const columns = asColumns(await duck.describe(`(${clean})`));
        let sampleData = [];
        if (limit > 0) {
          try {
            // Streams and stops early, so a plain projection over a huge file
            // costs one chunk. An aggregating SELECT still has to be computed —
            // there is no shape-preserving way around that.
            const { rows } = await duck.queryUpTo(`SELECT * FROM (${clean})`, limit);
            sampleData = rows;
          } catch (err) {
            console.warn('[DuckDB] Could not sample result rows:', err.message);
          }
        }
        return { columns, sampleData };
      });
    }

    // In place: build a copy under exactly the name the statements address,
    // apply them to that, and read the shape off it. The statements run
    // unmodified — the name resolves because staging leads the search path, the
    // same way the real run resolves it. The copy holds only `limit` rows, so
    // this costs the same on a 5 GB file as on a small one.
    const stagingDb = resolveOutputPath(null, { workflowId, nodeId });
    const stageTable = isWorkflowDb(sourceLocalPath)
      ? sourceName
      : stagingTableFor(nodeId, sourceName);

    return await duck.withWorkflowLock(workflowId, async () => {
      const ref = await duck.stagingRef(stagingDb, stageTable);
      const from = isWorkflowDb(sourceLocalPath)
        ? await duck.workflowTableRef(workflowId, sourceName)
        // The preview has to read the same sheet the real run will, or it
        // describes a shape the transform never sees.
        : await duck.tableRef(sourceLocalPath, sourceFormat, {
          sheet: duck.sheetFor(sourceLocalPath, sourceName),
        });
      await duck.exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${from} LIMIT ${limit}`);
      try {
        await duck.execInStaging(stagingDb, sql);
        const columns = asColumns(await duck.describe(ref));
        let sampleData = [];
        if (limit > 0) {
          try {
            const { rows } = await duck.query(`SELECT * FROM ${ref} LIMIT ${limit}`);
            sampleData = rows;
          } catch (err) {
            console.warn('[DuckDB] Could not sample result rows:', err.message);
          }
        }
        return { columns, sampleData };
      } finally {
        await duck.dropStaging(stagingDb, [stageTable]);
      }
    });
  } catch (err) {
    console.warn('[DuckDB] Could not derive result schema:', err.message);
    return null;
  }
}

/**
 * Run a transform and store the result as the node's output.
 *
 * @param {object} params
 * @param {string} params.sourceLocalPath   - what the transform reads (a file,
 *                                            or a workflow database when the
 *                                            source is an upstream node)
 * @param {string} params.sql               - the SELECT the model authored
 * @param {string} params.targetTableName   - the output table
 * @param {string} [params.targetLocalPath] - the workflow database; a path
 *                                            naming anything else is ignored
 * @param {string} [params.sourceTableName] - the source's table, when it is an
 *                                            upstream node's output
 * @returns {Promise<{success, message, rowCount, localPath, targetTableName}>}
 */
async function createLocalTable({
  sourceLocalPath,
  sql,
  targetTableName,
  targetLocalPath = null,
  sourceTableName = null,
  sourceFormat = null,
  // Names the schema the source is also registered under, so SQL written as
  // `<connection>.<table>` (what the Data Explorer shows) resolves here too.
  connectionName = null,
  workflowId = null,
  nodeId = null,
}) {
  if (!sql) throw new Error('DuckDB transform requires a SQL statement');
  if (!targetTableName) throw new Error('DuckDB transform requires a target table name');

  const outPath = resolveTargetDb(targetLocalPath, { workflowId, nodeId });
  const sourceName = sourceTableName || targetTableName;

  const rowCount = await duck.withWorkflowLock(workflowId, async () => {
    await registerSource(sourceLocalPath, sourceName, sourceFormat, { workflowId, connectionName });
    await duck.createTableAs(workflowId, targetTableName, sql);
    return duck.tableRowCount(workflowId, targetTableName);
  });

  return {
    success: true,
    message: `Transformed ${rowCount} row(s) into ${targetTableName}`,
    rowCount,
    localPath: outPath,
    localDbPath: outPath,
    targetTableName,
  };
}

/**
 * In-place transform: change the source itself.
 *
 * `sql` is the statement the model meant — ALTER TABLE, UPDATE, DELETE, or
 * several separated by semicolons — applied to the data where it already
 * lives. What that takes depends on what the source is:
 *
 *   DuckDB database (.duckdb) — a table, so the statements run against it
 *     directly, addressed by path + table name. Nothing is copied.
 *
 *   Data file (csv / json / parquet) — no format on disk supports row
 *     mutation, so the file is materialised into a temp table, the statements
 *     are applied there, and the result is written back over the original in
 *     its own format. The write is atomic (temp file, then rename), so a
 *     failure leaves the original untouched.
 */
async function inPlaceLocalUpdate({
  sourceLocalPath,
  sql,
  targetTableName,
  targetLocalPath = null,
  sourceTableName = null,
  sourceFormat = null,
  workflowId = null,
  nodeId = null,
}) {
  if (!sql) throw new Error('DuckDB in-place transform requires a SQL statement');
  if (!targetTableName) throw new Error('DuckDB in-place transform requires a target table name');

  // In-place updates what it reads. A recorded target is only consulted when
  // there is no source to speak of.
  const target = sourceLocalPath || targetLocalPath;
  if (!target) throw new Error('DuckDB in-place transform requires a source to update');

  // A table in a database is addressed by its real name. A file has no table
  // of its own, so its scratch copy is staged under this node's name — the same
  // name the prompt told the model to write statements against.
  const dbTableName = sourceTableName || targetTableName;
  const stageTable = stagingTableFor(nodeId, sourceTableName || targetTableName);

  // ── a table in a DuckDB database: modify it where it is ──────────────────
  if (isWorkflowDb(target)) {
    const run = async () => {
      await duck.execInDb(target, sql);
      return duck.tableRowCountIn(target, dbTableName);
    };
    // A workflow's own database is written under its lock; another database
    // addressed by path has no workflow to serialise against.
    const rowCount = workflowId && target === duck.workflowDbPath(workflowId)
      ? await duck.withWorkflowLock(workflowId, run)
      : await run();

    return {
      success: true,
      message: `Updated ${dbTableName} — ${rowCount} row(s)`,
      rowCount,
      localPath: target,
      localDbPath: target,
      targetTableName: dbTableName,
    };
  }

  // ── a data file: materialise, mutate, write back ─────────────────────────
  if (!fs.existsSync(target)) throw new Error(`Source file not found: ${target}`);
  const format = sourceFormat || duck.detectFormat(target);
  const stagingDb = resolveOutputPath(null, { workflowId, nodeId });

  // A workbook holds a table per sheet, so the table name is what says WHICH
  // sheet this node reads and writes. Without it the read takes the first sheet
  // whatever the node meant, and the write replaces the entire workbook.
  const sheet = duck.sheetFor(target, dbTableName);

  const rowCount = await duck.withWorkflowLock(workflowId, async () => {
    // The scratch copy is a staging table in this workflow's own database. It
    // gives the statements something they can modify and takes the file out of
    // the picture before it is rewritten.
    const ref = await duck.stagingRef(stagingDb, stageTable);
    const fileRef = await duck.tableRef(target, format, { sheet });
    await duck.exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${fileRef}`);
    try {
      await duck.execInStaging(stagingDb, sql);
      await duck.copyToFile(`SELECT * FROM ${ref}`, target, format, { sheet });
      const { rows } = await duck.query(`SELECT count(*) AS c FROM ${ref}`);
      return Number(rows[0]?.c ?? 0);
    } finally {
      await duck.dropStaging(stagingDb, [stageTable]);
    }
  });

  return {
    success: true,
    message: `Updated ${path.basename(target)} — ${rowCount} row(s)`,
    rowCount,
    localPath: target,
    localDbPath: target,
    targetTableName: dbTableName,
  };
}

/**
 * A remote database source landing locally.
 *
 * The SELECT has to run on the source via its own plugin — DuckDB can't reach
 * a Postgres table — so rows are pulled and then written. Streamed in batches
 * where the connector supports it, so a large table isn't held whole.
 */
async function databaseToLocal({
  fullConfig,
  plugin,
  connectionId,
  sql,
  targetTableName,
  targetLocalPath = null,
  workflowId = null,
  nodeId = null,
}) {
  if (!targetTableName) throw new Error('Loading rows locally requires a target table name');
  const outPath = resolveTargetDb(targetLocalPath, { workflowId, nodeId });

  async function* rows() {
    if (typeof plugin.streamQuery === 'function') {
      for await (const batch of plugin.streamQuery(fullConfig, connectionId, { query: sql })) {
        for (const row of (Array.isArray(batch) ? batch : batch?.rows || [])) yield row;
      }
      return;
    }
    const result = await plugin.runQuery(fullConfig, connectionId, { query: sql, limit: 1000000 });
    if (result && result.success === false) throw new Error(result.message || 'Source query failed');
    for (const row of (result.rows || result.data || [])) yield row;
  }

  const { rowCount } = await duck.withWorkflowLock(
    workflowId,
    () => duck.ingestRowsToTable(rows(), workflowId, targetTableName),
  );

  return {
    success: true,
    message: `Loaded ${rowCount} row(s) into ${targetTableName}`,
    rowCount,
    localPath: outPath,
    localDbPath: outPath,
    targetTableName,
  };
}

module.exports = {
  createLocalTable,
  inPlaceLocalUpdate,
  databaseToLocal,
  resolveOutputPath,
  resolveTargetDb,
  stagingTableFor,
  describeResult,
  registerSource,
  isWorkflowDb,
};
