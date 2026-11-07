// Vendor presets of the REST API connector, as the renderer sees them.
//
// A preset tile in the picker has the key `rest-api:<presetId>`. The connection
// it creates is a plain `rest-api` connection with `dbConfig.presetId` set, so
// everything downstream (ApiFetch, the chat builders, ctx.apiCredentials) keeps
// treating it as a REST API connection. This module turns a tile key — or a
// saved connection — back into the form the user should see.

const PRESET_SEPARATOR = ':';

// 'rest-api:github' → { pluginId: 'rest-api', presetId: 'github' }
export const splitConnectorKey = (key) => {
  const [pluginId, presetId] = String(key || '').split(PRESET_SEPARATOR);
  return { pluginId, presetId: presetId || null };
};

// The picker key that opens this connection's form: the preset tile for a
// preset connection, the plugin id for everything else.
export const connectorKeyFor = (conn) => {
  const presetId = conn?.dbConfig?.presetId;
  return presetId ? `${conn.dbType}${PRESET_SEPARATOR}${presetId}` : conn?.dbType;
};

// The preset a saved connection was made from, read off the installed REST API
// plugin. Null for any other connection, or when the plugin is not installed.
export const presetForConnection = (installedPlugins, conn) => {
  const presetId = conn?.dbConfig?.presetId;
  if (!presetId) return null;
  const plugin = (installedPlugins || []).find((p) => p.id === conn.dbType);
  return (plugin?.presets || []).find((p) => p.id === presetId) || null;
};

// One endpoint's identity within a preset: method + path, plus the GraphQL
// operation when several share one path (Linear's POST /graphql).
export const endpointKey = (endpoint) => `${endpoint.method || 'GET'} ${endpoint.path}`
  + (endpoint.operation ? ` ${endpoint.operation}` : '');

/**
 * What an endpoint can be told, for the form to list: the `{variables}` its
 * path needs, and the optional query/body options the preset documents.
 * A `{a|b|c}` segment is a choice rather than a name: { name: 'type', choices }.
 */
export const endpointVariables = (endpoint) => {
  const segments = [...new Set((String(endpoint?.path || '').match(/\{([^}]+)\}/g) || [])
    .map((v) => v.slice(1, -1)))];
  return {
    required: segments.map((s) => (s.includes('|')
      ? { name: 'type', choices: s.split('|') }
      : { name: s, choices: null })),
    optional: endpoint?.params || null,
  };
};

/**
 * The first chat message for a Data Source whose endpoint was picked in the
 * form. The user adds the variables before sending; the builder also reads the
 * pick off the node config, so it is not lost if they rewrite the message.
 */
export const endpointRequestDraft = (preset, endpoint) => {
  const what = `Pull ${endpoint.label} from ${preset.title} (${endpointKey(endpoint)})`;
  const { required } = endpointVariables(endpoint);
  return required.length ? `${what} for ${required.map((v) => `${v.name}: `).join(', ')}` : `${what}.`;
};

// Field name for the i-th preset credential. Collapsed into `apiParams` on save.
const credentialFieldName = (index) => `presetCredential_${index}`;

const presetConfigSchema = (preset) => ({
  fields: [
    { name: 'presetId', type: 'hidden', default: preset.id, sensitive: false },
    ...(preset.credentials || []).map((c, i) => ({
      name: credentialFieldName(i),
      type: 'presetCredential',
      paramKey: c.key,
      label: c.label,
      placeholder: c.placeholder,
      helpText: c.helpText,
      required: true,
    })),
    // A fixed API root is pre-filled; a per-account one (Jira, Freshdesk,
    // Mailchimp) is left empty with an example of what to type.
    {
      name: 'baseUrl',
      type: 'string',
      label: preset.baseUrl ? 'Base URL' : `${preset.title} URL`,
      ...(preset.baseUrl ? { default: preset.baseUrl } : {}),
      placeholder: preset.baseUrl || preset.baseUrlPlaceholder,
      required: true,
      sensitive: false,
      helpText: preset.baseUrl
        ? `Leave as ${preset.baseUrl} unless you use a self-hosted or regional ${preset.title} API.`
        : preset.baseUrlHelp,
    },
  ],
});

/**
 * The plugin object the connection form renders for a picker key. For a preset
 * key it is the REST API plugin dressed as the vendor: the vendor's name, and a
 * schema asking only for its credentials. Returns null when the plugin (or the
 * preset) is not installed.
 */
export const resolveConnectorPlugin = (installedPlugins, key) => {
  const { pluginId, presetId } = splitConnectorKey(key);
  const plugin = (installedPlugins || []).find((p) => p.id === pluginId) || null;
  if (!plugin || !presetId) return plugin;
  const preset = (plugin.presets || []).find((p) => p.id === presetId);
  if (!preset) return null;
  return {
    ...plugin,
    name: preset.title,
    presetId: preset.id,
    preset,
    configSchema: presetConfigSchema(preset),
  };
};
