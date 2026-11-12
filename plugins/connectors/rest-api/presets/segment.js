/**
 * Segment API preset (Public API for workspace metadata and usage; HTTP
 * Tracking API to send events).
 *
 * Segment's API does not return your event data — that lives in your
 * warehouse or destinations. Facts cross-checked against Segment's Public API
 * and Tracking API docs, the Airbyte source-segment manifest
 * (api.segmentapis.com, Bearer token, pagination.cursor, sources /
 * destinations / warehouses / usage streams) and the n8n Segment node
 * (identify, track, group). Only facts about the vendor's API are recorded.
 */

module.exports = {
  id: 'segment',
  title: 'Segment',
  description: 'Workspace sources, destinations, warehouses, tracking plans, audit events and API-call / MTU usage; send identify, track and group calls.',
  docsUrl: 'https://docs.segmentapis.com/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://api.segmentapis.com',
  baseUrlHelp: 'https://api.segmentapis.com, or https://eu1.api.segmentapis.com for an EU workspace.',

  credentials: [
    { key: 'Public API token', label: 'Public API token', placeholder: 'sgp_…', helpText: 'Segment → Settings → Workspace settings → Access Management → Tokens → Create token (Workspace Member, read-only).' },
    { key: 'Write key', label: 'Source write key (for sending events)', placeholder: 'write key', optional: true,
      helpText: 'Only to send rows: Connections → Sources → your HTTP API source → Settings → API Keys → Write Key.' },
  ],

  headers: { Authorization: 'Bearer {Public API token}', Accept: 'application/json' },

  test: { path: '/sources?pagination.count=1', identityField: 'data.sources.0.name' },

  pagination: 'Send pagination.count (≤ 200); while response.data.data.pagination.next is set, request again with pagination.cursor=<it>.',

  endpoints: [
    { path: '/sources', rows: '`data.sources` array', label: 'Sources', params: 'pagination.count, pagination.cursor' },
    { path: '/destinations', rows: '`data.destinations` array', label: 'Destinations' },
    { path: '/warehouses', rows: '`data.warehouses` array', label: 'Warehouses' },
    { path: '/tracking-plans', rows: '`data.trackingPlans` array', label: 'Tracking plans' },
    { path: '/usage/api-calls/daily', rows: '`data.dailyWorkspaceAPICallsUsage` array', label: 'Daily API calls (billing usage)', params: 'period=YYYY-MM-DD (start of the billing month)' },
    { path: '/usage/mtu/daily', rows: '`data.dailyWorkspaceMTUUsage` array', label: 'Daily monthly-tracked-users usage', params: 'period=YYYY-MM-DD' },
    { path: '/audit-events', rows: '`data.events` array', label: 'Audit trail', params: 'startTime, endTime, pagination.count' },
  ],

  notes: ['Segment\'s Public API is metadata only; to analyse events, connect the warehouse Segment loads them into.'],

  writes: {
    endpoints: [
      { method: 'POST', path: 'https://api.segment.io/v1/batch', label: 'Send identify / track / group calls (batch)', batch: 100, upsert: 'messageId (deduplicated)',
        body: '{ batch: [{ type: "identify", userId, traits: { email, plan } }, { type: "track", userId, event: "Order Completed", properties: { revenue }, timestamp, messageId }] }',
        notes: 'Auth is HTTP Basic with the WRITE KEY as username and an empty password: Authorization: "Basic " + Buffer.from(`${write key}:`).toString("base64"). '
          + 'EU workspaces: https://events.eu1.segmentapis.com/v1/batch. Each batch ≤ 500 KB.' },
    ],
    notes: ['Sending rows needs the Write key field filled on the connection.'],
  },
};
