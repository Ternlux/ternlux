/**
 * Vendor presets for the REST API connector.
 *
 * A preset is reference data, not a different connector: a preset connection
 * is an ordinary `rest-api` connection whose `dbConfig.presetId` names one of
 * these. Its credentials are saved as ordinary `apiParams` (one key per
 * `credentials` entry), so ApiFetch and ctx.apiCredentials resolve them exactly
 * as they do for a hand-built REST connection. What a preset adds:
 *   - a connection form that asks only for the credentials the vendor needs,
 *   - a Test Connection that sends those credentials the way the vendor expects,
 *   - an endpoint reference handed to the AI that authors the fetch function.
 *
 * Fields a preset can carry (github.js and hubspot.js show the common shape):
 *   baseUrl            fixed API root, or null when it is per account — then
 *                      baseUrlPlaceholder / baseUrlHelp tell the user what to type
 *   credentials        [{ key, label, placeholder, helpText, optional?, usedIn? }] saved as apiParams;
 *                      usedIn 'query'|'body' marks one the requests carry outside the headers
 *                      (Mixpanel's project id, Plausible's site), optional one only writes need
 *   headers            { Name: 'template' } — `{Key}` is the value saved under Key
 *   basicAuth          { username, password } templates for HTTP Basic auth
 *   test               { path, method?, body?, identityField? } for Test Connection
 *   pagination, endpoints, notes   the reference the AI gets
 *
 * To add a vendor: create `<id>.js` next to this file and list it below.
 */

const PRESETS = [
  require('./github'),
  require('./hubspot'),
  require('./stripe'),
  require('./notion'),
  require('./airtable'),
  require('./jira'),
  require('./pipedrive'),
  require('./sendgrid'),
  require('./klaviyo'),
  require('./intercom'),
  require('./linear'),
  require('./mailchimp'),
  require('./freshdesk'),
  require('./calendly'),
  require('./typeform'),
  require('./close'),
  require('./attio'),
  require('./activecampaign'),
  require('./apollo'),
  require('./zendesk'),
  require('./front'),
  require('./gorgias'),
  require('./asana'),
  require('./monday'),
  require('./clickup'),
  require('./gitlab'),
  require('./sentry'),
  require('./smartsheet'),
  require('./brevo'),
  require('./customer-io'),
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

function getPreset(id) {
  return (id && BY_ID.get(String(id))) || null;
}

// `{Key name}` in a header template → the value saved under that key.
function fillTemplate(template, valuesByKey) {
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(valuesByKey, key) ? valuesByKey[key] : match
  ));
}

/**
 * Which saved key holds each preset credential: { presetKey: savedKey }.
 * Normally the same name. A connection saved under an earlier name of a
 * credential (HubSpot's "Private app token" before it became "Access token")
 * is matched by position when it saved the same number of keys, so renaming a
 * preset credential never strands existing connections.
 */
function resolveCredentialKeys(preset, savedKeys = []) {
  const presetKeys = (preset.credentials || []).map((c) => c.key);
  const saved = (savedKeys || []).map(String);
  const positional = saved.length === presetKeys.length;
  return Object.fromEntries(presetKeys.map((key, i) => [
    key,
    saved.includes(key) || !positional ? key : saved[i],
  ]));
}

/**
 * The request headers a preset sends, with credential values filled in.
 * `missing` lists credential keys that have no value — the caller decides what
 * that means (Test Connection reports it rather than sending a broken header).
 */
function buildPresetHeaders(preset, valuesByKey = {}) {
  const missing = (preset.credentials || [])
    .filter((c) => !c.optional)
    .map((c) => c.key)
    .filter((k) => !valuesByKey[k]);
  const headers = {};
  for (const [name, template] of Object.entries(preset.headers || {})) {
    const value = fillTemplate(template, valuesByKey);
    // A header built only from an optional credential the user left blank
    // is left out rather than sent with the "{Key}" text in it.
    if (/\{[^{}]+\}/.test(value)) continue;
    headers[name] = value;
  }
  if (preset.basicAuth) {
    const user = fillTemplate(preset.basicAuth.username, valuesByKey);
    const pass = fillTemplate(preset.basicAuth.password, valuesByKey);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return { headers, missing };
}

// 'data.viewer.name' → the value at that path, or null.
function valueAt(obj, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : null), obj) ?? null;
}

/**
 * The endpoint reference given to the AI that writes a fetch function for a
 * preset connection. Credentials are named by reference only — never a value.
 * `credentialRef(key)` says how the caller's generated code reaches a saved
 * value: a `{{PLACEHOLDER}}` token for a DataSource node, a
 * ctx.apiCredentials lookup for a chat run.
 */
function describePreset(preset, { credentialRef = (key) => `{${key}}`, mode = 'read' } = {}) {
  const refs = Object.fromEntries((preset.credentials || []).map((c) => [c.key, credentialRef(c.key)]));
  const headerLines = Object.entries(preset.headers || {})
    .map(([name, template]) => `- ${name}: ${fillTemplate(template, refs)}`)
    .join('\n');
  const basicLine = preset.basicAuth
    ? `HTTP Basic auth — pass axios the option auth: { username: '${fillTemplate(preset.basicAuth.username, refs)}', `
      + `password: '${fillTemplate(preset.basicAuth.password, refs)}' } on every request (do not build the header yourself).`
    : '';
  const baseLine = preset.baseUrl
    ? `Base URL: ${preset.baseUrl}`
    : `Base URL: set per account on this connection (e.g. ${preset.baseUrlPlaceholder}) — always start URLs with the base URL, never a guessed host`;
  const endpointLines = (preset.endpoints || []).map((e) => {
    const parts = [`- ${e.method || 'GET'} ${e.path}${e.operation ? ` (${e.operation})` : ''} — ${e.label}; rows: ${e.rows}`];
    if (e.params) parts.push(`  params: ${e.params}`);
    if (e.notes) parts.push(`  note: ${e.notes}`);
    return parts.join('\n');
  }).join('\n');
  const noteLines = (preset.notes || []).map((n) => `- ${n}`).join('\n');

  if (mode === 'write') {
    const writes = preset.writes || { endpoints: [], notes: [] };
    const writeLines = writes.endpoints.map((e) => {
      const parts = [`- ${e.method} ${e.path}${e.operation ? ` (${e.operation})` : ''} — ${e.label}; `
        + `up to ${e.batch} record${e.batch === 1 ? '' : 's'} per request; `
        + (e.upsert ? `matches existing records on ${e.upsert}` : 'creates new records (a re-run duplicates them)')];
      if (e.body) parts.push(`  body: ${e.body}`);
      if (e.notes) parts.push(`  note: ${e.notes}`);
      return parts.join('\n');
    }).join('\n');
    const writeNotes = (writes.notes || []).map((n) => `- ${n}`).join('\n');
    return [
      `${preset.title} API reference for WRITING (preset "${preset.id}"). ${baseLine}. Docs: ${preset.docsUrl}`,
      headerLines ? `Send these headers on every request:\n${headerLines}` : '',
      basicLine,
      writeLines ? `Write endpoints:\n${writeLines}` : `${preset.title} has no write endpoints in this reference.`,
      writeNotes ? `Notes:\n${writeNotes}` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    `${preset.title} API reference (preset "${preset.id}"). ${baseLine}. Docs: ${preset.docsUrl}`,
    headerLines ? `Send these headers on every request:\n${headerLines}` : '',
    basicLine,
    `Pagination: ${preset.pagination}`,
    // "response.data.data" in the pagination text once became
    // response.data.data.data in generated code — read as the body, plus one.
    'Paths: in the pagination text `response` is the axios response, so `response.data` IS the parsed JSON '
      + 'body — `response.data.data` is the body\'s own `data` field, never `response.data.data.data`. Each '
      + 'endpoint\'s "rows" names a field of that body.',
    `Endpoints:\n${endpointLines}`,
    noteLines ? `Notes:\n${noteLines}` : '',
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  PRESETS,
  getPreset,
  fillTemplate,
  resolveCredentialKeys,
  buildPresetHeaders,
  valueAt,
  describePreset,
};
