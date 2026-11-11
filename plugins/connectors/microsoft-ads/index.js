/**
 * Microsoft Advertising (Bing Ads) connector — accounts, campaigns, ad
 * groups, ads, keywords and every performance report, through the Bing Ads
 * API v13 REST (JSON) services. Signs in with the user's own Microsoft Entra
 * app; needs a Microsoft Advertising developer token.
 *
 * Reports are asynchronous: submit, poll, then download a ZIP holding one CSV
 * (tools.unzip + tools.parseCsv). Microsoft rotates refresh tokens; the app's
 * token store saves each one.
 *
 * API facts cross-checked against Microsoft's Bing Ads API v13 docs and the
 * Airbyte source-bing-ads manifest (REST hosts for CustomerManagement,
 * CampaignManagement and Reporting; DeveloperToken / CustomerId /
 * CustomerAccountId headers; msads.manage scope; GenerateReport/Submit and
 * Poll; zipped CSV downloads). n8n has no node for it. No code from either
 * project.
 */

const CM = 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13';
const CAMPAIGN = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13';
const REPORTING = 'https://reporting.api.bingads.microsoft.com/Reporting/v13';

async function getLiveContext(config, { axios }) {
  const headers = { 'Content-Type': 'application/json' };
  const { data: me } = await axios.post(`${CM}/User/Query`, { UserId: null }, { headers });
  const userId = me.User?.Id;
  const { data } = await axios.post(`${CM}/Accounts/Search`, {
    Predicates: [{ Field: 'UserId', Operator: 'Equals', Value: String(userId) }],
    Ordering: null,
    PageInfo: { Index: 0, Size: 1000 },
  }, { headers });
  const accts = data.Accounts || [];
  if (!accts.length) return 'This Microsoft Advertising user can see no ad accounts.';
  return ['Ad accounts (send CustomerAccountId = account Id and CustomerId = its ParentCustomerId on campaign and report calls):',
    ...accts.map((a) => `- account ${a.Id} "${a.Name}" (customer ${a.ParentCustomerId}) ${a.CurrencyCode || ''} ${a.AccountLifeCycleStatus || ''}`)].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'microsoft-ads',
  name: 'Microsoft Advertising',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['https://ads.microsoft.com/msads.manage', 'offline_access'],
    pkce: true,
    clientIdLabel: 'Application (client) ID',
    clientIdHelp: 'Microsoft Entra admin center → App registrations → your app (accounts in any organizational directory and personal Microsoft accounts).',
  },

  apiReference: {
    title: 'Microsoft Advertising (Bing Ads API v13, REST)',
    docsUrl: 'https://learn.microsoft.com/en-us/advertising/guides/',
    baseUrl: CAMPAIGN,
    headers: {
      Authorization: 'Bearer {accessToken}',
      DeveloperToken: '{developerToken}',
      'Content-Type': 'application/json',
    },
    test: { path: `${CM}/User/Query`, method: 'POST', body: { UserId: null }, identity: (d) => d.User?.UserName || d.User?.Name?.FirstName },
    pagination: 'Search operations take PageInfo { Index, Size ≤ 1000 }; request the next Index while a page came back full. Reports have no paging.',
    endpoints: [
      { method: 'POST', path: `${CM}/User/Query`, label: 'The signed-in user (its Id)', rows: '`User` object', params: 'body: { UserId: null }' },
      { method: 'POST', path: `${CM}/Accounts/Search`, label: 'Ad accounts of the user', rows: '`Accounts` array (Id, Name, ParentCustomerId, CurrencyCode)',
        params: 'body: { Predicates: [{ Field: "UserId", Operator: "Equals", Value: "<user id>" }], Ordering: null, PageInfo: { Index: 0, Size: 1000 } }' },
      { method: 'POST', path: '/Campaigns/QueryByAccountId', label: 'Campaigns', rows: '`Campaigns` array',
        params: 'body: { AccountId, CampaignType: "Search Shopping Audience PerformanceMax" }; headers CustomerAccountId, CustomerId' },
      { method: 'POST', path: '/AdGroups/QueryByCampaignId', label: 'Ad groups of a campaign', rows: '`AdGroups` array', params: 'body: { CampaignId }' },
      { method: 'POST', path: '/Ads/QueryByAdGroupId', label: 'Ads of an ad group', rows: '`Ads` array', params: 'body: { AdGroupId, AdTypes: ["ResponsiveSearch","ExpandedText","ResponsiveAd"] }' },
      { method: 'POST', path: '/Keywords/QueryByAdGroupId', label: 'Keywords of an ad group', rows: '`Keywords` array', params: 'body: { AdGroupId }' },
      { method: 'POST', path: `${REPORTING}/GenerateReport/Submit`, label: 'Submit a performance report (step 1 of 3)',
        rows: 'none — returns { ReportRequestId }',
        params: 'body: { ReportRequest: { Type: "CampaignPerformanceReportRequest" | "AdGroupPerformanceReportRequest" | "AdPerformanceReportRequest" | '
          + '"KeywordPerformanceReportRequest" | "SearchQueryPerformanceReportRequest" | "GeographicPerformanceReportRequest" | "AccountPerformanceReportRequest", '
          + 'Format: "Csv", ReportName, ReturnOnlyCompleteData: false, ExcludeReportHeader: true, ExcludeReportFooter: true, ExcludeColumnHeaders: false, '
          + 'Aggregation: "Daily"|"Weekly"|"Monthly"|"Summary", Columns: ["TimePeriod","AccountName","CampaignName","Impressions","Clicks","Spend","Conversions","Revenue"], '
          + 'Scope: { AccountIds: [<id>] }, Time: { CustomDateRangeStart: { Day, Month, Year }, CustomDateRangeEnd: { Day, Month, Year }, ReportTimeZone: "GreenwichMeanTimeDublinEdinburghLisbonLondon" } } }; '
          + 'headers CustomerAccountId, CustomerId',
        notes: 'Use either CustomDateRangeStart/End or PredefinedTime ("Last30Days", "LastMonth"…), not both.' },
      { method: 'POST', path: `${REPORTING}/GenerateReport/Poll`, label: 'Poll the report (step 2 of 3)',
        rows: '`ReportRequestStatus` { Status: "Pending"|"Success"|"Error", ReportDownloadUrl }', params: 'body: { ReportRequestId }',
        notes: 'Wait with tools.sleep(5000) between polls. Status Success with no ReportDownloadUrl means the report has no rows — return [].' },
      { method: 'GET', path: '{ReportDownloadUrl}', label: 'Download the report (step 3 of 3)',
        rows: 'a ZIP holding one CSV — request with responseType "arraybuffer" and NO auth headers, then tools.parseCsv(tools.unzip(data)[0].text)',
        notes: 'Numbers in the CSV are strings; "--" means no value.' },
    ],
    notes: [
      'Campaign and report calls need the CustomerAccountId (account Id) and CustomerId (that account\'s ParentCustomerId) headers — from Accounts/Search, '
        + 'or the live account details. Add them to the request headers yourself.',
      'Spend and Revenue are in the account currency. TimePeriod is the date column of a Daily report.',
      'Errors come back with OperationErrors / BatchErrors arrays naming the Code and Message.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads.'] },
  },

  getLiveContext,

  configSchema: {
    fields: [
      { name: 'developerToken', type: 'password', label: 'Developer token', required: true, sensitive: true,
        helpText: 'Microsoft Advertising → Tools → Developer Portal → Account → Request token (a Universal token works for every account you can access).' },
    ],
  },

  metadata: {
    displayName: 'Microsoft Advertising',
    description: 'Bing Ads accounts, campaigns, ad groups, ads, keywords and performance reports',
    version: '1.0.0',
  },
};
