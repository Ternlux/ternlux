/**
 * Main-process access to the REST API connector's vendor presets
 * (plugins/connectors/rest-api/presets), for the prompts that write fetch code.
 *
 * Read from the plugin folder at call time rather than at load: the plugin can
 * be installed or updated while the app is running, and a connection made from
 * a preset must still build (without the reference) if the plugin is missing.
 */

const path = require('path');
const { buildParamTokens } = require('./apiPlaceholders');

const PRESETS_PATH = path.join(__dirname, '../../plugins/connectors/rest-api/presets');

function loadPresets() {
  try {
    return require(PRESETS_PATH);
  } catch (_err) {
    return null;
  }
}

function presetFor(conn) {
  const presetId = conn && conn.dbConfig && conn.dbConfig.presetId;
  if (!presetId) return null;
  const mod = loadPresets();
  const preset = mod ? mod.getPreset(presetId) : null;
  return preset ? { mod, preset } : null;
}

/**
 * Endpoint reference for a DataSource node's fetch function, where saved
 * values are reached through `{{PLACEHOLDER}}` tokens. Null for a connection
 * that was not made from a preset.
 */
// The key names this connection actually saved — a connection made under an
// earlier name of a preset credential still resolves (see resolveCredentialKeys).
function savedKeysOf(conn) {
  const d = (conn && conn.dbConfig) || {};
  if (Array.isArray(d.apiParams)) return d.apiParams.map((p) => p && p.key).filter(Boolean);
  return Array.isArray(d.apiParamKeys) ? d.apiParamKeys : [];
}

function presetReferenceForPlaceholders(conn, { mode = 'read' } = {}) {
  const found = presetFor(conn);
  if (!found) return null;
  const keyMap = found.mod.resolveCredentialKeys(found.preset, savedKeysOf(conn));
  const savedKeys = Object.values(keyMap);
  const tokens = new Map(buildParamTokens(savedKeys).map(({ key, token }) => [key, `{{${token}}}`]));
  return found.mod.describePreset(found.preset, {
    credentialRef: (key) => tokens.get(keyMap[key]) || key,
    mode,
  });
}

/**
 * Endpoint reference for a chat-run function, where saved values are read with
 * ctx.apiCredentials(connection).params[key].
 */
function presetReferenceForCtx(conn) {
  const found = presetFor(conn);
  if (!found) return null;
  const keyMap = found.mod.resolveCredentialKeys(found.preset, savedKeysOf(conn));
  return found.mod.describePreset(found.preset, {
    credentialRef: (key) => `<params['${keyMap[key]}'] from ctx.apiCredentials('${conn.name}')>`,
  });
}

// ── API connectors (own sign-in: Salesforce, GA4, the ad platforms…) ──────

const {
  isApiConnector, templateFields, fieldToken, connectorPlaceholderNames, liveContextFor,
} = require('./apiConnectors');

function connectorPluginFor(conn) {
  if (!conn || !conn.dbType || conn.dbType === 'rest-api') return null;
  try {
    // Required lazily: the plugin manager is a main-process singleton.
    // eslint-disable-next-line global-require
    const pluginManager = require('../pluginManager');
    const plugin = pluginManager.hasConnector(conn.dbType) ? pluginManager.getConnector(conn.dbType) : null;
    return isApiConnector(plugin) ? plugin : null;
  } catch (_err) {
    return null;
  }
}

// The connector's reference in the preset shape describePreset renders.
function connectorAsPreset(plugin) {
  const ref = plugin.apiReference;
  return {
    ...ref,
    id: plugin.id,
    // describePreset appends " API reference"; ref.title ("Salesforce REST
    // API") is kept for the docs link line instead.
    title: plugin.name,
    credentials: templateFields(ref).map((key) => ({ key })),
    // A per-account host (Salesforce instance, Dynamics environment, Zoho
    // data centre) is worked out from the signed-in account at run time.
    baseUrl: ref.baseUrl || `{{BASE_URL}} (this account's own address, e.g. ${ref.baseUrlPlaceholder}, filled in at run time)`,
  };
}

function describeConnector(plugin, { credentialRef, mode }) {
  const mod = loadPresets();
  if (!mod) return null;
  return mod.describePreset(connectorAsPreset(plugin), { credentialRef, mode });
}

/** {{PLACEHOLDER}} names an API connector's generated code may use. */
function connectorPlaceholders(conn) {
  const plugin = connectorPluginFor(conn);
  return plugin ? connectorPlaceholderNames(plugin) : [];
}

/**
 * Endpoint reference for a node's generated code: a REST preset's, or an API
 * connector's (its header values named as placeholders). Null for a
 * hand-built REST connection.
 */
function apiReferenceForPlaceholders(conn, { mode = 'read' } = {}) {
  const preset = presetReferenceForPlaceholders(conn, { mode });
  if (preset) return preset;
  const plugin = connectorPluginFor(conn);
  if (!plugin) return null;
  return describeConnector(plugin, { credentialRef: (key) => `{{${fieldToken(key)}}}`, mode });
}

/** The same for a chat run, where values come from ctx.apiCredentials. */
function apiReferenceForCtx(conn) {
  const preset = presetReferenceForCtx(conn);
  if (preset) return preset;
  const plugin = connectorPluginFor(conn);
  if (!plugin) return null;
  const text = describeConnector(plugin, {
    credentialRef: (key) => `<values['${key}'] from ctx.apiCredentials('${conn.name}')>`,
    mode: 'read',
  });
  return text && `${text}\n\nAuth: \`const { baseUrl, headers } = await ctx.apiCredentials('${conn.name}')\` gives the base URL and EVERY header these requests need (the access token is already refreshed) — send \`headers\` as-is on each request.`;
}

/**
 * Live details of the user's account for the AI, fetched now with their
 * token (see liveContextFor). '' for a preset or plain REST connection.
 */
async function liveApiContext(conn, helpers, { request = '', mode = 'read' } = {}) {
  const plugin = connectorPluginFor(conn);
  if (!plugin || !helpers || typeof helpers.getFullConfig !== 'function') return '';
  const id = conn.id || conn._id;
  const config = await helpers.getFullConfig(id, conn.dbConfig || {});
  return liveContextFor(plugin, id, config, { request, mode });
}

module.exports = {
  presetReferenceForPlaceholders,
  presetReferenceForCtx,
  apiReferenceForPlaceholders,
  apiReferenceForCtx,
  connectorPlaceholders,
  liveApiContext,
};
