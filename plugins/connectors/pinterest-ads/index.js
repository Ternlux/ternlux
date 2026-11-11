/**
 * Pinterest Ads connector — ad accounts, campaigns, ad groups, ads and their
 * analytics, async reports, audiences and conversion tags, plus boards and
 * pins with their analytics. Signs in with the user's own Pinterest app.
 *
 * Pinterest's token endpoint takes the client id and secret as HTTP Basic
 * auth. Access tokens last about 30 days and refresh tokens about a year;
 * refreshes are saved by the app's token store.
 *
 * API facts cross-checked against Pinterest's API v5 docs and the Airbyte
 * source-pinterest manifest (https://api.pinterest.com/v5/, token refresh
 * endpoint, bookmark paging, analytics and async report streams). n8n has no
 * Pinterest node. No code from either project.
 */

const BASE = 'https://api.pinterest.com/v5';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/ad_accounts`, { params: { page_size: 100 } });
  const accts = data.items || [];
  if (!accts.length) return 'This Pinterest login has no ad accounts (boards and pins can still be read).';
  return ['Ad accounts (ad_account_id → name):', ...accts.map((a) => `- ${a.id} "${a.name}" ${a.currency || ''} ${a.country || ''}`)].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'pinterest-ads',
  name: 'Pinterest Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    scopes: ['ads:read', 'boards:read', 'pins:read', 'user_accounts:read', 'catalogs:read'],
    scopeSeparator: ',',
    clientAuth: 'basic',
    clientIdLabel: 'App ID',
    clientIdHelp: 'developers.pinterest.com → My apps → your app → App ID.',
    clientSecretLabel: 'App secret key',
  },

  apiReference: {
    title: 'Pinterest API v5',
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/',
    baseUrl: BASE,
    headers: { Authorization: 'Bearer {accessToken}', 'Content-Type': 'application/json' },
    test: { path: '/user_account', identity: (d) => d.username },
    pagination: 'Lists return { items, bookmark }; send page_size (≤ 250, ads endpoints ≤ 250) and repeat with bookmark=<it> while bookmark is set.',
    endpoints: [
      { method: 'GET', path: '/ad_accounts', label: 'Ad accounts', rows: '`items` array' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/campaigns', label: 'Campaigns', rows: '`items` array', params: 'entity_statuses=ACTIVE,PAUSED, page_size, bookmark' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/ad_groups', label: 'Ad groups', rows: '`items` array', params: 'campaign_ids, page_size, bookmark' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/ads', label: 'Ads', rows: '`items` array', params: 'campaign_ids, ad_group_ids, page_size, bookmark' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/analytics', label: 'Ad account analytics by day', rows: 'array (the body itself)',
        params: 'start_date, end_date (YYYY-MM-DD, ≤ 90 days apart), columns=SPEND_IN_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1,CTR,TOTAL_CONVERSIONS,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR, granularity=DAY|WEEK|MONTH|TOTAL' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/campaigns/analytics', label: 'Campaign analytics', rows: 'array (the body itself)',
        params: 'start_date, end_date, campaign_ids=<up to 250 ids, comma-separated, required>, columns, granularity' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/ad_groups/analytics', label: 'Ad group analytics', rows: 'array', params: 'ad_group_ids (required), start_date, end_date, columns, granularity' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/ads/analytics', label: 'Ad analytics', rows: 'array', params: 'ad_ids (required), start_date, end_date, columns, granularity' },
      { method: 'POST', path: '/ad_accounts/{adAccountId}/reports', label: 'Async report (many entities, targeting breakdowns)',
        rows: 'none — returns { token }; poll GET /ad_accounts/{adAccountId}/reports?token=<it> until report_status is "FINISHED", then GET its url',
        params: 'body: { start_date, end_date, granularity: "DAY", columns: [...], level: "CAMPAIGN"|"AD_GROUP"|"AD"|"PIN_PROMOTION", report_format: "JSON" }',
        notes: 'Download the url without auth headers; JSON reports are keyed by entity id. Wait with tools.sleep(5000) between polls.' },
      { method: 'GET', path: '/ad_accounts/{adAccountId}/audiences', label: 'Audiences', rows: '`items` array' },
      { method: 'GET', path: '/boards', label: 'Your boards', rows: '`items` array' },
      { method: 'GET', path: '/boards/{boardId}/pins', label: 'Pins on a board', rows: '`items` array' },
      { method: 'GET', path: '/pins/{pinId}/analytics', label: 'Pin analytics (organic)', rows: 'object keyed by metric', params: 'start_date, end_date, metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK' },
      { method: 'GET', path: '/user_account/analytics', label: 'Account analytics (organic)', rows: 'object', params: 'start_date, end_date (≤ 90 days)' },
    ],
    notes: [
      'Money columns ending _IN_MICRO_DOLLAR are micros (divide by 1e6); SPEND_IN_DOLLAR is dollars.',
      'Analytics endpoints allow 90 days per request and about 2 years back — loop over windows.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads (its scopes are read-only).'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'Pinterest Ads',
    description: 'Ad accounts, campaigns, ad groups, ads and their analytics; boards, pins and organic analytics',
    version: '1.0.0',
  },
};
