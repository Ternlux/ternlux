/**
 * Facebook Pages & Instagram connector — Page posts, comments and insights,
 * and the Instagram professional accounts linked to those Pages (profile,
 * media, media and account insights). Signs in with the user's own Meta app.
 *
 * Page data needs the PAGE's access token, which GET /me/accounts returns per
 * Page; the reference tells the generated code to fetch and use it. Like
 * Meta Ads, the user token is traded for a long-lived one (about 60 days);
 * Page tokens derived from it do not expire.
 *
 * API facts cross-checked against Meta's Graph API Page and Instagram Graph
 * API docs, the Airbyte source-facebook-pages docs (streams and the 100-likes
 * insights rule) and the Airbyte instagram manifest (Graph v23.0, /me/accounts
 * → instagram_business_account), and the n8n Facebook Graph API node. No code
 * from either project.
 */

const VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

async function longLived(tokens, config, axios) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: { grant_type: 'fb_exchange_token', client_id: config.clientId, client_secret: config.clientSecret, fb_exchange_token: tokens.accessToken },
    timeout: 30000,
  });
  const expiresIn = Number(data.expires_in) || 60 * 24 * 3600;
  return { accessToken: data.access_token, refreshToken: null, expiryDate: Date.now() + expiresIn * 1000 };
}

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${GRAPH}/me/accounts`, {
    params: { fields: 'id,name,fan_count,instagram_business_account{id,username,followers_count}', limit: 100 },
  });
  const pages = data.data || [];
  if (!pages.length) return 'This login manages no Facebook Pages (or none were selected at sign-in).';
  return ['Pages this login manages (page id; linked Instagram account id):',
    ...pages.map((p) => `- ${p.id} "${p.name}" (${p.fan_count ?? '?'} likes)`
      + (p.instagram_business_account ? `; Instagram ${p.instagram_business_account.id} @${p.instagram_business_account.username} (${p.instagram_business_account.followers_count} followers)` : '; no Instagram account linked'))].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'facebook-pages',
  name: 'Facebook Pages & Instagram',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: `https://www.facebook.com/${VERSION}/dialog/oauth`,
    tokenUrl: `${GRAPH}/oauth/access_token`,
    tokenMethod: 'GET',
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'read_insights',
      'instagram_basic', 'instagram_manage_insights', 'business_management'],
    scopeSeparator: ',',
    refresh: false,
    upgradeTokens: longLived,
    clientIdLabel: 'Meta app ID',
    clientIdHelp: 'developers.facebook.com → My Apps → your app → App settings → Basic → App ID.',
    clientSecretLabel: 'App secret',
  },

  apiReference: {
    title: `Facebook Pages & Instagram Graph API (${VERSION})`,
    docsUrl: 'https://developers.facebook.com/docs/graph-api/reference/page',
    baseUrl: GRAPH,
    headers: { Authorization: 'Bearer {accessToken}' },
    test: { path: '/me?fields=id,name', identity: (d) => d.name },
    pagination: 'Lists return { data: [...], paging: { next } }; while response.data.paging.next is set, GET that full URL. Send limit=100.',
    endpoints: [
      { method: 'GET', path: '/me/accounts', label: 'Pages you manage — WITH each Page\'s access_token', rows: '`data` array',
        params: 'fields=id,name,access_token,fan_count,followers_count,instagram_business_account{id,username}',
        notes: 'Every /{pageId}/… call below must send Authorization: Bearer <that page\'s access_token>, not the user token. '
          + 'Fetch this first inside the function and keep the page tokens in memory — never return them as rows.' },
      { method: 'GET', path: '/{pageId}/posts', label: 'Page posts with engagement counts', rows: '`data` array',
        params: 'fields=id,message,created_time,permalink_url,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0), since, until (unix or YYYY-MM-DD)' },
      { method: 'GET', path: '/{pageId}/insights', label: 'Page insights by day', rows: '`data` array — one item per metric, values[] = { value, end_time }',
        params: 'metric=page_impressions_unique,page_post_engagements,page_fans,page_follows,page_views_total, period=day|week|days_28, since, until (≤ 90 days per call)',
        notes: 'Meta retires Page metrics regularly; an error "(#100) The value must be a valid insights metric" names the bad one — drop it. '
          + 'Pages with fewer than 100 likes return no insights.' },
      { method: 'GET', path: '/{postId}/insights', label: 'One post\'s insights', rows: '`data` array', params: 'metric=post_impressions_unique,post_clicks,post_reactions_by_type_total' },
      { method: 'GET', path: '/{postId}/comments', label: 'Comments on a post', rows: '`data` array', params: 'fields=id,message,created_time,from,like_count, filter=stream' },
      { method: 'GET', path: '/{igUserId}', label: 'Instagram account profile', rows: 'one object', params: 'fields=id,username,name,followers_count,follows_count,media_count,biography' },
      { method: 'GET', path: '/{igUserId}/media', label: 'Instagram posts, reels and carousels', rows: '`data` array',
        params: 'fields=id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url' },
      { method: 'GET', path: '/{mediaId}/insights', label: 'One Instagram post\'s insights', rows: '`data` array (name, values[0].value)',
        params: 'metric=reach,views,likes,comments,shares,saved,total_interactions' },
      { method: 'GET', path: '/{igUserId}/insights', label: 'Instagram account insights', rows: '`data` array',
        params: 'metric=reach,follower_count,profile_views,accounts_engaged, period=day, since, until (≤ 30 days), metric_type=total_value for engagement metrics' },
      { method: 'GET', path: '/{igUserId}/stories', label: 'Current stories (last 24 hours only)', rows: '`data` array', params: 'fields=id,media_type,timestamp,permalink' },
    ],
    notes: [
      'Instagram requires a Business or Creator account linked to a Facebook Page; its id comes from the Page\'s instagram_business_account.',
      'Instagram account insights cover the last 2 years at most and 30 days per request; loop over windows.',
      'Error code 190 = the token expired or was revoked: reconnect (Authorize again).',
    ],
    writes: { endpoints: [], notes: ['This connector only reads; publishing posts is not supported.'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'Facebook Pages & Instagram',
    description: 'Page posts, comments and insights; Instagram profile, media and insights',
    version: '1.0.0',
  },
};
