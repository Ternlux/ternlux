/**
 * REST API Connector Plugin for Ternlux
 *
 * Two-stage design:
 *   - This plugin carries only the connection-level auth (baseUrl + credentials).
 *     Credentials marked `sensitive: true` are split off by ConnectionsTab and
 *     encrypted via Electron `safeStorage`.
 *   - The actual fetch plan (method/url/headers/body/responsePath) is authored
 *     per-usage on the DataSource node and executed by
 *     public/NodeExecution/ApiFetch.js, which substitutes placeholder tokens
 *     with decrypted credentials in the main process.
 *
 * The required connector methods (testConnection / getTables / getColumns /
 * runQuery) are implemented but kept intentionally minimal — the real
 * execution path is ApiFetch.js.
 */

const axios = require('axios');

// ── Auth helpers ────────────────────────────────────────────────────────────

function buildAuthHeader(config) {
  const authType = config && config.authType;
  if (authType === 'bearer' && config.bearerToken) {
    return { name: 'Authorization', value: `Bearer ${config.bearerToken}` };
  }
  if (authType === 'apiKey' && config.apiKeyValue) {
    const name = (config.apiKeyName && String(config.apiKeyName).trim()) || 'X-API-Key';
    return { name, value: String(config.apiKeyValue) };
  }
  if (authType === 'basic' && (config.basicUser || config.basicPassword)) {
    const encoded = Buffer
      .from(`${config.basicUser || ''}:${config.basicPassword || ''}`)
      .toString('base64');
    return { name: 'Authorization', value: `Basic ${encoded}` };
  }
  return null;
}

function headersFromConfig(config, extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const auth = buildAuthHeader(config);
  if (auth) headers[auth.name] = auth.value;
  return headers;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

module.exports = {
  type: 'connector',
  id: 'rest-api',
  name: 'REST API',
  icon: './icon.svg',
  dbCategory: 'API',
  authType: 'custom',

  /**
   * Ping the configured base URL with the resolved auth header.
   * If no base URL is set we can't meaningfully test — report success with a
   * note and defer validation to the first fetch.
   */
  async testConnection(config /*, connectionId */) {
    try {
      const baseUrl = config && config.baseUrl && String(config.baseUrl).trim();
      if (!baseUrl) {
        return {
          success: true,
          message: 'No base URL configured — auth will be validated on first fetch.',
        };
      }
      const headers = headersFromConfig(config);
      const res = await axios.get(baseUrl, {
        headers,
        timeout: 10_000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 400) {
        return { success: true, message: `HTTP ${res.status}` };
      }
      return {
        success: false,
        message: `Base URL responded with HTTP ${res.status}. Check the URL and auth.`,
      };
    } catch (err) {
      return { success: false, message: err.message || 'Connection failed' };
    }
  },

  /**
   * Synthetic single "table" representing an API response. The real
   * table/collection is materialised into NeDB at DataSource node use time.
   */
  async getTables(/* config, connectionId */) {
    return {
      success: true,
      tables: [{ name: 'response', schema: null, type: 'virtual' }],
    };
  },

  /**
   * Columns are unknown until a request is authored. Return empty; the chat
   * flow infers them from the materialised NeDB collection.
   */
  async getColumns(/* config, connectionId, schema, table */) {
    return { success: true, columns: [] };
  },

  /**
   * Ad-hoc runner used when the caller passes a structured plan object as
   * `query`. Not exercised by the normal DataSource flow (ApiFetch.js owns
   * that), but keeping it wired means `dbconn:run-query` works for testing.
   *
   * Expected `query` shape: { method, url, headers, body, responsePath, timeoutMs }
   * All placeholder substitution MUST happen before this is called (the caller
   * is main-process code that has already resolved secrets). This function
   * never receives or decrypts credentials itself.
   */
  async runQuery(config, connectionId, query) {
    try {
      if (!query || typeof query !== 'object' || !query.url) {
        return {
          success: false,
          message: 'runQuery requires an object query with at least { url }',
        };
      }
      const method = (query.method || 'GET').toUpperCase();
      const headers = { ...(query.headers || {}) };
      // Strip empty headers (substitution may leave {{AUTH_*}} as '' when
      // authType='none' — the main-process substitutor cleans those, but we
      // defensively repeat the filter here).
      for (const k of Object.keys(headers)) {
        if (!k || headers[k] === '' || headers[k] == null) delete headers[k];
      }
      const axiosCfg = {
        method,
        url: query.url,
        headers,
        timeout: Number(query.timeoutMs) || 30_000,
        validateStatus: () => true,
      };
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && query.body != null) {
        axiosCfg.data = query.body;
      }
      const res = await axios(axiosCfg);
      if (res.status < 200 || res.status >= 400) {
        return {
          success: false,
          message: `HTTP ${res.status}: ${typeof res.data === 'string' ? res.data.slice(0, 200) : ''}`,
          status: res.status,
        };
      }
      const rows = extractRows(res.data, query.responsePath);
      const columns = inferColumns(rows[0] || {});
      return {
        success: true,
        rows,
        columns,
        rowCount: rows.length,
      };
    } catch (err) {
      return { success: false, message: err.message || 'Request failed' };
    }
  },

  configSchema: {
    fields: [
      {
        name: 'baseUrl',
        type: 'string',
        label: 'Base URL',
        placeholder: 'https://api.example.com/v1',
        required: false,
        sensitive: false,
        helpText: 'Optional. Endpoints authored on the DataSource node can reference this as {{BASE_URL}}.',
      },
      {
        name: 'authType',
        type: 'select',
        label: 'Authentication',
        required: true,
        sensitive: false,
        default: 'none',
        options: [
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'apiKey', label: 'API Key (header)' },
          { value: 'basic', label: 'Basic Auth' },
        ],
        helpText: 'Selects which credential fields below are used.',
      },
      // bearer
      {
        name: 'bearerToken',
        type: 'password',
        label: 'Bearer Token',
        required: false,
        sensitive: true,
        helpText: 'Stored encrypted via safeStorage. Never leaves the main process after save.',
        visibleWhen: { authType: 'bearer' },
      },
      // apiKey
      {
        name: 'apiKeyName',
        type: 'string',
        label: 'API Key Header Name',
        placeholder: 'X-API-Key',
        required: false,
        sensitive: false,
        visibleWhen: { authType: 'apiKey' },
      },
      {
        name: 'apiKeyValue',
        type: 'password',
        label: 'API Key Value',
        required: false,
        sensitive: true,
        helpText: 'Stored encrypted via safeStorage.',
        visibleWhen: { authType: 'apiKey' },
      },
      // basic
      {
        name: 'basicUser',
        type: 'string',
        label: 'Basic Auth Username',
        required: false,
        sensitive: false,
        visibleWhen: { authType: 'basic' },
      },
      {
        name: 'basicPassword',
        type: 'password',
        label: 'Basic Auth Password',
        required: false,
        sensitive: true,
        helpText: 'Stored encrypted via safeStorage.',
        visibleWhen: { authType: 'basic' },
      },
    ],
  },

  metadata: {
    displayName: 'REST API',
    description: 'Generic HTTP endpoint connector. Auth stays here; requests are authored on the DataSource node.',
    version: '1.0.0',
    author: 'Ternlux',
    capabilities: ['read'],
    documentationUrl: '',
  },
};

// ── Helpers exported as locals (used by runQuery) ───────────────────────────

function extractRows(data, responsePath) {
  let node = data;
  if (responsePath && typeof responsePath === 'string') {
    const parts = responsePath.split('.').map(p => p.trim()).filter(Boolean);
    for (const key of parts) {
      if (node == null) break;
      node = node[key];
    }
  }
  if (Array.isArray(node)) return node;
  if (node && typeof node === 'object') return [node];
  if (node == null) return [];
  // Primitive response — wrap into a single-row shape.
  return [{ value: node }];
}

function inferColumns(sampleRow) {
  if (!sampleRow || typeof sampleRow !== 'object') return [];
  return Object.keys(sampleRow).map(name => ({
    name,
    type: inferType(sampleRow[name]),
    nullable: true,
    isPrimary: name === 'id' || name === '_id',
  }));
}

function inferType(value) {
  if (value == null) return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) || typeof value === 'object') return 'json';
  return 'string';
}
