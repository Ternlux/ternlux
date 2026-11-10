/**
 * API connectors: SaaS connectors with their own sign-in (OAuth or a vendor
 * token) whose data is read and written by AI-authored request code, exactly
 * like a REST API connection, but with the auth handled by the connector.
 *
 * A connector plugin opts in with `dbCategory: 'API'` and an `apiReference`
 * (the same shape as a REST preset: baseUrl, headers, endpoints, pagination,
 * notes, writes). It may also declare:
 *
 *   oauth: {                      // generic OAuth 2.0 authorization-code flow
 *     authorizeUrl,               // string or (config) => string
 *     tokenUrl,                   // string or (config) => string
 *     scopes: [], scopeSeparator, // joined into `scope`
 *     pkce: true|false,           // S256 code challenge
 *     authParams: {},             // extra authorize-URL params (access_type…)
 *     clientAuth: 'body'|'basic', // how the client id/secret reach the token URL
 *     parseTokens(data, config),  // → { accessToken, refreshToken, expiresIn, extra }
 *     requiredFields: ['clientId', 'clientSecret'],
 *   }
 *   apiBaseUrl(config)            // base URL when it is per account
 *   getLiveContext(config, { request, mode, axios }) → string
 *                                 // fresh account details for the AI (see below)
 *
 * Any of getAuthorizationUrl / exchangeCodeForTokens / refreshAccessToken /
 * testConnection the plugin does not write itself is supplied here from that
 * spec, so most connectors are data: endpoints, scopes and headers.
 *
 * Header templates name config fields in braces — `Bearer {accessToken}`,
 * `{developerToken}` — and each such field becomes a placeholder token for the
 * generated code (`{{ACCESS_TOKEN}}`, `{{DEVELOPER_TOKEN}}`), filled in from
 * the decrypted config at run time, after the token has been refreshed.
 */

const crypto = require('crypto');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/oauth/callback';

const isApiConnector = (plugin) => !!plugin && plugin.dbCategory === 'API' && !!plugin.apiReference;

const valueOf = (v, config) => (typeof v === 'function' ? v(config || {}) : v);

/** 'developerToken' → 'DEVELOPER_TOKEN' */
function fieldToken(field) {
  return String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function fillTemplate(template, values) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (m, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : m
  ));
}

/** Config fields the reference's header templates use, accessToken always first. */
function templateFields(reference) {
  const fields = new Set(['accessToken']);
  for (const t of Object.values((reference && reference.headers) || {})) {
    for (const m of String(t).matchAll(/\{([A-Za-z0-9_]+)\}/g)) fields.add(m[1]);
  }
  for (const f of (reference && reference.tokenFields) || []) fields.add(f);
  return [...fields];
}

/** Placeholder names a connector's code may use: {{ACCESS_TOKEN}}, {{DEVELOPER_TOKEN}}… */
function connectorPlaceholderNames(plugin) {
  if (!isApiConnector(plugin)) return [];
  return templateFields(plugin.apiReference).map((f) => `{{${fieldToken(f)}}}`);
}

function resolveBaseUrl(plugin, config) {
  const ref = plugin.apiReference || {};
  const raw = typeof plugin.apiBaseUrl === 'function'
    ? plugin.apiBaseUrl(config || {})
    : (ref.baseUrl || (config && config.baseUrl) || '');
  return String(raw || '').replace(/\/+$/, '');
}

/** The request headers with the config's values filled in. */
function connectorHeaders(plugin, config) {
  const out = {};
  for (const [name, t] of Object.entries((plugin.apiReference && plugin.apiReference.headers) || {})) {
    const v = fillTemplate(t, config || {});
    // A header whose value is still a template (an optional field the user
    // left blank) is dropped rather than sent as "{loginCustomerId}".
    if (v && !/\{[A-Za-z0-9_]+\}/.test(v)) out[name] = v;
  }
  return out;
}

/**
 * Add what the generated code needs to a connector connection's decrypted
 * config: `baseUrl` (computed for per-account hosts), `connectorTokens`
 * ({ ACCESS_TOKEN: '…' } for the {{PLACEHOLDER}} runner) and `connectorValues`
 * ({ accessToken: '…' } for ctx.apiCredentials in chat runs).
 */
function resolveConnectorConfig(plugin, config) {
  if (!isApiConnector(plugin)) return config;
  const tokens = {};
  const values = {};
  for (const f of templateFields(plugin.apiReference)) {
    const v = config[f] == null ? '' : String(config[f]);
    tokens[fieldToken(f)] = v;
    values[f] = v;
  }
  return {
    ...config,
    baseUrl: resolveBaseUrl(plugin, config),
    connectorTokens: tokens,
    connectorValues: values,
    connectorHeaders: connectorHeaders(plugin, config),
  };
}

// ── Generic OAuth 2.0 ───────────────────────────────────────────────────────

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function makeAuthorizationUrl(spec) {
  return (config = {}) => {
    try {
      if (!config.clientId) return { success: false, message: 'Enter the client ID first.' };
      const url = new URL(valueOf(spec.authorizeUrl, config));
      const p = url.searchParams;
      p.set(spec.clientIdParam || 'client_id', config.clientId);
      p.set('redirect_uri', config.redirectUri || DEFAULT_REDIRECT_URI);
      p.set('response_type', 'code');
      const scopes = valueOf(spec.scopes, config);
      if (scopes && scopes.length) p.set('scope', scopes.join(spec.scopeSeparator || ' '));
      if (config.state) p.set('state', config.state);
      for (const [k, v] of Object.entries(valueOf(spec.authParams, config) || {})) p.set(k, v);
      let codeVerifier = null;
      if (spec.pkce) {
        const pair = pkcePair();
        codeVerifier = pair.verifier;
        p.set('code_challenge', pair.challenge);
        p.set('code_challenge_method', 'S256');
      }
      return { success: true, authUrl: url.toString(), codeVerifier };
    } catch (err) {
      return { success: false, message: err.message };
    }
  };
}

function describeTokenError(err) {
  const d = err && err.response && err.response.data;
  if (d && typeof d === 'object') {
    return d.error_description || d.error?.message || d.message || d.error || JSON.stringify(d).slice(0, 300);
  }
  if (typeof d === 'string' && d) return d.slice(0, 300);
  return err.message;
}

async function postToken(axios, spec, config, params) {
  const body = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (spec.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret || ''}`).toString('base64')}`;
  } else {
    body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
  }
  const url = valueOf(spec.tokenUrl, config);
  // A few providers (Meta's Graph API) document the token exchange as a GET.
  const res = spec.tokenMethod === 'GET'
    ? await axios.get(`${url}?${body.toString()}`, { headers: { Accept: 'application/json' }, timeout: 30000 })
    : await axios.post(url, body.toString(), { headers, timeout: 30000 });
  return res.data;
}

function normaliseTokens(spec, data, config) {
  const parsed = typeof spec.parseTokens === 'function'
    ? spec.parseTokens(data, config)
    : {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  const expiresIn = Number(parsed.expiresIn) || 0;
  return {
    tokens: {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken || null,
      expiryDate: parsed.expiryDate || (expiresIn ? Date.now() + expiresIn * 1000 : null),
    },
    extra: parsed.extra || {},
  };
}

function makeExchange(spec, axios) {
  return async (config = {}, code) => {
    try {
      const params = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri || DEFAULT_REDIRECT_URI,
      };
      if (config.codeVerifier) params.code_verifier = config.codeVerifier;
      const data = await postToken(axios, spec, config, params);
      const normalised = normaliseTokens(spec, data, config);
      let { tokens } = normalised;
      const { extra } = normalised;
      if (!tokens.accessToken) return { success: false, message: 'The provider returned no access token.' };
      // Trade a short-lived token for a long-lived one (Meta), when the
      // provider works that way instead of issuing refresh tokens.
      if (typeof spec.upgradeTokens === 'function') tokens = { ...tokens, ...(await spec.upgradeTokens(tokens, config, axios)) };
      const more = typeof spec.afterExchange === 'function'
        ? await spec.afterExchange({ ...config, ...extra, ...tokens }, axios)
        : {};
      return { success: true, tokens, extra: { ...extra, ...(more || {}) } };
    } catch (err) {
      return { success: false, message: describeTokenError(err) };
    }
  };
}

function makeRefresh(spec, axios) {
  return async (config = {}) => {
    try {
      if (!config.refreshToken) return { success: false, message: 'No refresh token saved — connect again.' };
      const data = await postToken(axios, spec, config, {
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
        ...(valueOf(spec.refreshParams, config) || {}),
      });
      const { tokens, extra } = normaliseTokens(spec, data, config);
      if (!tokens.accessToken) return { success: false, message: 'The provider returned no access token.' };
      return { success: true, tokens, extra };
    } catch (err) {
      return { success: false, message: describeTokenError(err) };
    }
  };
}

function makeTest(plugin, axios) {
  return async (config = {}) => {
    const test = plugin.apiReference.test;
    if (!test) return { success: true, message: `${plugin.name} credentials saved.` };
    if (!config.accessToken) {
      return { success: false, message: `Connect your ${plugin.name} account first (the Authorize button).` };
    }
    const resolved = resolveConnectorConfig(plugin, config);
    const path = fillTemplate(test.path, config);
    const url = /^https?:\/\//i.test(path) ? path : `${resolved.baseUrl}${path}`;
    try {
      const res = await axios({
        method: test.method || 'GET',
        url,
        headers: { Accept: 'application/json', ...resolved.connectorHeaders, ...(test.body ? { 'Content-Type': 'application/json' } : {}) },
        data: test.body,
        timeout: 20000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) {
        const who = typeof test.identity === 'function' ? test.identity(res.data) : null;
        return { success: true, message: who ? `Connected to ${plugin.name} as ${who}.` : `Connected to ${plugin.name}.` };
      }
      const said = describeTokenError({ response: res, message: '' });
      return { success: false, message: `${plugin.name} answered HTTP ${res.status}${said ? `: ${said}` : ''}.` };
    } catch (err) {
      return { success: false, message: `Could not reach ${plugin.name}: ${err.message}` };
    }
  };
}

/**
 * Fill in the connector methods the plugin did not write, from its `oauth`
 * spec and `apiReference`. Called by the plugin manager on load. The table
 * methods the loader requires of a database connector have no meaning for an
 * API (its data is reached by request code, not by table), so they report
 * that rather than pretend.
 */
/**
 * The form fields every OAuth connector needs, added to its configSchema
 * unless it declares them itself: the app's client id and secret, the
 * redirect URI, and the three hidden token fields the Authorize button fills.
 * Tokens and the secret are `sensitive`, so they go to the encrypted store.
 */
function oauthFields(plugin) {
  const o = plugin.oauth || {};
  const secretRequired = (o.requiredFields || ['clientId', 'clientSecret']).includes('clientSecret');
  return [
    { name: 'clientId', type: 'string', label: o.clientIdLabel || 'Client ID', required: true, sensitive: true,
      helpText: o.clientIdHelp || `From the OAuth app you created for ${plugin.name} — see the setup guide.` },
    { name: 'clientSecret', type: 'password', label: o.clientSecretLabel || 'Client secret', required: secretRequired, sensitive: true,
      helpText: o.clientSecretHelp || 'From the same OAuth app.' },
    { name: 'redirectUri', type: 'string', label: 'Redirect URI', default: DEFAULT_REDIRECT_URI, placeholder: DEFAULT_REDIRECT_URI,
      required: false, sensitive: false, helpText: 'Add exactly this URL to the OAuth app\'s allowed redirect URLs.' },
    { name: 'accessToken', type: 'hidden', label: 'Access token', required: false, sensitive: true },
    { name: 'refreshToken', type: 'hidden', label: 'Refresh token', required: false, sensitive: true },
    { name: 'expiryDate', type: 'hidden', label: 'Token expiry', required: false, sensitive: false },
  ];
}

function withOAuthFields(plugin) {
  const fields = (plugin.configSchema && plugin.configSchema.fields) || [];
  const have = new Set(fields.map((f) => f.name));
  const added = oauthFields(plugin).filter((f) => !have.has(f.name));
  // The app credentials first (the user fills them before anything else),
  // then the connector's own fields, then the hidden token fields.
  const top = added.filter((f) => f.type !== 'hidden');
  const hidden = added.filter((f) => f.type === 'hidden');
  return { ...(plugin.configSchema || {}), fields: [...top, ...fields, ...hidden] };
}

function completeApiConnector(plugin, axios = require('axios')) {
  if (!isApiConnector(plugin)) return plugin;
  const out = { ...plugin };
  if (plugin.oauth) {
    out.configSchema = withOAuthFields(plugin);
    out.authType = plugin.authType || 'oauth2';
    if (typeof out.getAuthorizationUrl !== 'function') out.getAuthorizationUrl = makeAuthorizationUrl(plugin.oauth);
    if (typeof out.exchangeCodeForTokens !== 'function') out.exchangeCodeForTokens = makeExchange(plugin.oauth, axios);
    if (typeof out.refreshAccessToken !== 'function' && plugin.oauth.refresh !== false) {
      out.refreshAccessToken = makeRefresh(plugin.oauth, axios);
    }
  }
  if (typeof out.testConnection !== 'function') out.testConnection = makeTest(out, axios);
  const noTables = async () => ({ success: true, tables: [], message: `${plugin.name} is read by request code on a Data Source node.` });
  if (typeof out.getTables !== 'function') out.getTables = noTables;
  if (typeof out.getColumns !== 'function') out.getColumns = async () => ({ success: true, columns: [] });
  if (typeof out.runQuery !== 'function') {
    out.runQuery = async () => ({ success: false, message: `${plugin.name} has no query language; describe what to fetch on a Data Source node.` });
  }
  return out;
}

// ── Fresh account details for the AI ───────────────────────────────────────

const LIVE_TTL_MS = 5 * 60 * 1000;
const liveCache = new Map();

/**
 * The connector's live account context (GA4 properties and their custom
 * dimensions, Salesforce objects and fields…), fetched with the user's token
 * each time a node is built so the AI works from the account as it is now,
 * not as it was when the connection was made. Cached for a few minutes per
 * connection and request, so one build that asks several times calls once.
 * Returns '' when the connector has none or the call fails — the reference
 * alone still lets the AI build, and the probe step can look things up.
 */
async function liveContextFor(plugin, connectionId, config, { request = '', mode = 'read' } = {}) {
  if (!isApiConnector(plugin) || typeof plugin.getLiveContext !== 'function') return '';
  const key = `${connectionId}|${mode}|${String(request).slice(0, 400)}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.text;
  try {
    const resolved = resolveConnectorConfig(plugin, config);
    const axios = require('axios').create({ timeout: 20000, headers: { Accept: 'application/json', ...resolved.connectorHeaders } });
    const text = String(await plugin.getLiveContext(resolved, { request, mode, axios }) || '').trim();
    liveCache.set(key, { at: Date.now(), text });
    return text;
  } catch (err) {
    const status = err && err.response && err.response.status;
    console.warn(`[api-connector] ${plugin.id} live context failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    return '';
  }
}

module.exports = {
  DEFAULT_REDIRECT_URI,
  isApiConnector,
  fieldToken,
  templateFields,
  connectorPlaceholderNames,
  connectorHeaders,
  resolveConnectorConfig,
  completeApiConnector,
  liveContextFor,
  // exported for tests
  _internal: { makeAuthorizationUrl, makeExchange, makeRefresh, makeTest, pkcePair, normaliseTokens, liveCache },
};
