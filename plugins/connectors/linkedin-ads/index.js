/**
 * LinkedIn Ads connector — ad accounts, campaign groups, campaigns,
 * creatives and ad analytics by any pivot (campaign, creative, company,
 * job function, seniority, country…). Signs in with the user's own LinkedIn
 * app, which needs the Advertising API product approved.
 *
 * Access tokens last 60 days. LinkedIn issues refresh tokens only to apps it
 * has enabled for them; when one comes back it is used and saved, otherwise
 * the user clicks Authorize again after 60 days.
 *
 * API facts cross-checked against LinkedIn's Marketing API docs, the Airbyte
 * source-linkedin-ads manifest (https://api.linkedin.com/rest, LinkedIn-Version
 * 202601, X-Restli-Protocol-Version 2.0.0, OAuth endpoints, r_ads scopes) and
 * the n8n LinkedIn credential. No code from either project.
 */

const BASE = 'https://api.linkedin.com/rest';
const VERSION = '202601';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/adAccounts?q=search&pageSize=100`);
  const accts = data.elements || [];
  if (!accts.length) return 'This LinkedIn member has no ad accounts.';
  return ['Ad accounts (use the number in urn:li:sponsoredAccount:<id>):',
    ...accts.map((a) => `- ${a.id} "${a.name}" ${a.currency || ''} ${a.status || ''} ${a.type || ''}`.trim())].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'linkedin-ads',
  name: 'LinkedIn Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['r_ads', 'r_ads_reporting', 'r_basicprofile'],
    clientIdHelp: 'linkedin.com/developers → My apps → your app → Auth → Client ID. The app needs the Advertising API product.',
  },

  apiReference: {
    title: `LinkedIn Marketing API (versioned REST, ${VERSION})`,
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/',
    baseUrl: BASE,
    headers: {
      Authorization: 'Bearer {accessToken}',
      'LinkedIn-Version': VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    test: { path: '/adAccounts?q=search&pageSize=1', identity: (d) => (d.elements?.[0]?.name ? `ad account "${d.elements[0].name}"` : null) },
    pagination: 'Finders with pageSize return metadata.nextPageToken — request again with pageToken=<it> while set. '
      + 'Older finders use start and count (≤ 1000): request again with start += count while elements came back full.',
    endpoints: [
      { method: 'GET', path: '/adAccounts?q=search', label: 'Ad accounts', rows: '`elements` array',
        params: 'pageSize, pageToken, search=(status:(values:List(ACTIVE,DRAFT)))' },
      { method: 'GET', path: '/adAccounts/{accountId}/adCampaignGroups?q=search', label: 'Campaign groups', rows: '`elements` array', params: 'pageSize, pageToken' },
      { method: 'GET', path: '/adAccounts/{accountId}/adCampaigns?q=search', label: 'Campaigns', rows: '`elements` array',
        params: 'pageSize, pageToken, search=(status:(values:List(ACTIVE,PAUSED)))' },
      { method: 'GET', path: '/adAccounts/{accountId}/creatives?q=criteria', label: 'Creatives', rows: '`elements` array', params: 'pageSize, pageToken, campaigns=List(urn%3Ali%3AsponsoredCampaign%3A123)' },
      { method: 'GET', path: '/adAnalytics?q=analytics', label: 'Ad analytics (spend, impressions, clicks, conversions) by a pivot',
        rows: '`elements` array — each has pivotValues (URNs) and dateRange',
        params: 'pivot=CAMPAIGN|CAMPAIGN_GROUP|CREATIVE|ACCOUNT|MEMBER_COMPANY|MEMBER_JOB_FUNCTION|MEMBER_SENIORITY|MEMBER_COUNTRY_V2|MEMBER_INDUSTRY, '
          + 'timeGranularity=DAILY|MONTHLY|ALL, dateRange=(start:(year:2025,month:1,day:1),end:(year:2025,month:1,day:31)), '
          + 'accounts=List(urn%3Ali%3AsponsoredAccount%3A123) or campaigns=List(urn%3Ali%3AsponsoredCampaign%3A456), '
          + 'fields=dateRange,pivotValues,impressions,clicks,costInLocalCurrency,landingPageClicks,externalWebsiteConversions,oneClickLeads,videoViews',
        notes: 'Build this query string BY HAND and pass the full URL to axios (no axios params): Rest.li needs List(…) and (…) unescaped, '
          + 'while the URNs inside are URL-encoded (urn%3Ali%3AsponsoredAccount%3A123). At most 20 fields; MEMBER_* pivots hide small counts.' },
      { method: 'GET', path: '/adAnalytics?q=statistics', label: 'Ad analytics with up to 3 pivots at once', rows: '`elements` array', params: 'pivots=List(CAMPAIGN,MEMBER_COUNTRY_V2), plus the analytics params' },
      { method: 'GET', path: '/conversions?q=account', label: 'Conversion definitions', rows: '`elements` array', params: 'account=urn%3Ali%3AsponsoredAccount%3A123' },
    ],
    notes: [
      'Ids come back as numbers in some fields and URNs (urn:li:sponsoredCampaign:123) in others; keep the number after the last colon to join.',
      'costInLocalCurrency is a string in the account currency.',
      'A 426 or "version not supported" error means the LinkedIn-Version header is too old — it is set on the connection.',
      'Analytics data is retained for 2 years at most.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads (its scopes are read-only).'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'LinkedIn Ads',
    description: 'Ad accounts, campaigns, creatives and ad analytics by campaign, company, job function, seniority and country',
    version: '1.0.0',
  },
};
