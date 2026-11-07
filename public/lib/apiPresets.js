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

function presetReferenceForPlaceholders(conn) {
  const found = presetFor(conn);
  if (!found) return null;
  const keyMap = found.mod.resolveCredentialKeys(found.preset, savedKeysOf(conn));
  const savedKeys = Object.values(keyMap);
  const tokens = new Map(buildParamTokens(savedKeys).map(({ key, token }) => [key, `{{${token}}}`]));
  return found.mod.describePreset(found.preset, {
    credentialRef: (key) => tokens.get(keyMap[key]) || key,
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

module.exports = {
  presetReferenceForPlaceholders,
  presetReferenceForCtx,
};
