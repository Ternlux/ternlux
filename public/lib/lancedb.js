/**
 * LanceDB integration for local vector database operations
 */

const lancedb = require('@lancedb/lancedb');
const arrow = require('apache-arrow');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Get LanceDB database path
 * @param {String} customPath - Optional custom path
 * @returns {String} Database path
 */
function getLanceDBPath(customPath) {
  if (customPath && !isInvalidLanceDir(customPath)) {
    return customPath;
  }

  const dbPath = path.join(app.getPath('userData'), 'data', 'lancedb');

  // Ensure directory exists
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  return dbPath;
}

/**
 * LanceDB needs a *directory*. A NeDB/SQLite file path (e.g. *.db) or any
 * existing regular file would make LanceDB try to create a table inside a file
 * ("Unable to walk dir: ... Not a directory"). Detect those so callers can fall
 * back to the default LanceDB directory instead of crashing — this guards
 * against stored node configs whose targetLocalPath still points at a source
 * NeDB file.
 */
function isInvalidLanceDir(customPath) {
  if (/\.(db|sqlite|nedb)$/i.test(customPath)) return true;
  try {
    return fs.existsSync(customPath) && fs.statSync(customPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Get or create LanceDB connection
 * @param {Object} config - Configuration object
 * @param {String} config.dbPath - Optional custom database path
 * @returns {Promise<Object>} LanceDB connection
 */
async function getLanceDBConnection(config = {}) {
  const dbPath = getLanceDBPath(config.dbPath);
  const db = await lancedb.connect(dbPath);
  return db;
}

/**
 * Execute LanceDB operation
 * @param {Object} params - Parameters
 * @param {String} params.operation - 'upsert', 'query', 'delete', or 'update'
 * @param {Array} params.data - Data to upsert (for upsert operation)
 * @param {Object} params.config - LanceDB configuration
 * @param {String} params.config.tableName - Table name
 * @param {String} params.config.dbPath - Optional custom database path
 * @param {Array} params.config.queryVector - Query vector (for query operation)
 * @param {Number} params.config.limit - Result limit (for query operation)
 * @param {String} params.config.filter - Filter expression (for delete/update)
 * @param {Array} params.config.updates - Update data (for update operation)
 * @returns {Promise<Object>} Operation result
 */
async function executeLanceDBOperation({ operation, data, config }) {
  const db = await getLanceDBConnection(config);
  const tableName = config.tableName || 'vectors';
  console.log('operation, data, config : ', db, operation, data, config )
  try {
    switch (operation) {
      case 'upsert':
        return await upsertVectors(db, tableName, data, { overwrite: config.overwrite === true });

      case 'query':
        return await queryVectors(db, tableName, config);

      case 'delete':
        return await deleteVectors(db, tableName, config);

      case 'update':
        return await updateVectors(db, tableName, config);

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  } catch (error) {
    throw new Error(`LanceDB operation failed: ${error.message}`);
  }
}

/**
 * Upsert vectors to LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Array} data - Array of vector records with { id, vector, ...metadata }
 * @returns {Promise<Object>} Result
 */
async function upsertVectors(db, tableName, data, opts = {}) {
  if (!data || data.length === 0) {
    throw new Error('No data provided for upsert');
  }

  // Validate that all records have vectors
  for (const record of data) {
    if (!record.vector || !Array.isArray(record.vector)) {
      throw new Error(`Invalid vector in record: ${JSON.stringify(record)}`);
    }
  }

  // Overwrite: drop any existing table first so a "new_table" write is fully
  // idempotent. Without this, re-runs APPEND — which both duplicates rows and
  // can fail when the freshly-inferred batch schema differs from the existing
  // table's (e.g. similar_1_id was Utf8 last run because of gaps, but is Float64
  // this run because every row matched → "Append with different schema").
  if (opts.overwrite) {
    try {
      const names = await db.tableNames();
      if (Array.isArray(names) && names.includes(tableName)) {
        await db.dropTable(tableName);
        console.log(`Dropped existing LanceDB table ${tableName} (overwrite)`);
      }
    } catch (dropErr) {
      console.warn(`Could not drop table ${tableName} for overwrite: ${dropErr.message}`);
    }
  }

  // Normalize so every column has ONE consistent Arrow type across ALL records.
  // The AI-generated join can emit columns that are numeric for some rows and
  // missing/empty for others (e.g. similar_3_id is a number when a match exists
  // and '' when it doesn't). Arrow rejects such mixed columns ("Unable to infer
  // Vector type") and also can't infer an all-missing column. Resolving the type
  // from the WHOLE batch (not just data[0]) and coercing accordingly fixes both.
  const { records, schema } = normalizeRecordsForArrow(data);

  let table;
  let isNewTable = false;

  try {
    // Try to open existing table
    table = await db.openTable(tableName);
    console.log(`Opened existing LanceDB table: ${tableName}`);
  } catch (err) {
    // Table doesn't exist, create it with explicit schema to avoid dictionary encoding
    console.log(`Creating new LanceDB table: ${tableName} with explicit schema`);

    try {
      // Try to create table with schema (v0.4.0+ API)
      table = await db.createTable(tableName, records, { schema });
      isNewTable = true;
    } catch (schemaErr) {
      // Fallback: create without explicit schema if schema API not supported.
      // The normalized records are already type-consistent, so plain inference
      // works here too.
      console.warn('Could not create table with explicit schema, falling back to default:', schemaErr.message);
      table = await db.createTable(tableName, records);
      isNewTable = true;
    }
  }

  if (!isNewTable) {
    // Add new vectors to existing table
    await table.add(records);
    console.log(`Added ${records.length} vectors to existing table ${tableName}`);
  }

  return {
    success: true,
    data: records,
    recordCount: records.length,
    message: isNewTable
      ? `Created new table '${tableName}' with ${records.length} vectors`
      : `Added ${records.length} vectors to table '${tableName}'`
  };
}

/**
 * Normalize a batch of vector records into Arrow-safe rows + an explicit schema.
 *
 * Resolves ONE column type from the whole batch (not a single sample row), then
 * coerces every row to it so a column is never a mix of e.g. numbers and empty
 * strings — the case that makes Arrow throw "Unable to infer Vector type from
 * input values". Empty string / null / undefined are all treated as "missing".
 *
 * Type resolution per column:
 *   - any string value present      → Utf8   (missing → '')
 *   - else any number present       → Float64 (missing → null)
 *   - else any boolean present      → Bool    (missing → null)
 *   - all values missing            → Utf8   (all '')  — keeps the column writable
 * The `vector` column stays a non-nullable FixedSizeList<Float32>.
 *
 * @param {Array<Object>} data - records with { id, vector, ...scalars }
 * @returns {{ records: Array<Object>, schema: arrow.Schema }}
 */
function normalizeRecordsForArrow(data) {
  const isMissing = (v) => v === null || v === undefined || v === '';
  const total = data.length;

  // 1. Walk the WHOLE batch to record every column in first-seen order and, per
  //    scalar column, the concrete types seen + how many rows actually have a
  //    value. Preserving column ORDER matters: LanceDB's table.add() requires an
  //    appended batch's fields to be in the SAME order as the existing table, so
  //    we must NOT reorder (e.g. hoisting `vector` to the front breaks append).
  const order = [];                 // all column keys (incl. 'vector') in first-seen order
  const seen = new Set();
  const typesSeen = new Map();       // scalar key -> Set<'number'|'boolean'|'string'>
  const presentCount = new Map();    // scalar key -> # rows with a non-missing value
  let vectorKey = null;
  let vectorLen = 0;
  for (const rec of data) {
    if (!rec) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
      if (k === 'vector' && Array.isArray(v)) { vectorKey = 'vector'; vectorLen = v.length; continue; }
      if (typeof v === 'object' && v !== null) continue; // skip nested (should already be flattened)
      if (!typesSeen.has(k)) { typesSeen.set(k, new Set()); presentCount.set(k, 0); }
      if (isMissing(v)) continue;
      typesSeen.get(k).add(typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
      presentCount.set(k, presentCount.get(k) + 1);
    }
  }

  // 2. Resolve ONE type per scalar column. A column keeps a numeric/boolean type
  //    ONLY when it is fully populated (every row has a value) and that type is
  //    unambiguous — otherwise it becomes Utf8 with '' for the gaps. This is
  //    deliberate: LanceDB rejects nulls in a column it derives as non-nullable
  //    ("declared as non-nullable but contains null values"), so we emit NO
  //    nulls at all — missing cells are empty strings in a string column.
  const colType = new Map();
  for (const k of typesSeen.keys()) {
    const set = typesSeen.get(k);
    const full = presentCount.get(k) === total;
    colType.set(k, (full && set.size === 1) ? [...set][0] : 'string');
  }

  // Emit columns in their original order; drop skipped nested-object keys.
  const cols = order.filter((k) => k === vectorKey || colType.has(k));

  // 3. Coerce every record to the resolved per-column type, filling missing keys.
  //    number/boolean columns are fully populated by construction, so they never
  //    receive a missing value; string columns turn missing into '' (never null).
  const coerce = (v, t) => {
    if (t === 'number') { const n = typeof v === 'number' ? v : Number(v); return Number.isNaN(n) ? 0 : n; }
    if (t === 'boolean') return typeof v === 'boolean' ? v : Boolean(v);
    return isMissing(v) ? '' : (typeof v === 'string' ? v : String(v));
  };
  const records = data.map((rec) => {
    const out = {};
    for (const k of cols) {
      out[k] = (k === vectorKey) ? (rec ? rec[k] : undefined) : coerce(rec ? rec[k] : undefined, colType.get(k));
    }
    return out;
  });

  // 4. Build the explicit Arrow schema from the resolved types, same order.
  //    Explicit Utf8 (not Dictionary) avoids LanceDB IPC/dictionary-encoding issues.
  const fields = cols.map((k) => {
    if (k === vectorKey) {
      return new arrow.Field(
        k,
        new arrow.FixedSizeList(vectorLen, new arrow.Field('item', new arrow.Float32())),
        false,
      );
    }
    const t = colType.get(k);
    const type = t === 'number' ? new arrow.Float64()
      : t === 'boolean' ? new arrow.Bool()
      : new arrow.Utf8();
    return new arrow.Field(k, type, true);
  });
  return { records, schema: new arrow.Schema(fields) };
}

/**
 * Build explicit Arrow schema for LanceDB table
 * This prevents dictionary encoding issues by using plain utf8 strings
 * @param {Object} sampleRecord - Sample record to infer schema from
 * @returns {arrow.Schema} Arrow schema
 */
function buildLanceDBSchema(sampleRecord) {
  const fields = [];

  for (const [key, value] of Object.entries(sampleRecord)) {
    if (key === 'vector' && Array.isArray(value)) {
      // Vector field: use FixedSizeList of Float32
      fields.push(
        new arrow.Field(
          key,
          new arrow.FixedSizeList(value.length, new arrow.Field('item', new arrow.Float32())),
          false // not nullable
        )
      );
    } else if (typeof value === 'string') {
      // String field: use Utf8 (NOT Dictionary) to avoid IPC errors
      fields.push(new arrow.Field(key, new arrow.Utf8(), true));
    } else if (typeof value === 'number') {
      // Number field: use Float64 for safety
      fields.push(new arrow.Field(key, new arrow.Float64(), true));
    } else if (typeof value === 'boolean') {
      // Boolean field
      fields.push(new arrow.Field(key, new arrow.Bool(), true));
    } else if (typeof value === 'object' && value !== null) {
      // Skip objects/arrays - they should have been flattened before reaching schema builder
      console.warn(`Skipping object field '${key}' in schema - objects should be flattened`);
      continue;
    } else {
      // Null, undefined, or other types: default to Utf8 string
      fields.push(new arrow.Field(key, new arrow.Utf8(), true));
    }
  }

  return new arrow.Schema(fields);
}

/**
 * Query similar vectors from LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Query configuration
 * @param {Array} config.queryVector - Query vector
 * @param {Number} config.limit - Result limit (default: 10)
 * @param {String} config.filter - Optional filter expression
 * @returns {Promise<Object>} Query results
 */
async function queryVectors(db, tableName, config) {
  const { queryVector, limit = 10, filter } = config;

  if (!queryVector || !Array.isArray(queryVector)) {
    throw new Error('Query vector is required for similarity search');
  }

  try {
    const table = await db.openTable(tableName);

    // @lancedb/lancedb 0.4.x removed `table.search(...)` and `query.execute()`.
    // Use `query().nearestTo(vector)` and `toArray()` per the current API.
    let query = table.query().nearestTo(queryVector).limit(limit);

    if (typeof filter === 'string' && filter.trim() !== '') {
      query = query.where(filter);
    } else if (filter && typeof filter === 'object' && Object.keys(filter).length > 0) {
      // Metadata-object filter (Pinecone-style) isn't supported by LanceDB —
      // surface a clear error rather than silently ignoring it.
      throw new Error('LanceDB filter must be a SQL WHERE string, not an object');
    }

    const results = await query.toArray();

    return {
      success: true,
      data: results,
      recordCount: results.length,
      message: `Found ${results.length} similar vectors`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`,
        data: [],
        recordCount: 0
      };
    }
    throw error;
  }
}

/**
 * Delete vectors from LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Delete configuration
 * @param {String} config.filter - Filter expression (e.g., "id = '123'")
 * @returns {Promise<Object>} Delete result
 */
async function deleteVectors(db, tableName, config) {
  const { filter } = config;

  if (!filter) {
    throw new Error('Filter is required for delete operation');
  }

  try {
    const table = await db.openTable(tableName);

    await table.delete(filter);

    return {
      success: true,
      message: `Deleted vectors matching filter from table '${tableName}'`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`
      };
    }
    throw error;
  }
}

/**
 * Update vectors in LanceDB table
 * Note: LanceDB doesn't have direct update, so we delete and re-add
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Update configuration
 * @param {String} config.filter - Filter to identify records to update
 * @param {Array} config.updates - Updated records with new data
 * @returns {Promise<Object>} Update result
 */
async function updateVectors(db, tableName, config) {
  const { filter, updates } = config;

  if (!filter) {
    throw new Error('Filter is required for update operation');
  }

  if (!updates || updates.length === 0) {
    throw new Error('No update data provided');
  }

  try {
    const table = await db.openTable(tableName);

    // Delete old records
    await table.delete(filter);

    // Add updated records
    await table.add(updates);

    return {
      success: true,
      recordCount: updates.length,
      message: `Updated ${updates.length} vectors in table '${tableName}'`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`
      };
    }
    throw error;
  }
}

/**
 * List all tables in LanceDB
 * @param {Object} config - Configuration
 * @returns {Promise<Array<String>>} Array of table names
 */
async function listTables(config = {}) {
  const db = await getLanceDBConnection(config);
  const tables = await db.tableNames();
  return tables;
}

/**
 * Get table info
 * @param {String} tableName - Table name
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Table information
 */
async function getTableInfo(tableName, config = {}) {
  const db = await getLanceDBConnection(config);

  try {
    const table = await db.openTable(tableName);
    const count = await table.countRows();

    return {
      success: true,
      tableName,
      recordCount: count
    };
  } catch (error) {
    return {
      success: false,
      message: `Table '${tableName}' not found`
    };
  }
}

/**
 * Drop table
 * @param {String} tableName - Table name
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Result
 */
async function dropTable(tableName, config = {}) {
  const db = await getLanceDBConnection(config);

  try {
    await db.dropTable(tableName);
    return {
      success: true,
      message: `Table '${tableName}' dropped successfully`
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to drop table '${tableName}': ${error.message}`
    };
  }
}

/**
 * Single-entry runQuery wrapper used by buildSkillHelpers / ctx.runQuery.
 * Dispatches to the existing executeLanceDBOperation switch.
 *
 * query shape: {
 *   operation: 'query' | 'queryVectors' | 'upsert' | 'delete' | 'update' | 'list',
 *   tableName?, table?,
 *   data?,                           // upsert
 *   queryVector?, limit?, topK?,     // query
 *   filter?,                         // query/delete/update
 *   updates?                         // update
 * }
 *
 * 'list' is a convenience for "give me everything (or filtered) up to limit".
 * 'queryVectors' is a synonym for 'query' so the AI's mental model lines up
 * with the connector-side API used by Pinecone.
 */
async function runQuery({ dbPath, ...query } = {}) {
  const op = (query.operation || 'list').toLowerCase();
  const tableName = query.tableName || query.table;
  const config = { dbPath, tableName };

  if (op === 'upsert') {
    return executeLanceDBOperation({ operation: 'upsert', data: query.data, config });
  }

  if (op === 'query' || op === 'queryvectors') {
    const limit = query.topK || query.limit || 10;
    const result = await executeLanceDBOperation({
      operation: 'query',
      config: { ...config, queryVector: query.queryVector, limit, filter: query.filter }
    });
    return result.data || [];
  }

  if (op === 'delete') {
    return executeLanceDBOperation({
      operation: 'delete',
      config: { ...config, filter: query.filter }
    });
  }

  if (op === 'update') {
    return executeLanceDBOperation({
      operation: 'update',
      config: { ...config, filter: query.filter, updates: query.updates }
    });
  }

  // 'list': open the table, optionally apply a where-filter, return rows up
  // to limit. No query vector → LanceDB returns rows in insertion order.
  if (op === 'list') {
    const db = await getLanceDBConnection(config);
    const table = await db.openTable(tableName);
    let q = table.query().limit(query.limit || 1000);
    if (typeof query.filter === 'string' && query.filter.trim() !== '') q = q.where(query.filter);
    return await q.toArray();
  }

  throw new Error(`Unknown LanceDB operation: ${op}`);
}

/** getTables({ dbPath }) — lists all tables in the LanceDB database. */
async function getTables({ dbPath } = {}) {
  return listTables({ dbPath });
}

/** getColumns({ dbPath, table }) — infer columns from one sample row. */
async function getColumns({ dbPath, table } = {}) {
  if (!table) return [];
  const db = await getLanceDBConnection({ dbPath });
  const t = await db.openTable(table);
  const sample = await t.query().limit(1).toArray();
  if (!sample.length) return [];
  return Object.entries(sample[0]).map(([name, value]) => ({
    name,
    type: Array.isArray(value)
      ? 'vector'
      : (typeof value === 'object' && value !== null ? 'object' : typeof value)
  }));
}

module.exports = {
  getLanceDBConnection,
  executeLanceDBOperation,
  listTables,
  getTableInfo,
  dropTable,
  runQuery,
  getTables,
  getColumns
};
