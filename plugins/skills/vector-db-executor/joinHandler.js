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
 * Flatten a vector record into a row-shaped object. Metadata fields are
 * promoted to top-level keys; vector dimensions are dropped (not useful as
 * join keys). Pinecone records are normalised to look like LanceDB ones so
 * the join executor can treat them uniformly.
 */
function flattenVectorRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const flat = { id: record.id };
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    Object.assign(flat, record.metadata);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'metadata' || key === 'vector' || key === 'values' || key === '_distance') continue;
    if (flat[key] === undefined) flat[key] = value;
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
 */
async function fetchVectorSourceRecords({
  sourceConnection,
  sourceTableSchema,
  vectorFetchOperation,
  pluginManager,
  getFullConfig,
  helpers
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
    const apiKey = op.embeddingProvider === 'openai'
      ? helpers?.apiKeys?.chatgpt
      : helpers?.apiKeys?.huggingface;
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
      includeValues: false,
      includeMetadata: true
    });
    if (!result.success) throw new Error(`Failed to query vectors: ${result.message}`);
    vectors = result.rows || [];
  }

  return vectors.map(flattenVectorRecord);
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
 *   embeddingProvider  - 'openai' | 'huggingface'
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
    || (embeddingProvider === 'openai' ? helpers?.apiKeys?.chatgpt : helpers?.apiKeys?.huggingface);
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
