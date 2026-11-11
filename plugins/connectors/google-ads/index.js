/**
 * Google Ads connector — any GAQL report (campaigns, ad groups, ads,
 * keywords, search terms, conversions, geo, devices…) and offline conversion
 * uploads, via the user's own Google OAuth client and Google Ads API access.
 *
 * Needs a developer token (Google Ads API Center) or, since September 2026,
 * API access granted to the Cloud project — the header is sent when the
 * field is filled. login-customer-id is the manager account when the client
 * accounts sit under one.
 *
 * API facts cross-checked against Google's Google Ads API REST docs, the
 * Airbyte source-google-ads docs (API v23 since April 2026, streams as GAQL
 * resources) and the n8n Google Ads node (campaign list via GAQL). No code
 * from either project.
 */

const VERSION = 'v23';
const BASE = `https://googleads.googleapis.com/${VERSION}`;

const digits = (v) => String(v || '').replace(/\D/g, '');

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/customers:listAccessibleCustomers`);
  const ids = (data.resourceNames || []).map((r) => r.replace('customers/', ''));
  if (!ids.length) return 'This Google account has access to no Google Ads accounts.';
  const lines = ['Google Ads accounts this login can reach directly (customer id → name):'];
  for (const id of ids.slice(0, 25)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data: rows } = await axios.post(`${BASE}/customers/${id}/googleAds:searchStream`, {
        query: 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 1',
      }, { headers: { 'login-customer-id': id } });
      const c = rows?.[0]?.results?.[0]?.customer || {};
      lines.push(`- ${id} "${c.descriptiveName || ''}"${c.manager ? ' (MANAGER — list its clients with customer_client)' : ''} ${c.currencyCode || ''} ${c.timeZone || ''}`.trim());
    } catch (err) {
      lines.push(`- ${id} (details unavailable: HTTP ${err.response?.status || '?'})`);
    }
  }
  if (config.loginCustomerId) lines.push(`login-customer-id (manager) sent on every request: ${digits(config.loginCustomerId)}`);
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'google-ads',
  name: 'Google Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    pkce: true,
    clientIdLabel: 'Google OAuth client ID',
    clientIdHelp: 'Google Cloud console → APIs & Services → Credentials. Enable the "Google Ads API" in the same project.',
  },

  apiReference: {
    title: `Google Ads API (${VERSION})`,
    docsUrl: 'https://developers.google.com/google-ads/api/rest/overview',
    baseUrl: BASE,
    headers: {
      Authorization: 'Bearer {accessToken}',
      'developer-token': '{developerToken}',
      'login-customer-id': '{loginCustomerId}',
      'Content-Type': 'application/json',
    },
    test: { path: '/customers:listAccessibleCustomers', identity: (d) => `${(d.resourceNames || []).length} accessible accounts` },
    pagination: 'searchStream returns every row in one response: an ARRAY of batches, each { results: [...] } — flatten them. '
      + '(search instead pages with nextPageToken, 10,000 rows a page.)',
    endpoints: [
      { method: 'POST', path: '/customers/{customerId}/googleAds:searchStream', label: 'Run a GAQL query (any report)',
        rows: 'array of batches; rows are batches[i].results[] with camelCase nested objects (campaign.name, metrics.costMicros, segments.date)',
        params: 'body: { query: "SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, '
          + 'metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS" }',
        notes: 'customerId is 10 digits without dashes. GAQL fields are snake_case in the query and camelCase in the response.' },
      { method: 'GET', path: '/customers:listAccessibleCustomers', label: 'Accounts this login can reach', rows: '`resourceNames` array ("customers/1234567890")' },
      { method: 'POST', path: '/customers/{customerId}/googleAds:search', label: 'GAQL with paging (nextPageToken)', rows: '`results` array', params: 'body: { query, pageToken? }' },
    ],
    notes: [
      'Common resources: customer, campaign, ad_group, ad_group_ad, ad_group_criterion (keywords), keyword_view, search_term_view, '
        + 'campaign_budget, geographic_view, user_location_view, shopping_performance_view, conversion_action, customer_client (a manager\'s accounts).',
      'Money is in micros: metrics.cost_micros / 1e6 is the cost in account currency. ctr is a fraction.',
      'Date filters: segments.date DURING LAST_7_DAYS|LAST_30_DAYS|THIS_MONTH|LAST_MONTH, or segments.date BETWEEN \'2025-01-01\' AND \'2025-01-31\'. '
        + 'A query that selects segments.date must also filter on it.',
      'Under a manager account: query the client\'s customerId and send login-customer-id = the manager id (set on the connection).',
      'Errors: DEVELOPER_TOKEN_NOT_APPROVED = the token only works on test accounts; USER_PERMISSION_DENIED = wrong login-customer-id; '
        + 'the error body\'s details[].errors[].message names the bad field.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/customers/{customerId}:uploadClickConversions', label: 'Upload offline click conversions (from your CRM)', batch: 2000, upsert: null,
          body: '{ conversions: [{ gclid, conversionAction: "customers/{customerId}/conversionActions/{id}", conversionDateTime: "2025-01-31 14:05:00+00:00", '
            + 'conversionValue?, currencyCode? }], partialFailure: true }',
          notes: 'Find the conversionAction id with GAQL: SELECT conversion_action.id, conversion_action.name FROM conversion_action. '
            + 'With partialFailure the response\'s partialFailureError lists the failed indexes.' },
        { method: 'POST', path: '/customers/{customerId}:uploadCallConversions', label: 'Upload offline call conversions', batch: 2000, upsert: null,
          body: '{ conversions: [{ callerId, callStartDateTime, conversionAction, conversionDateTime, conversionValue? }], partialFailure: true }' },
      ],
      notes: [
        'Conversions are not deduplicated by the API on re-runs — keep the same orderId per conversion to let Google drop duplicates.',
        'conversionDateTime needs a timezone offset (yyyy-mm-dd hh:mm:ss+|-hh:mm) and must be after the click.',
      ],
    },
  },

  getLiveContext,

  configSchema: {
    fields: [
      { name: 'developerToken', type: 'password', label: 'Developer token', required: false, sensitive: true,
        helpText: 'Google Ads → Tools → API Center. Leave blank only if your Cloud project was granted API access directly.' },
      { name: 'loginCustomerId', type: 'string', label: 'Manager account id (login-customer-id)', required: false, sensitive: false,
        placeholder: '1234567890', helpText: 'Only when your accounts are under a manager (MCC) account: its id, digits only.' },
    ],
  },

  metadata: {
    displayName: 'Google Ads',
    description: 'Any GAQL report — campaigns, ads, keywords, search terms, conversions — and offline conversion uploads',
    version: '1.0.0',
  },
};
