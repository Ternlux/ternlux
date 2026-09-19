/**
 * Vector Database Executor - Join Hooks
 *
 * Narrow helpers consumed by the standard join executor (handleExecuteJoin).
 * The skill is NOT the orchestrator — handleExecuteJoin still runs the join
 * end-to-end. It just calls into here when a source is a vector DB (to pull
 * rows) or when the destination is a vector DB (to embed and upsert).
 *
 * Two hooks:
 *   - fetchVectorSourceRecords: pull from vector source, flatten to rows
 *   - embedAndUpsertJoinedRows: embed a column on joined output, upsert
 */

const path = require('path');

const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

const isVectorConn = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType));

/**
 * A vector as a plain numeric array, or null when the value is not one.
 *
 * Normalise at the boundary, because a vector arrives in three shapes and only
 * the first survives an `Array.isArray` check downstream or a spread in
 * AI-written code:
 *
 *   - a plain array (Pinecone `values`, generated code)
 *   - a Float32Array (`Vector.toArray()`, embedding helpers)
 *   - an Apache Arrow `Vector` — what a LanceDB read actually yields. It is
 *     none of the above and is not even index-accessible (`v[0]` is
 *     undefined), so anything that reaches for a dimension sees nothing.
 */
function toPlainVector(value) {
  if (value == null || typeof value === 'string') return null;
  const v = (!Array.isArray(value) && !ArrayBuffer.isView(value) && typeof value.toArray === 'function')
    ? value.toArray()
    : value;
  if (Array.isArray(v)) return v.length > 0 ? v : null;
  // Every typed array iterates as numbers; a DataView does not, and would
  // flatten to an empty array that reads like a vector but is not one.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return v.length > 0 ? Array.from(v, Number) : null;
  }
  if (typeof v[Symbol.iterator] === 'function') {
    const arr = Array.from(v, Number);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

/**
 * Flatten a vector record into a row-shaped object. Metadata fields are
 * promoted to top-level keys. Pinecone records are normalised to look like
 * LanceDB ones so the join executor can treat them uniformly.
 *
 * Vector dimensions are dropped by default — they are not useful as join keys,
 * which is what this was written for. A caller doing a full READ of the source
 * (javascript-executor, whose function may pass the vector straight through to
 * a new vector table) asks for them back with `includeVector`.
 */
function flattenVectorRecord(record, { includeVector = false } = {}) {
  if (!record || typeof record !== 'object') return record;
  const flat = { id: record.id };
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    Object.assign(flat, record.metadata);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'metadata' || key === 'vector' || key === 'values' || key === '_distance') continue;
    if (flat[key] === undefined) flat[key] = value;
  }
  if (includeVector) {
    // Pinecone calls it `values`, LanceDB `vector`; callers only ever see the
    // latter, matching the field name every write path expects.
    const vector = toPlainVector(record.vector) || toPlainVector(record.values);
    if (vector) flat.vector = vector;
  }
  return flat;
}

/**
 * Pull rows from a vector source for the join executor.
 *
 * sourceConfig.vectorFetchOperation shape (provided by the AI):
 *   {
 *     useEmbeddingSearch: boolean,
 *     searchQuery: string | null,
 *     filter: string ("WHERE …" for LanceDB) | object (Pinecone metadata) | "" | {},
 *     topK: number (default 10000),
 *     embeddingProvider?, embeddingModel?  // only if useEmbeddingSearch=true
 *   }
 *
 * `includeVector` keeps each record's vector on the returned row (as a plain
 * numeric array). Off by default: a join has no use for the dimensions and
 * they would bloat every row it carries. A caller reading the source in full
 * — javascript-executor, whose function may hand the vector straight to a new
 * vector table — turns it on.
 */
async function fetchVectorSourceRecords({
  sourceConnection,
  sourceTableSchema,
  vectorFetchOperation,
  pluginManager,
  getFullConfig,
  helpers,
  includeVector = false
}) {
  const dbType = sourceConnection.dbType;
  const tableName = sourceTableSchema.tableName;
  const indexName = sourceTableSchema.indexName || sourceConnection.indexName;
  const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

  const op = vectorFetchOperation || {};
  const useEmbeddingSearch = op.useEmbeddingSearch === true;
  const searchQuery = op.searchQuery || null;
  const filter = op.filter !== undefined ? op.filter : (dbType === 'pinecone' ? {} : '');
  const topK = op.topK || 10000;

  // Embed the search text if requested.
  let queryVector = null;
  if (useEmbeddingSearch && searchQuery && op.embeddingProvider && op.embeddingModel) {
    // OpenAI is the only embedding provider; its key is stored under 'chatgpt'.
    // Anything else has no key to resolve and fails in generateEmbeddings,
    // naming the provider rather than silently embedding with the wrong one.
    const apiKey = op.embeddingProvider === 'openai'
      ? helpers?.apiKeys?.chatgpt
      : null;
    const embedded = await helpers.embeddings.generateEmbeddings({
      data: [{ query: searchQuery }],
      columnToEmbed: 'query',
      provider: op.embeddingProvider,
      model: op.embeddingModel,
      apiKey
    });
    queryVector = embedded[0]?.vector || null;
  }

  let vectors = [];

  if (dbType === 'lancedb') {
    const dbPath = sourceConnection.localPath || sourceConnection.dbConfig?.dbPath;
    if (!dbPath) throw new Error('LanceDB path not found in connection config');
    if (!helpers || !helpers.lancedb || typeof helpers.lancedb.getLanceDBConnection !== 'function') {
      throw new Error('fetchVectorSourceRecords requires helpers.lancedb.getLanceDBConnection (electron must inject helpers).');
    }
    const db = await helpers.lancedb.getLanceDBConnection({ dbPath });
    const table = await db.openTable(tableName);
    // @lancedb/lancedb 0.4.x: `table.search(...)` was removed. Build the
    // similarity query through `table.query().nearestTo(vector)` instead.
    let q = queryVector
      ? table.query().nearestTo(queryVector).limit(topK)
      : table.query().limit(topK);
    if (typeof filter === 'string' && filter.trim() !== '') q = q.where(filter);
    vectors = await q.toArray();
  } else {
    const fullConfig = await getFullConfig(sourceConnection.id);
    const connector = pluginManager.getConnector(dbType);
    if (!connector || !connector.queryVectors) {
      throw new Error(`${dbType} connector does not support queryVectors`);
    }
    const result = await connector.queryVectors(fullConfig, sourceConnection.id, {
      indexName,
      namespace,
      queryVector,
      filter: filter || {},
      topK,
      // Cloud stores only send the dimensions back when asked, so the flag has
      // to reach the query as well as the flattening below.
      includeValues: includeVector,
      includeMetadata: true
    });
    if (!result.success) throw new Error(`Failed to query vectors: ${result.message}`);
    vectors = result.rows || [];
  }

  return vectors.map((record) => flattenVectorRecord(record, { includeVector }));
}

/**
 * Embed a single column on the joined output and upsert into the vector
 * destination. The join executor calls this after running the JS join, in
 * place of a normal "INSERT INTO target".
 *
 * Required params:
 *   joinedRows         - array produced by the join function
 *   columnToEmbed      - field name to embed
 *   vectorDbType       - 'lancedb' | 'pinecone' | …
 *   targetTable        - table/index name
 *   embeddingProvider  - 'openai'
 *   embeddingModel     - provider-specific model id
 *
 * For cloud vector DBs (non-lancedb), also: targetConnectionId, indexName,
 * namespace.
 *
 * For LanceDB, also: targetLocalPath (defaults to userData/data/lancedb).
 */
async function embedAndUpsertJoinedRows({
  joinedRows,
  columnToEmbed,
  vectorDbType,
  targetTable,
  targetLocalPath,
  targetConnectionId,
  indexName,
  namespace = '',
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  pluginManager,
  getFullConfig,
  helpers
}) {
  if (!Array.isArray(joinedRows) || joinedRows.length === 0) {
    return { success: true, message: 'No rows to embed', recordCount: 0 };
  }
  if (!columnToEmbed) throw new Error('columnToEmbed is required');
  if (!embeddingProvider || !embeddingModel) {
    throw new Error('embeddingProvider and embeddingModel are required');
  }

  const apiKey = embeddingApiKey
    || (embeddingProvider === 'openai' ? helpers?.apiKeys?.chatgpt : null);
  if (!apiKey) {
    throw new Error(`No API key configured for embedding provider: ${embeddingProvider}`);
  }

  const embedded = await helpers.embeddings.generateEmbeddings({
    data: joinedRows,
    columnToEmbed,
    provider: embeddingProvider,
    model: embeddingModel,
    apiKey
  });

  const { generateId } = require('./lib/utils');

  if (vectorDbType === 'lancedb') {
    const dbPath = targetLocalPath || path.join(
      require('electron').app.getPath('userData'),
      'data',
      'lancedb'
    );
    const records = embedded.map((row) => {
      const rec = { id: row.id || generateId(), vector: row.vector };
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id' || k === 'vector') continue;
        if (typeof v === 'object' && v !== null) continue;
        rec[k] = (v === null || v === undefined) ? '' : v;
      }
      return rec;
    });
    await helpers.lancedb.executeLanceDBOperation({
      operation: 'upsert',
      data: records,
      // A vector-destination join is always a fresh new_table write — overwrite
      // so re-runs don't duplicate rows or fail on cross-run schema drift.
      config: { dbPath, tableName: targetTable, overwrite: true }
    });
    return {
      success: true,
      message: `Embedded ${records.length} rows and upserted into LanceDB table "${targetTable}"`,
      recordCount: records.length,
      targetLocalPath: dbPath
    };
  }

  // Cloud vector DBs
  if (!targetConnectionId) {
    throw new Error(`${vectorDbType} requires a target connection ID`);
  }
  const fullConfig = await getFullConfig(targetConnectionId);
  const connector = pluginManager.getConnector(vectorDbType);
  if (!connector || typeof connector.executeVectorOperation !== 'function') {
    throw new Error(`${vectorDbType} connector does not support executeVectorOperation`);
  }

  const vectorData = embedded.map((row) => {
    const meta = { ...row };
    delete meta.vector;
    return {
      id: row.id || generateId(),
      vector: row.vector,
      metadata: meta
    };
  });

  const result = await connector.executeVectorOperation(fullConfig, targetConnectionId, {
    operation: 'upsert',
    indexName: indexName || targetTable,
    namespace: namespace || '',
    data: vectorData
  });

  if (!result.success) throw new Error(`Vector upsert failed: ${result.message}`);

  return {
    success: true,
    message: `Embedded ${vectorData.length} rows and upserted into ${vectorDbType} index "${indexName || targetTable}"`,
    recordCount: vectorData.length
  };
}

module.exports = {
  isVectorConn,
  flattenVectorRecord,
  fetchVectorSourceRecords,
  embedAndUpsertJoinedRows
};
