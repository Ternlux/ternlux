/**
 * YouTube Analytics connector — channel and video analytics (views, watch
 * time, subscribers, traffic sources, demographics, devices, geography) plus
 * the channel's videos and their public statistics, via the user's own
 * Google OAuth client.
 *
 * API facts cross-checked against Google's YouTube Analytics API v2 and Data
 * API v3 docs, the Airbyte source-youtube-analytics manifest (OAuth endpoints;
 * Airbyte uses the bulk Reporting API) and the n8n YouTube node (channel,
 * playlist, video resources). No code from either project.
 */

const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2';
const DATA = 'https://www.googleapis.com/youtube/v3';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${DATA}/channels`, { params: { part: 'snippet,statistics,contentDetails', mine: true } });
  const ch = data.items || [];
  if (!ch.length) return 'This Google account owns no YouTube channel (or a Brand Account was not picked at sign-in).';
  return ch.map((c) => `Channel ${c.id} "${c.snippet?.title}": ${c.statistics?.videoCount} videos, `
    + `${c.statistics?.subscriberCount} subscribers; uploads playlist ${c.contentDetails?.relatedPlaylists?.uploads}`).join('\n');
}

module.exports = {
  type: 'connector',
  id: 'youtube-analytics',
  name: 'YouTube Analytics',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    pkce: true,
    clientIdLabel: 'Google OAuth client ID',
    clientIdHelp: 'Google Cloud console → APIs & Services → Credentials. Enable "YouTube Analytics API" and "YouTube Data API v3" in the project.',
  },

  apiReference: {
    title: 'YouTube Analytics API v2 + Data API v3',
    docsUrl: 'https://developers.google.com/youtube/analytics/reference/reports/query',
    baseUrl: ANALYTICS,
    headers: { Authorization: 'Bearer {accessToken}' },
    test: { path: `${DATA}/channels?part=snippet&mine=true`, identity: (d) => d.items?.[0]?.snippet?.title },
    pagination: 'reports: maxResults (≤200 for video-level reports) + startIndex (1-based); request again while rows came back full. '
      + 'Data API lists: maxResults=50 + pageToken while response.data.nextPageToken is set.',
    endpoints: [
      { method: 'GET', path: '/reports', label: 'Channel or video analytics report',
        rows: '`rows` array of arrays; column names in response.data.columnHeaders[i].name — zip them into objects',
        params: 'ids=channel==MINE, startDate=YYYY-MM-DD, endDate=YYYY-MM-DD, metrics=views,estimatedMinutesWatched,averageViewDuration,likes,'
          + 'comments,shares,subscribersGained,subscribersLost, dimensions=day|month|video|country|deviceType|insightTrafficSourceType|ageGroup,gender, '
          + 'filters=video==ID1,ID2 (optional), sort=-views, maxResults, startIndex',
        notes: 'Not every dimension/metric pair is valid (e.g. ageGroup/gender only with viewerPercentage). dimensions=video needs sort and maxResults ≤ 200.' },
      { method: 'GET', path: `${DATA}/channels`, label: 'The channel (id, title, totals, uploads playlist)', rows: '`items` array', params: 'part=snippet,statistics,contentDetails, mine=true' },
      { method: 'GET', path: `${DATA}/playlistItems`, label: 'Every uploaded video (from the uploads playlist)', rows: '`items` array (contentDetails.videoId, contentDetails.videoPublishedAt)',
        params: 'part=contentDetails,snippet, playlistId=<uploads playlist id>, maxResults=50, pageToken' },
      { method: 'GET', path: `${DATA}/videos`, label: 'Video details and public statistics (up to 50 ids per call)', rows: '`items` array',
        params: 'part=snippet,statistics,contentDetails, id=ID1,ID2,…' },
    ],
    notes: [
      'Analytics data lags about 2 days; estimatedRevenue and other money metrics need the yt-analytics-monetary.readonly scope (not requested).',
      'statistics values from the Data API are strings — convert with Number().',
      'Data API calls cost quota units (10,000 a day by default): list calls are 1 unit each.',
    ],
    writes: { endpoints: [], notes: ['YouTube Analytics cannot receive rows through this connector.'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'YouTube Analytics',
    description: 'Views, watch time, subscribers, traffic sources and demographics, plus every video\'s statistics',
    version: '1.0.0',
  },
};
