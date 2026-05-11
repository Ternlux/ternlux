/**
 * Sandbox utilities exposed to AI-generated transformation functions.
 *
 * Every helper is a thin wrapper around the bundle electron.js injects via
 * `params.helpers` — the skill imports nothing outside this directory.
 *
 * The generated function signature is:
 *   async function transform(records, ctx) { ... return outputRecords; }
 *
 * `ctx` exposes single-call async helpers so the AI's code stays small.
 */

/**
 * Build the `ctx` helper object for the generated transform function.
 * @param {Object} helpers - The helpers bundle injected by skills:execute.
 */
function buildContext(helpers) {
  if (!helpers) throw new Error('helpers bundle is required');

  return {
    connections: (helpers.connections || []).map((c) => ({
      id: c.id || c._id,
      name: c.name,
      dbType: c.dbType,
      dbCategory: c.dbCategory
    })),
    aiProviders: helpers.aiProviders || [],
    embeddingProviders: helpers.embeddingProviders || [],

    // Unified connection / file access. `connection` is either the saved
    // connection's name/id or a local dbType ('nedb' | 'sqlite' | 'lancedb');
    // when `dbPath` is provided the call routes to the local lib.
    runQuery:    (connection, query, dbPath = null)             => helpers.runQuery(connection, query, dbPath),
    getTables:   (connection, dbPath = null)                    => helpers.getTables(connection, dbPath),
    getColumns:  (connection, table, schema = null, dbPath = null) => helpers.getColumns(connection, table, schema, dbPath),

    // Model calls.
    askAi:       (prompt, opts = {})         => helpers.callAI(prompt, opts),
    vectorize:   (texts, opts = {})          => helpers.vectorize(texts, opts),

    // Misc.
    axios: helpers.axios,
    log: (...args) => console.log('[js-skill]', ...args)
  };
}

module.exports = { buildContext };
