/**
 * Calendly API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'calendly',
  title: 'Calendly',
  description: 'Scheduled events, invitees, event types, users and organization memberships.',
  docsUrl: 'https://developer.calendly.com/api-docs',
  baseUrl: 'https://api.calendly.com',

  credentials: [
    {
      key: 'Personal access token',
      label: 'Personal access token',
      placeholder: 'eyJraWQi…',
      helpText: 'Calendly → Integrations & apps → API and webhooks → Generate new token.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Personal access token}',
  },

  test: { path: '/users/me', identityField: 'resource.name' },

  pagination: 'Send count (max 100). While response.data.pagination.next_page_token is set, request again with '
    + 'page_token=<it> (or follow pagination.next_page, a full URL).',

  endpoints: [
    { path: '/users/me', rows: '`resource` object', label: 'The token\'s user and organization URIs', notes: 'Call this first: most lists need user=<resource.uri> or organization=<resource.current_organization>.' },
    { path: '/scheduled_events', rows: '`collection` array', label: 'Scheduled events (meetings)', params: 'organization or user (one required), count, page_token, status=active|canceled, min_start_time, max_start_time (ISO-8601), sort=start_time:asc' },
    { path: '/scheduled_events/{uuid}/invitees', rows: '`collection` array', label: 'Invitees of an event', params: 'count, page_token, status, email', notes: 'uuid is the last segment of the event uri.' },
    { path: '/event_types', rows: '`collection` array', label: 'Event types', params: 'organization or user, count, page_token, active' },
    { path: '/organization_memberships', rows: '`collection` array', label: 'Organization members', params: 'organization, count, page_token' },
    { path: '/routing_forms', rows: '`collection` array', label: 'Routing forms', params: 'organization, count, page_token' },
    { path: '/routing_form_submissions', rows: '`collection` array', label: 'Routing form submissions', params: 'form (routing form uri), count, page_token' },
  ],

  notes: [
    'Resources are identified by full URIs (https://api.calendly.com/users/…); pass them as-is in user / organization params.',
  ],
};
