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
const {
  PRESETS, getPreset, resolveCredentialKeys, buildPresetHeaders, valueAt, fillTemplate,
} = require('./presets');

// Upper bound on the key/value list the connection form offers. Kept here
// because the form reads it off the schema.
const MAX_API_PARAMS = 50;

// ── Auth helpers ────────────────────────────────────────────────────────────

/**
 * Legacy auth header, for connections saved before the open-ended
 * `apiParams` list replaced the fixed authType fields. New connections carry
 * no authType, so this returns null and the request authored on the node
 * supplies its own headers via placeholders.
 */
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

/**
 * Test a vendor-preset connection. Unlike a hand-built connection, a preset
 * knows where each saved key goes, so this sends the real credentials to an
 * endpoint that needs them and reports a rejected token as a failure.
 */
async function testPresetConnection(preset, config) {
  const saved = {};
  for (const p of (Array.isArray(config.apiParams) ? config.apiParams : [])) {
    if (p && p.key) saved[String(p.key)] = p.value == null ? '' : String(p.value);
  }
  // Keyed by the preset's credential names, read from whatever name the
  // connection saved each one under.
  const keyMap = resolveCredentialKeys(preset, Object.keys(saved));
  const valuesByKey = Object.fromEntries(
    Object.entries(keyMap).map(([presetKey, savedKey]) => [presetKey, saved[savedKey] || '']),
  );
  const { headers, missing } = buildPresetHeaders(preset, valuesByKey);
  if (missing.length > 0) {
    return {
      success: false,
      message: `Enter the ${missing.join(', ')} to test this connection. A saved value is not `
        + 're-read for a test, so re-type it when testing an existing connection.',
    };
  }
  const baseUrl = String(config.baseUrl || preset.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      success: false,
      message: `Enter your ${preset.title} base URL (e.g. ${preset.baseUrlPlaceholder || preset.baseUrl}) to test this connection.`,
    };
  }
  // A test path or body may name a non-secret credential — Plausible's site
  // domain, Twilio's Account SID — filled in the same way as a header.
  const fill = (v) => (v == null ? v : JSON.parse(fillTemplate(JSON.stringify(v), valuesByKey)));
  const res = await axios({
    method: preset.test.method || 'GET',
    url: `${baseUrl}${fillTemplate(preset.test.path, valuesByKey)}`,
    headers: preset.test.body ? { 'Content-Type': 'application/json', ...headers } : headers,
    data: fill(preset.test.body),
    timeout: 10_000,
    validateStatus: () => true,
  });
  // A GraphQL API answers 200 with an `errors` array when it refuses a request.
  const graphqlErrors = res.data && typeof res.data === 'object' && Array.isArray(res.data.errors) && !res.data.data;
  if (res.status >= 200 && res.status < 300 && !graphqlErrors) {
    const who = preset.test.identityField ? valueAt(res.data, preset.test.identityField) : null;
    return { success: true, message: who ? `Connected to ${preset.title} as ${who}.` : `Connected to ${preset.title}.` };
  }
  const detail = errorDetail(res.data);
  const said = detail ? ` ${detail}` : '';
  if (res.status === 401 || graphqlErrors) {
    return { success: false, message: `${preset.title} rejected the credentials (HTTP ${res.status}).${said}` };
  }
  if (res.status === 403) {
    // Some vendors (Typeform) answer a bad token with 403 rather than 401, so
    // this cannot claim the credentials were accepted.
    return { success: false, message: `${preset.title} refused access (HTTP 403) — the credentials are wrong or missing a scope.${said}` };
  }
  if (res.status === 404 && !preset.baseUrl) {
    return { success: false, message: `${preset.title} answered 404 — check the base URL (${baseUrl}).${said}` };
  }
  return { success: false, message: `${preset.title} responded with HTTP ${res.status}.${said}` };
}

/**
 * The human part of an API error body. Vendors disagree on where it lives:
 * message (GitHub, HubSpot, Notion), error.message (Stripe, Airtable),
 * errors[0].message|detail (SendGrid, Intercom, Klaviyo, Linear),
 * errorMessages[0] (Jira), description (Freshdesk, Typeform), detail (Mailchimp).
 */
function errorDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const first = Array.isArray(data.errors) ? data.errors[0] : null;
  const text = data.message
    || (data.error && typeof data.error === 'object' ? data.error.message : data.error)
    || (first && (first.message || first.detail || first.title))
    || (Array.isArray(data.errorMessages) ? data.errorMessages[0] : null)
    || data.description
    || data.detail
    || data.title
    || '';
  return String(typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 200);
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
   * Ping the configured base URL. We can only send credentials automatically
   * for legacy authType connections — a key/value pair could be a header, a
   * query parameter or a body field, and only the request authored on the
   * DataSource node knows which. So the test checks reachability and reports
   * an auth challenge as reachable-but-unauthenticated rather than a failure.
   */
  async testConnection(config /*, connectionId */) {
    try {
      const preset = getPreset(config && config.presetId);
      if (preset) return await testPresetConnection(preset, config);

      const baseUrl = config && config.baseUrl && String(config.baseUrl).trim();
      if (!baseUrl) {
        return {
          success: true,
          message: 'No base URL configured — credentials will be applied on first fetch.',
        };
      }
      const paramCount = Array.isArray(config && config.apiParams)
        ? config.apiParams.filter(p => p && String(p.key || '').trim()).length
        : 0;
      const headers = headersFromConfig(config);
      const res = await axios.get(baseUrl, {
        headers,
        timeout: 10_000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 400) {
        return { success: true, message: `HTTP ${res.status}` };
      }
      if ((res.status === 401 || res.status === 403) && paramCount > 0) {
        return {
          success: true,
          message: `Base URL reachable (HTTP ${res.status}). This test does not send your `
            + `${paramCount} saved parameter${paramCount === 1 ? '' : 's'} — the request authored `
            + 'on the node decides where each one goes, so auth is validated on first fetch.',
        };
      }
      return {
        success: false,
        message: `Base URL responded with HTTP ${res.status}. Check the URL and credentials.`,
      };
    } catch (err) {
      return { success: false, message: err.message || 'Connection failed' };
    }
  },

  /**
   * Synthetic single "table" representing an API response. The real
   * table/collection is materialised into DuckDB at DataSource node use time.
   */
  async getTables(/* config, connectionId */) {
    return {
      success: true,
      tables: [{ name: 'response', schema: null, type: 'virtual' }],
    };
  },

  /**
   * Columns are unknown until a request is authored. Return empty; the chat
   * flow infers them from the materialised table.
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
        name: 'apiParams',
        type: 'keyValue',
        label: 'Parameters & Credentials',
        required: false,
        sensitive: true,
        maxPairs: MAX_API_PARAMS,
        keyPlaceholder: 'Key (e.g. Authorization, X-API-Key, tenant_id)',
        valuePlaceholder: 'Value',
        publicKeysField: 'apiParamKeys',
        helpText:
          'Anything the endpoint needs — auth headers, API keys, tenant ids, query parameters. '
          + `Up to ${MAX_API_PARAMS} entries, one value per key. Values are encrypted via safeStorage `
          + 'and never sent to the chat; the assistant sees only the key names and references them '
          + 'as {{PLACEHOLDER}} tokens (e.g. a key "X-API-Key" becomes {{X_API_KEY}}).',
      },
      {
        // Key names only, mirrored into the saved connection so the chat can
        // advertise the placeholder vocabulary without touching the values.
        // Written by the form; never rendered.
        name: 'apiParamKeys',
        type: 'internal',
        sensitive: false,
      },
      {
        // Set when the connection was made from a vendor preset (see
        // ./presets). Written by the preset form; never rendered.
        name: 'presetId',
        type: 'internal',
        sensitive: false,
      },
    ],
  },

  // Vendor presets: plain data, listed to the renderer with the plugin so the
  // connector picker can offer one tile per vendor.
  presets: PRESETS,

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
