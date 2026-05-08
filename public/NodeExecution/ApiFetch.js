/**
 * ApiFetch — execute a REST API fetch function authored on a DataSource node.
 *
 * The renderer never sees decrypted secrets. It hands us:
 *   - apiConnectionId / apiConnectionConfig (public parts of the connection).
 *   - apiFetchCode — a JavaScript async function expression string produced
 *     by the AI. It may contain `{{PLACEHOLDER}}` tokens from a fixed
 *     vocabulary, placed inside string literals or template literals.
 *   - nedbCollection + operationMode (where to write the rows).
 *
 * We merge the public config with keychain-decrypted credentials via the
 * injected `getFullConfig(connectionId, baseConfig)` (same helper Postgres /
 * Slack use in the main process). We substitute placeholders into the code
 * string, evaluate the function, and invoke it with a configured `axios` so
 * it can perform any looping / pagination logic the user described. The
 * function returns an array of rows which we then write into NeDB via
 * saveToLocalNeDB.
 */

const axios = require('axios');
const { saveToLocalNeDB } = require('../transfomers/NeDB');

// Wired by initialize() from electron.js main.
let getFullConfig = null;

function initialize(configGetter) {
  getFullConfig = configGetter;
}

// ── Placeholder substitution ────────────────────────────────────────────────

/**
 * Build the placeholder map for the resolved connection config.
 * Called only after `getFullConfig` has merged in the decrypted secrets.
 */
function buildPlaceholderMap(fullConfig) {
  const authType = fullConfig.authType || 'none';

  let authHeaderName = '';
  let authHeaderValue = '';

  if (authType === 'bearer' && fullConfig.bearerToken) {
    authHeaderName = 'Authorization';
    authHeaderValue = `Bearer ${fullConfig.bearerToken}`;
  } else if (authType === 'apiKey' && fullConfig.apiKeyValue) {
    authHeaderName = (fullConfig.apiKeyName && String(fullConfig.apiKeyName).trim()) || 'X-API-Key';
    authHeaderValue = String(fullConfig.apiKeyValue);
  } else if (authType === 'basic' && (fullConfig.basicUser || fullConfig.basicPassword)) {
    authHeaderName = 'Authorization';
    const encoded = Buffer
      .from(`${fullConfig.basicUser || ''}:${fullConfig.basicPassword || ''}`)
      .toString('base64');
    authHeaderValue = `Basic ${encoded}`;
  }

  return {
    BASE_URL: fullConfig.baseUrl ? String(fullConfig.baseUrl) : '',
    AUTH_HEADER_NAME: authHeaderName,
    AUTH_HEADER_VALUE: authHeaderValue,
    BEARER_TOKEN: fullConfig.bearerToken || '',
    API_KEY_VALUE: fullConfig.apiKeyValue || '',
    BASIC_USERNAME: fullConfig.basicUser || '',
    BASIC_PASSWORD: fullConfig.basicPassword || '',
  };
}

// Escape a value so that when inserted in place of {{PLACEHOLDER}} inside a
// single-quoted, double-quoted, or template JS string the resulting source
// stays valid. The prompt requires placeholders to only appear inside string
// contexts, so this escape suffices.
function escapeForJsString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function substituteCode(code, map) {
  if (typeof code !== 'string') return '';
  return code.replace(/\{\{([A-Z_]+)\}\}/g, (_full, name) =>
    Object.prototype.hasOwnProperty.call(map, name)
      ? escapeForJsString(map[name])
      : ''
  );
}

// ── Main runner ─────────────────────────────────────────────────────────────

/**
 * Execute the AI-authored fetch function and persist rows into NeDB.
 *
 * @param {Object} params
 * @param {string} params.apiConnectionId
 * @param {Object} params.apiConnectionConfig - public config from the NeDB connection doc
 * @param {string} params.apiFetchCode - async function expression (with placeholders)
 * @param {string} params.nedbCollection - target collection name
 * @param {string} [params.operationMode='new_table'] - 'new_table' replaces, 'append' adds
 *
 * @returns {Promise<{success:boolean, rowCount?:number, collection?:string,
 *                    localPath?:string, sampleRow?:object, error?:string}>}
 */
async function handleExecuteApiFetch({
  apiConnectionId,
  apiConnectionConfig = {},
  apiFetchCode,
  nedbCollection,
  operationMode = 'new_table',
}) {
  try {
    if (!getFullConfig) {
      return { success: false, error: 'ApiFetch not initialized (getFullConfig missing)' };
    }
    if (!apiFetchCode || typeof apiFetchCode !== 'string') {
      return { success: false, error: 'Missing apiFetchCode' };
    }
    if (!nedbCollection || typeof nedbCollection !== 'string') {
      return { success: false, error: 'Missing nedbCollection' };
    }

    // 1. Merge public config with decrypted secrets (main-process only).
    const fullConfig = await getFullConfig(apiConnectionId, apiConnectionConfig);

    // 2. Substitute the parameterised placeholders (base URL, auth header,
    //    API keys, etc.) with the actual decrypted values before evaluating
    //    the code.
    const map = buildPlaceholderMap(fullConfig);
    const resolvedCode = substituteCode(apiFetchCode, map);

    // 3. Turn the resolved source into a callable function. Wrapping in
    //    parentheses converts a function declaration into a function
    //    expression, so the AI may return either form.
    let fetchFn;
    try {
      const factory = new Function(`return (${resolvedCode});`);
      fetchFn = factory();
    } catch (err) {
      return { success: false, error: `Failed to load fetch function: ${err.message}` };
    }
    if (typeof fetchFn !== 'function') {
      return { success: false, error: 'apiFetchCode did not resolve to a function' };
    }
    console.log('fetchFn: ', String(fetchFn))
    // 4. Invoke it with axios. The function is responsible for any looping /
    //    pagination and returns either an array of rows or a single object.
    let rawResult;
    try {
      rawResult = await fetchFn({ axios });
    } catch (err) {
      return { success: false, error: `Fetch function threw: ${err.message}` };
    }

    const rows = normaliseRows(rawResult);

    if (rows.length === 0) {
      // Persist an empty collection so downstream nodes see a defined source.
      const emptyResult = await saveToLocalNeDB(nedbCollection, [], operationMode, 0);
      return {
        success: !!emptyResult.success,
        rowCount: 0,
        collection: nedbCollection,
        localPath: emptyResult.localPath,
        sampleRow: null,
        message: emptyResult.message || 'No rows returned by the API.',
      };
    }

    const saved = await saveToLocalNeDB(
      nedbCollection,
      rows,
      operationMode,
      rows.length
    );
    if (!saved.success) {
      return { success: false, error: saved.message || 'Failed to write rows to NeDB' };
    }

    return {
      success: true,
      rowCount: saved.documentsInserted || rows.length,
      collection: nedbCollection,
      localPath: saved.localPath,
      sampleRow: stripNeDBInternals(rows[0]),
    };
  } catch (err) {
    console.error('[handleExecuteApiFetch] error:', err);
    return { success: false, error: err.message || 'API fetch failed' };
  }
}

function normaliseRows(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'object') return [value];
  return [{ value }];
}

function stripNeDBInternals(row) {
  if (!row || typeof row !== 'object') return row;
  const { _id, ...rest } = row;
  return rest;
}

module.exports = {
  initialize,
  handleExecuteApiFetch,
};
