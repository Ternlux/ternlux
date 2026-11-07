/**
 * Typeform API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'typeform',
  title: 'Typeform',
  description: 'Forms, responses and workspaces.',
  docsUrl: 'https://www.typeform.com/developers/',
  baseUrl: 'https://api.typeform.com',

  credentials: [
    {
      key: 'Personal access token',
      label: 'Personal access token',
      placeholder: 'tfp_…',
      helpText: 'Typeform → your profile → Your settings → Personal tokens → Generate a new token (scopes: forms:read, responses:read, workspaces:read).',
    },
  ],

  headers: {
    Authorization: 'Bearer {Personal access token}',
  },

  test: { path: '/me', identityField: 'alias' },

  pagination: 'Forms and workspaces: page (from 1) and page_size (max 200) until page reaches response.data.page_count. '
    + 'Responses: page_size (max 1000), then before=<token of the last item> until a page comes back empty.',

  endpoints: [
    { path: '/forms', rows: '`items` array', label: 'Forms', params: 'page, page_size, search, workspace_id' },
    { path: '/forms/{form_id}', rows: 'single object', label: 'One form with its fields (questions)', notes: 'Use fields[].id / title to name answers.' },
    { path: '/forms/{form_id}/responses', rows: '`items` array', label: 'Responses to a form', params: 'page_size, before, since / until (ISO-8601), completed=true|false, sort=submitted_at,desc', notes: 'Each response has answers[] keyed by field.id with a type-specific value (text, choice.label, number, email…) — turn them into one column per question.' },
    { path: '/workspaces', rows: '`items` array', label: 'Workspaces', params: 'page, page_size' },
  ],

  notes: [
    'Response lists return at most 1,000 per page; for large forms use since/until windows.',
  ],
};
