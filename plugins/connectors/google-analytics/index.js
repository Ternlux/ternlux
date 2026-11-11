/**
 * Google Analytics 4 connector.
 *
 * Signs in with the user's own Google Cloud OAuth client (the same kind the
 * Sheets and Drive connectors use) and reads reports through the GA4 Data
 * API. The AI writes the report request on the Data Source node; the
 * reference below and the live context (the user's properties and their
 * custom dimensions and metrics, fetched on every build) keep it honest.
 *
 * API facts cross-checked against Google's Data API v1beta / Admin API v1beta
 * docs, the Airbyte source-google-analytics-data-api manifest (url bases,
 * OAuth endpoints, runReport paging) and the n8n Google Analytics v2 node.
 * No code from either project.
 */

const DATA = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';

const MAX_CUSTOM = 120;

// "properties/123" or "123" → "123"
const propertyId = (p) => String(p || '').replace(/^properties\//, '');

function pickProperty(props, request) {
  if (props.length === 1) return props[0];
  const text = String(request || '').toLowerCase();
  return props.find((p) => text.includes(propertyId(p.property)))
    || props.find((p) => p.displayName && text.includes(String(p.displayName).toLowerCase()))
    || null;
}

async function getLiveContext(config, { request, axios }) {
  const summaries = [];
  let pageToken = '';
  do {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(`${ADMIN}/accountSummaries`, { params: { pageSize: 200, pageToken: pageToken || undefined } });
    summaries.push(...(data.accountSummaries || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken && summaries.length < 1000);

  const props = summaries.flatMap((a) => (a.propertySummaries || []).map((p) => ({ ...p, account: a.displayName })));
  if (!props.length) return 'This Google account can see no GA4 properties. Ask the user to check they signed in with the right account and have at least Viewer access.';

  const lines = ['GA4 properties this account can read (use the number as {propertyId}):'];
  for (const p of props.slice(0, 200)) {
    lines.push(`- ${propertyId(p.property)} "${p.displayName}" (account "${p.account}")`);
  }

  const focus = pickProperty(props, request);
  if (!focus) {
    lines.push('', 'The request does not say which property; ask unless only one fits.');
    return lines.join('\n');
  }

  const { data: meta } = await axios.get(`${DATA}/properties/${propertyId(focus.property)}/metadata`);
  const dims = meta.dimensions || [];
  const mets = meta.metrics || [];
  const custom = (list) => list.filter((d) => d.customDefinition);
  lines.push('', `Property ${propertyId(focus.property)} "${focus.displayName}" right now: ${dims.length} dimensions, ${mets.length} metrics.`);
  const cd = custom(dims);
  const cm = custom(mets);
  lines.push(cd.length
    ? `Custom dimensions (apiName — display name): ${cd.slice(0, MAX_CUSTOM).map((d) => `${d.apiName} — ${d.uiName}`).join('; ')}`
    : 'Custom dimensions: none.');
  lines.push(cm.length
    ? `Custom metrics: ${cm.slice(0, MAX_CUSTOM).map((m) => `${m.apiName} — ${m.uiName} (${m.type})`).join('; ')}`
    : 'Custom metrics: none.');
  // Key events show up as metrics such as keyEvents:purchase.
  const keyEvents = mets.filter((m) => /^keyEvents:/.test(m.apiName)).map((m) => m.apiName);
  if (keyEvents.length) lines.push(`Per-key-event metrics: ${keyEvents.slice(0, 60).join(', ')}`);
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'google-analytics',
  name: 'Google Analytics 4',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    // offline + consent: Google only returns a refresh token on consent.
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    pkce: true,
    clientIdLabel: 'Google OAuth client ID',
    clientIdHelp: 'Google Cloud console → APIs & Services → Credentials → your OAuth client (type Desktop app or Web application).',
  },

  apiReference: {
    title: 'Google Analytics 4 (Data API)',
    docsUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1/rest',
    baseUrl: DATA,
    headers: { Authorization: 'Bearer {accessToken}', 'Content-Type': 'application/json' },
    test: {
      path: `${ADMIN}/accountSummaries?pageSize=50`,
      identity: (d) => {
        const n = (d.accountSummaries || []).reduce((s, a) => s + (a.propertySummaries || []).length, 0);
        return `${n} propert${n === 1 ? 'y' : 'ies'} visible`;
      },
    },
    pagination: 'runReport: send "limit" (max 250000, use 100000) and "offset"; response.data.rowCount is the total; '
      + 'request again with offset += limit while offset < rowCount. Admin API lists: pageSize + pageToken, '
      + 'while response.data.nextPageToken is set.',
    endpoints: [
      { method: 'POST', path: '/properties/{propertyId}:runReport', label: 'Run a report (any dimensions and metrics)',
        rows: '`rows` array — each row has dimensionValues[i].value and metricValues[i].value in the order of '
          + 'response.data.dimensionHeaders / metricHeaders',
        params: 'body: { dateRanges: [{ startDate: "28daysAgo"|"YYYY-MM-DD", endDate: "today"|"yesterday"|"YYYY-MM-DD" }], '
          + 'dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], dimensionFilter?, metricFilter?, '
          + 'orderBys?: [{ dimension: { dimensionName: "date" } }], limit, offset, keepEmptyRows?, returnPropertyQuota: true }',
        notes: 'At most 9 dimensions and 10 metrics per request. Metric values arrive as strings — convert with Number(). '
          + 'The date dimension is "YYYYMMDD" — reformat to YYYY-MM-DD.' },
      { method: 'POST', path: '/properties/{propertyId}:batchRunReports', label: 'Up to 5 reports in one call',
        rows: '`reports` array, each like a runReport response', params: 'body: { requests: [ <runReport body>, … ] }' },
      { method: 'POST', path: '/properties/{propertyId}:runRealtimeReport', label: 'Realtime report (last 30 minutes)',
        rows: '`rows` array', params: 'body: { dimensions, metrics, minuteRanges? } — realtime dimensions/metrics only (e.g. country, activeUsers)' },
      { method: 'POST', path: '/properties/{propertyId}:runPivotReport', label: 'Pivot report', rows: '`rows` array', params: 'body: { dateRanges, dimensions, metrics, pivots }' },
      { method: 'GET', path: '/properties/{propertyId}/metadata', label: 'Every dimension and metric this property supports (incl. custom ones)',
        rows: '`dimensions` and `metrics` arrays (apiName, uiName, category, customDefinition)' },
      { method: 'POST', path: '/properties/{propertyId}:checkCompatibility', label: 'Check which dimensions/metrics can be combined',
        rows: '`dimensionCompatibilities` / `metricCompatibilities`', params: 'body: { dimensions, metrics }' },
      { method: 'GET', path: `${ADMIN}/accountSummaries`, label: 'Accounts and their properties (find a property id)',
        rows: '`accountSummaries[].propertySummaries[]` (property: "properties/123", displayName)', params: 'pageSize, pageToken' },
      { method: 'GET', path: `${ADMIN}/properties/{propertyId}/dataStreams`, label: 'Web and app data streams of a property', rows: '`dataStreams` array' },
      { method: 'GET', path: `${ADMIN}/properties/{propertyId}/keyEvents`, label: 'Key events (conversions)', rows: '`keyEvents` array' },
      { method: 'GET', path: `${ADMIN}/properties/{propertyId}/customDimensions`, label: 'Custom dimension definitions', rows: '`customDimensions` array' },
    ],
    notes: [
      'propertyId is the number only (123456789), not "properties/123456789" and not the G-XXXX measurement id.',
      'Common dimensions: date, dateHour, country, city, deviceCategory, sessionDefaultChannelGroup, sessionSource, sessionMedium, '
        + 'sessionCampaignName, pagePath, pageTitle, landingPage, eventName, firstUserSource, itemName. Common metrics: activeUsers, '
        + 'newUsers, sessions, engagedSessions, engagementRate, screenPageViews, eventCount, keyEvents, totalRevenue, purchaseRevenue, '
        + 'ecommercePurchases, averageSessionDuration, bounceRate.',
      'Custom definitions are named customEvent:<param>, customUser:<prop> and customItem:<param>; the live account details list the real ones.',
      'Data for the last 48–72 hours can still change (GA4 keeps processing). A scheduled run should re-read the last 3 days.',
      'Quota is per property per day (tokens); keep returnPropertyQuota: true and do not loop one day per request when one range works.',
      '403 PERMISSION_DENIED = the signed-in user has no access to that property; 400 INVALID_ARGUMENT usually names the bad dimension or metric.',
    ],
    // GA4's Data API is read-only.
    writes: { endpoints: [], notes: ['Google Analytics 4 cannot receive rows through this connector; the Data API is read-only.'] },
  },

  getLiveContext,

  configSchema: { fields: [] },

  metadata: {
    displayName: 'Google Analytics 4',
    description: 'GA4 reports — any dimensions and metrics, realtime, pivots — via your own Google OAuth client',
    version: '1.0.0',
  },
};
