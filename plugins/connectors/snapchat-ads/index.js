/**
 * Snapchat Ads connector — organizations, ad accounts, campaigns, ad
 * squads, ads, creatives, audiences and stats at every level. Signs in with
 * the user's own Snap Business app (Marketing API).
 *
 * Access tokens last 30 minutes; refreshes are saved by the app's token store.
 *
 * API facts cross-checked against Snap's Marketing API docs and the Airbyte
 * source-snapchat-marketing manifest (https://adsapi.snapchat.com/v1/, token
 * endpoint, entity and stats streams, hourly/daily/lifetime granularity).
 * n8n has no Snapchat node. No code from either project.
 */

const BASE = 'https://adsapi.snapchat.com/v1';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/me/organizations`, { params: { with_ad_accounts: true } });
  const orgs = (data.organizations || []).map((o) => o.organization).filter(Boolean);
  if (!orgs.length) return 'This Snapchat login belongs to no organization.';
  const lines = ['Organizations and ad accounts (use the ids in paths):'];
  for (const o of orgs) {
    lines.push(`- organization ${o.id} "${o.name}"`);
    for (const a of o.ad_accounts || []) lines.push(`  - ad account ${a.id} "${a.name}" ${a.currency || ''} ${a.timezone || ''} ${a.status || ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'snapchat-ads',
  name: 'Snapchat Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.snapchat.com/login/oauth2/authorize',
    tokenUrl: 'https://accounts.snapchat.com/login/oauth2/access_token',
    scopes: ['snapchat-marketing-api'],
    clientIdLabel: 'OAuth client ID',
    clientIdHelp: 'business.snapchat.com → Business Details → OAuth Apps → your app → Snap Client ID.',
    clientSecretLabel: 'OAuth client secret',
  },

  apiReference: {
    title: 'Snap Marketing API v1',
    docsUrl: 'https://developers.snap.com/api/marketing-api/Ads-API/introduction',
    baseUrl: BASE,
    headers: { Authorization: 'Bearer {accessToken}' },
    test: { path: '/me', identity: (d) => d.me?.email || d.me?.display_name },
    pagination: 'Send limit (50–1000); while response.data.paging.next_link is set, GET that full URL.',
    endpoints: [
      { method: 'GET', path: '/me/organizations', label: 'Organizations (with their ad accounts)', rows: '`organizations` array — each { organization }', params: 'with_ad_accounts=true' },
      { method: 'GET', path: '/organizations/{organizationId}/adaccounts', label: 'Ad accounts', rows: '`adaccounts` array — each { adaccount }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/campaigns', label: 'Campaigns', rows: '`campaigns` array — each { campaign }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/adsquads', label: 'Ad squads (ad sets)', rows: '`adsquads` array — each { adsquad }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/ads', label: 'Ads', rows: '`ads` array — each { ad }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/creatives', label: 'Creatives', rows: '`creatives` array — each { creative }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/segments', label: 'Audience segments', rows: '`segments` array — each { segment }' },
      { method: 'GET', path: '/adaccounts/{adAccountId}/stats', label: 'Stats for the account, or broken down by campaign / ad squad / ad',
        rows: '`timeseries_stats` (or `total_stats`) — each { timeseries_stat: { id, breakdown_stats?, timeseries: [{ start_time, end_time, stats }] } }',
        params: 'granularity=DAY|HOUR|TOTAL|LIFETIME, start_time, end_time (ISO-8601 with the ad account\'s timezone offset, on day boundaries), '
          + 'fields=impressions,swipes,spend,video_views,conversion_purchases,conversion_purchases_value, breakdown=campaign|adsquad|ad',
        notes: 'start_time/end_time must fall on midnight in the ad account\'s timezone for DAY granularity (e.g. 2025-01-01T00:00:00-08:00). '
          + 'At most 31 days per request for DAY; flatten timeseries into one row per id and day.' },
      { method: 'GET', path: '/campaigns/{campaignId}/stats', label: 'Stats for one campaign (also /adsquads/{id}/stats, /ads/{id}/stats)', rows: '`timeseries_stats` array', params: 'same as above' },
    ],
    notes: [
      'Every list wraps each item: { campaigns: [{ sub_request_status, campaign: {…} }] } — unwrap item.campaign.',
      'spend and *_value fields are in micro-currency: divide by 1e6.',
      'request_status "ERROR" with debug_message explains a bad request even on HTTP 200 for some calls; check it.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads.'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'Snapchat Ads',
    description: 'Ad accounts, campaigns, ad squads, ads and creatives, with daily, hourly and lifetime stats',
    version: '1.0.0',
  },
};
