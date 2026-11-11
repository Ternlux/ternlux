/**
 * TikTok Ads connector — advertisers, campaigns, ad groups, ads and the
 * integrated reports (basic and audience breakdowns, any dimensions and
 * metrics). Signs in with the user's own TikTok for Business developer app.
 *
 * TikTok's Marketing API sign-in is not standard OAuth: the consent page
 * takes app_id, the token exchange is a JSON POST with the app secret, and
 * the token it returns is long-lived (no refresh token). The token goes in
 * an Access-Token header. Its response lists the advertiser ids the user
 * granted, which are kept for the live context.
 *
 * API facts cross-checked against TikTok's Marketing API v1.3 docs and the
 * Airbyte source-tiktok-marketing manifest (open_api/v1.3 base, Access-Token
 * header, report/integrated/get, advertiser_ids from the token response).
 * n8n has no TikTok Ads node. No code from either project.
 */

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

function getAuthorizationUrl(config = {}) {
  if (!config.clientId) return { success: false, message: 'Enter the app ID first.' };
  const url = new URL('https://business-api.tiktok.com/portal/auth');
  url.searchParams.set('app_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri || 'http://localhost:3000/oauth/callback');
  if (config.state) url.searchParams.set('state', config.state);
  return { success: true, authUrl: url.toString() };
}

async function exchangeCodeForTokens(config = {}, code) {
  // eslint-disable-next-line global-require
  const axios = require('axios');
  try {
    const { data } = await axios.post(`${BASE}/oauth2/access_token/`, {
      app_id: config.clientId, secret: config.clientSecret, auth_code: code,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    if (data.code !== 0 || !data.data?.access_token) {
      return { success: false, message: data.message || `TikTok returned code ${data.code}` };
    }
    return {
      success: true,
      tokens: { accessToken: data.data.access_token, refreshToken: null, expiryDate: null },
      extra: { advertiserIds: (data.data.advertiser_ids || []).join(',') },
    };
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message };
  }
}

async function getLiveContext(config, { axios }) {
  const ids = String(config.advertiserIds || '').split(',').filter(Boolean);
  if (!ids.length) return 'No advertiser ids were granted at sign-in; reconnect and select the advertiser accounts.';
  const { data } = await axios.get(`${BASE}/advertiser/info/`, { params: { advertiser_ids: JSON.stringify(ids.slice(0, 100)) } });
  const list = data.data?.list || [];
  return ['Advertiser accounts granted to this connection (advertiser_id → name):',
    ...(list.length ? list.map((a) => `- ${a.advertiser_id} "${a.name}" ${a.currency || ''} ${a.timezone || ''}`) : ids.map((i) => `- ${i}`))].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'tiktok-ads',
  name: 'TikTok Ads',
  dbCategory: 'API',
  authType: 'oauth2',

  // Sign-in is TikTok's own flow (above); the generic OAuth fields still apply.
  oauth: {
    refresh: false,
    clientIdLabel: 'App ID',
    clientIdHelp: 'business-api.tiktok.com/portal → My Apps → your app → Basic Information → App ID.',
    clientSecretLabel: 'App secret',
  },
  getAuthorizationUrl,
  exchangeCodeForTokens,

  apiReference: {
    title: 'TikTok Marketing API v1.3',
    docsUrl: 'https://business-api.tiktok.com/portal/docs',
    baseUrl: BASE,
    headers: { 'Access-Token': '{accessToken}', 'Content-Type': 'application/json' },
    test: { path: '/user/info/', identity: (d) => (d.code === 0 ? (d.data?.display_name || d.data?.email) : null) },
    pagination: 'Send page (from 1) and page_size (≤ 1000); read response.data.data.page_info.total_page and request until page > total_page.',
    endpoints: [
      { method: 'GET', path: '/report/integrated/get/', label: 'Report — spend, impressions, clicks, conversions by any dimensions',
        rows: '`data.list` array — each { dimensions: {…}, metrics: {…} }; merge the two into one row',
        params: 'advertiser_id, report_type=BASIC|AUDIENCE, data_level=AUCTION_ADVERTISER|AUCTION_CAMPAIGN|AUCTION_ADGROUP|AUCTION_AD, '
          + 'dimensions=["campaign_id","stat_time_day"] (JSON-encoded), metrics=["spend","impressions","clicks","ctr","cpc","conversion","cost_per_conversion"] (JSON-encoded), '
          + 'start_date=YYYY-MM-DD, end_date=YYYY-MM-DD, page, page_size',
        notes: 'stat_time_day ranges are at most 30 days per request — loop over windows. AUDIENCE reports add dimensions like gender, age, country_code, platform. '
          + 'Metric values are strings.' },
      { method: 'GET', path: '/campaign/get/', label: 'Campaigns', rows: '`data.list` array', params: 'advertiser_id, page, page_size, filtering={"primary_status":"STATUS_DELIVERY_OK"} (JSON)' },
      { method: 'GET', path: '/adgroup/get/', label: 'Ad groups', rows: '`data.list` array', params: 'advertiser_id, page, page_size' },
      { method: 'GET', path: '/ad/get/', label: 'Ads', rows: '`data.list` array', params: 'advertiser_id, page, page_size' },
      { method: 'GET', path: '/advertiser/info/', label: 'Advertiser account details', rows: '`data.list` array', params: 'advertiser_ids=["…"] (JSON-encoded)' },
      { method: 'GET', path: '/dmp/custom_audience/list/', label: 'Custom audiences', rows: '`data.list` array', params: 'advertiser_id, page, page_size' },
    ],
    notes: [
      'IMPORTANT: TikTok answers HTTP 200 even on errors. Check response.data.code — anything but 0 is an error; throw with response.data.message.',
      'Array and object query parameters (dimensions, metrics, filtering, advertiser_ids) are JSON strings: JSON.stringify([...]).',
      'Every call needs the advertiser_id of one of the advertisers granted at sign-in (see the live account details).',
    ],
    writes: { endpoints: [], notes: ['This connector only reads.'] },
  },

  getLiveContext,

  configSchema: {
    fields: [{ name: 'advertiserIds', type: 'hidden', label: 'Granted advertiser ids', required: false, sensitive: false }],
  },

  metadata: {
    displayName: 'TikTok Ads',
    description: 'Campaigns, ad groups, ads and reports by any dimensions — spend, impressions, clicks, conversions, audience breakdowns',
    version: '1.0.0',
  },
};
