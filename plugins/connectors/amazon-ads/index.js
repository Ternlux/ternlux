/**
 * Amazon Ads connector — profiles, portfolios, Sponsored Products / Brands /
 * Display campaigns, ad groups, keywords and targets, and v3 reports.
 * Signs in with Login with Amazon using the user's own security profile,
 * which must be approved for the Amazon Ads API.
 *
 * Every call carries the app's client id header and, per advertiser, the
 * profile id as the Scope header. Reports are asynchronous and download as
 * gzipped JSON (tools.gunzip).
 *
 * API facts cross-checked against the Amazon Ads API docs and the Airbyte
 * source-amazon-ads manifest (regional hosts NA/EU/FE, token endpoint
 * api.amazon.com/auth/o2/token, Amazon-Advertising-API-ClientId and -Scope
 * headers, versioned v3 media types, reporting v3). n8n has no node for it.
 * No code from either project.
 */

const HOSTS = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const CONSENT = {
  NA: 'https://www.amazon.com/ap/oa',
  EU: 'https://eu.account.amazon.com/ap/oa',
  FE: 'https://apac.account.amazon.com/ap/oa',
};
const region = (c) => (HOSTS[c.region] ? c.region : 'NA');

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${config.baseUrl}/v2/profiles`);
  const profiles = Array.isArray(data) ? data : [];
  if (!profiles.length) return 'This Amazon login has no advertising profiles in this region.';
  return ['Advertising profiles (send the profileId as the Amazon-Advertising-API-Scope header):',
    ...profiles.map((p) => `- profile ${p.profileId} "${p.accountInfo?.name || ''}" ${p.countryCode} ${p.currencyCode} (${p.accountInfo?.type || ''})`)].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'amazon-ads',
  name: 'Amazon Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: (c) => CONSENT[region(c)],
    tokenUrl: 'https://api.amazon.com/auth/o2/token',
    scopes: ['advertising::campaign_management'],
    clientIdLabel: 'Login with Amazon client ID',
    clientIdHelp: 'developer.amazon.com → Login with Amazon → your security profile → Web Settings → Client ID.',
  },

  apiBaseUrl: (config) => HOSTS[region(config)],

  apiReference: {
    title: 'Amazon Ads API',
    docsUrl: 'https://advertising.amazon.com/API/docs/en-us/',
    baseUrl: null,
    baseUrlPlaceholder: 'https://advertising-api.amazon.com',
    headers: {
      Authorization: 'Bearer {accessToken}',
      'Amazon-Advertising-API-ClientId': '{clientId}',
    },
    test: { path: '/v2/profiles', identity: (d) => (Array.isArray(d) ? `${d.length} advertising profiles` : null) },
    pagination: 'v3 list endpoints (POST …/list): send maxResults (≤ 1000 for most) and repeat with nextToken=<response.data.nextToken> while set.',
    endpoints: [
      { method: 'GET', path: '/v2/profiles', label: 'Advertising profiles (one per marketplace and account)', rows: 'the body is the array' },
      { method: 'POST', path: '/sp/campaigns/list', label: 'Sponsored Products campaigns', rows: '`campaigns` array',
        params: 'body: { stateFilter?: { include: ["ENABLED","PAUSED"] }, maxResults, nextToken }; headers Content-Type and Accept: application/vnd.spCampaign.v3+json' },
      { method: 'POST', path: '/sp/adGroups/list', label: 'Sponsored Products ad groups', rows: '`adGroups` array', params: 'media type application/vnd.spAdGroup.v3+json' },
      { method: 'POST', path: '/sp/keywords/list', label: 'Sponsored Products keywords', rows: '`keywords` array', params: 'media type application/vnd.spKeyword.v3+json' },
      { method: 'POST', path: '/sp/targets/list', label: 'Sponsored Products product/category targets', rows: '`targetingClauses` array', params: 'media type application/vnd.spTargetingClause.v3+json' },
      { method: 'POST', path: '/sp/productAds/list', label: 'Sponsored Products ads', rows: '`productAds` array', params: 'media type application/vnd.spProductAd.v3+json' },
      { method: 'POST', path: '/sb/v4/campaigns/list', label: 'Sponsored Brands campaigns', rows: '`campaigns` array', params: 'media type application/vnd.sbcampaignresource.v4+json' },
      { method: 'GET', path: '/sd/campaigns', label: 'Sponsored Display campaigns', rows: 'the body is the array', params: 'startIndex, count' },
      { method: 'POST', path: '/portfolios/list', label: 'Portfolios', rows: '`portfolios` array', params: 'media type application/vnd.spPortfolio.v3+json' },
      { method: 'POST', path: '/reporting/reports', label: 'Create a v3 report (step 1 of 3)', rows: 'none — returns { reportId, status }',
        params: 'body: { name, startDate: "YYYY-MM-DD", endDate, configuration: { adProduct: "SPONSORED_PRODUCTS"|"SPONSORED_BRANDS"|"SPONSORED_DISPLAY", '
          + 'reportTypeId: "spCampaigns"|"spAdvertisedProduct"|"spTargeting"|"spSearchTerm"|"sbCampaigns"|"sdCampaigns", groupBy: ["campaign"], '
          + 'columns: ["date","campaignId","campaignName","impressions","clicks","cost","purchases7d","sales7d"], timeUnit: "DAILY"|"SUMMARY", format: "GZIP_JSON" } }; '
          + 'Content-Type: application/vnd.createasyncreportrequest.v3+json',
        notes: 'At most 31 days per report, and data is kept about 95 days. timeUnit DAILY needs the "date" column.' },
      { method: 'GET', path: '/reporting/reports/{reportId}', label: 'Report status (step 2 of 3)', rows: 'one object { status: "PENDING"|"PROCESSING"|"COMPLETED"|"FAILED", url }',
        notes: 'Reports take minutes; poll with tools.sleep(15000) and give up after ~30 minutes.' },
      { method: 'GET', path: '{url}', label: 'Download the report (step 3 of 3)',
        rows: 'gzipped JSON array — request with responseType "arraybuffer" and NO auth headers, then JSON.parse(tools.gunzip(data))' },
    ],
    notes: [
      'Every call except /v2/profiles needs the header Amazon-Advertising-API-Scope: <profileId> — add it per request (see the live account details).',
      'v3 endpoints need their versioned media type in BOTH Content-Type and Accept; a 415 means the media type is wrong.',
      'cost and sales are in the profile currency.',
      '429 means throttled: wait (tools.sleep) and retry.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads.'] },
  },

  getLiveContext,

  configSchema: {
    fields: [
      { name: 'region', type: 'select', label: 'Region', required: true, sensitive: false, default: 'NA',
        options: [
          { label: 'North America (US, CA, MX, BR)', value: 'NA' },
          { label: 'Europe, Middle East, India (UK, DE, FR, ES, IT, NL, SE, PL, TR, AE, SA, EG, IN)', value: 'EU' },
          { label: 'Far East (JP, AU, SG)', value: 'FE' },
        ],
        helpText: 'The region of the marketplaces you advertise in. One connection per region.' },
    ],
  },

  metadata: {
    displayName: 'Amazon Ads',
    description: 'Sponsored Products, Brands and Display campaigns, ad groups, keywords, targets and v3 reports',
    version: '1.0.0',
  },
};
