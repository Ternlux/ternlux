/**
 * Google Search Console connector — search performance (clicks, impressions,
 * CTR, position by query, page, country, device, date), sitemaps and URL
 * inspection, via the user's own Google OAuth client.
 *
 * API facts cross-checked against Google's Search Console API docs and the
 * Airbyte source-google-search-console manifest (base URL, OAuth endpoints,
 * searchAnalytics paging by startRow, 25,000-row pages). n8n has no node for
 * it. No code from either project.
 */

const BASE = 'https://www.googleapis.com/webmasters/v3';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/sites`);
  const sites = (data.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  if (!sites.length) return 'This Google account has no verified Search Console properties.';
  return ['Search Console properties this account can read (use the exact siteUrl, URL-encoded in paths):',
    ...sites.map((s) => `- ${s.siteUrl} (${s.permissionLevel})`)].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'google-search-console',
  name: 'Google Search Console',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    pkce: true,
    clientIdLabel: 'Google OAuth client ID',
    clientIdHelp: 'Google Cloud console → APIs & Services → Credentials → your OAuth client. Enable the "Google Search Console API" in the same project.',
  },

  apiReference: {
    title: 'Google Search Console API',
    docsUrl: 'https://developers.google.com/webmaster-tools/v1/api_reference_index',
    baseUrl: BASE,
    headers: { Authorization: 'Bearer {accessToken}', 'Content-Type': 'application/json' },
    test: { path: '/sites', identity: (d) => `${(d.siteEntry || []).length} properties visible` },
    pagination: 'searchAnalytics/query: send rowLimit (max 25000) and startRow; request again with startRow += rowLimit '
      + 'while the response returned rowLimit rows. Other lists return everything in one response.',
    endpoints: [
      { method: 'POST', path: '/sites/{siteUrl}/searchAnalytics/query', label: 'Search performance (clicks, impressions, CTR, position)',
        rows: '`rows` array — each { keys: [values in dimension order], clicks, impressions, ctr, position }',
        params: 'body: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", dimensions: ["date","query","page","country","device","searchAppearance"], '
          + 'type: "web"|"image"|"video"|"news"|"discover"|"googleNews", dimensionFilterGroups?: [{ filters: [{ dimension: "query", operator: "contains", expression: "shoes" }] }], '
          + 'aggregationType?: "auto"|"byPage"|"byProperty", dataState?: "final"|"all", rowLimit, startRow }',
        notes: 'siteUrl must be URL-encoded in the path: encodeURIComponent("https://example.com/") or encodeURIComponent("sc-domain:example.com"). '
          + 'Map keys[i] back to the dimension names you asked for.' },
      { method: 'GET', path: '/sites', label: 'Properties the account can see', rows: '`siteEntry` array (siteUrl, permissionLevel)' },
      { method: 'GET', path: '/sites/{siteUrl}/sitemaps', label: 'Submitted sitemaps and their status', rows: '`sitemap` array' },
      { method: 'POST', path: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', label: 'Inspect one URL (index status, coverage, mobile usability)',
        rows: 'one object: `inspectionResult`', params: 'body: { inspectionUrl, siteUrl, languageCode? } — one URL per call, about 2,000 calls a day per property' },
    ],
    notes: [
      'Data is available for about the last 16 months and lags 2–3 days; dataState "all" includes fresher, still-changing data.',
      'Filtering or grouping by query hides anonymised queries, so totals by query are lower than totals by date.',
      'ctr is a fraction (0.034 = 3.4%); position is the average ranking.',
      '403 = the signed-in user is not a user of that property, or the siteUrl does not match exactly (http vs https, trailing slash, sc-domain:).',
    ],
    writes: { endpoints: [], notes: ['Search Console cannot receive rows through this connector.'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'Google Search Console',
    description: 'Clicks, impressions, CTR and position by query, page, country and device — via your own Google OAuth client',
    version: '1.0.0',
  },
};
