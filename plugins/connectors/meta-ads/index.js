/**
 * Meta Ads connector (Facebook and Instagram ads) — ad accounts, campaigns,
 * ad sets, ads, creatives and Insights with any breakdown; custom audience
 * and Conversions API uploads. Signs in with the user's own Meta app
 * (Facebook Login for Business).
 *
 * Meta issues no refresh tokens: the sign-in's short-lived token is traded
 * for a long-lived one (about 60 days). When it lapses, the user clicks
 * Authorize again.
 *
 * API facts cross-checked against Meta's Marketing API docs, the Airbyte
 * source-facebook-marketing docs (Marketing API v23, insights breakdowns,
 * async insights jobs) and the Airbyte instagram manifest (Graph v23.0), and
 * the n8n Facebook Graph API node. No code from either project.
 */

const VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

// Short-lived (about an hour) → long-lived (about 60 days).
async function longLived(tokens, config, axios) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      fb_exchange_token: tokens.accessToken,
    },
    timeout: 30000,
  });
  const expiresIn = Number(data.expires_in) || 60 * 24 * 3600;
  return { accessToken: data.access_token, refreshToken: null, expiryDate: Date.now() + expiresIn * 1000 };
}

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${GRAPH}/me/adaccounts`, {
    params: { fields: 'id,name,account_id,currency,timezone_name,account_status', limit: 200 },
  });
  const accts = data.data || [];
  if (!accts.length) return 'This Meta login can see no ad accounts.';
  const status = { 1: 'active', 2: 'disabled', 3: 'unsettled', 7: 'pending review', 9: 'in grace period', 101: 'closed' };
  return ['Ad accounts this login can read (use the act_… id in paths):',
    ...accts.map((a) => `- ${a.id} "${a.name}" ${a.currency} ${a.timezone_name} (${status[a.account_status] || a.account_status})`)].join('\n');
}

module.exports = {
  type: 'connector',
  id: 'meta-ads',
  name: 'Meta Ads',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: `https://www.facebook.com/${VERSION}/dialog/oauth`,
    tokenUrl: `${GRAPH}/oauth/access_token`,
    tokenMethod: 'GET',
    scopes: ['ads_read', 'ads_management', 'business_management', 'read_insights'],
    scopeSeparator: ',',
    refresh: false,
    upgradeTokens: longLived,
    clientIdLabel: 'Meta app ID',
    clientIdHelp: 'developers.facebook.com → My Apps → your app → App settings → Basic → App ID.',
    clientSecretLabel: 'App secret',
  },

  apiReference: {
    title: `Meta Marketing API (Graph ${VERSION})`,
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/reference',
    baseUrl: GRAPH,
    headers: { Authorization: 'Bearer {accessToken}' },
    test: { path: '/me?fields=id,name', identity: (d) => d.name },
    pagination: 'Lists return { data: [...], paging: { next } }; while response.data.paging.next is set, GET that full URL '
      + '(it already carries the query). Send limit=500 on the first request.',
    endpoints: [
      { method: 'GET', path: '/me/adaccounts', label: 'Ad accounts', rows: '`data` array', params: 'fields=id,name,account_id,currency,timezone_name,account_status' },
      { method: 'GET', path: '/{adAccountId}/insights', label: 'Insights — spend, impressions, clicks, conversions (any level, any breakdown)',
        rows: '`data` array', params: 'level=account|campaign|adset|ad, fields=campaign_id,campaign_name,adset_name,ad_name,impressions,reach,clicks,spend,cpc,ctr,cpm,'
          + 'actions,action_values,conversions, time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"} (JSON-encoded) or date_preset=last_30d, '
          + 'time_increment=1 (daily) | monthly | all_days, breakdowns=age,gender | country | publisher_platform,platform_position | device_platform, '
          + 'action_breakdowns=action_type, filtering=[{"field":"campaign.id","operator":"IN","value":["…"]}], limit=500',
        notes: '{adAccountId} is "act_<number>". actions / action_values are arrays of { action_type, value } — pivot the ones the user wants '
          + '(e.g. purchase, lead, link_click) into columns. Numbers arrive as strings.' },
      { method: 'POST', path: '/{adAccountId}/insights', label: 'Start an async insights job (large ranges or many ads)',
        rows: 'none — returns { report_run_id }; poll GET /{report_run_id} until async_status is "Job Completed", then GET /{report_run_id}/insights',
        params: 'same fields as GET insights, in the body', notes: 'Wait with tools.sleep(10000) between polls; give up after ~30 minutes.' },
      { method: 'GET', path: '/{adAccountId}/campaigns', label: 'Campaigns', rows: '`data` array',
        params: 'fields=id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time, '
          + 'filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]' },
      { method: 'GET', path: '/{adAccountId}/adsets', label: 'Ad sets', rows: '`data` array', params: 'fields=id,name,campaign_id,status,optimization_goal,billing_event,daily_budget,targeting,start_time,end_time' },
      { method: 'GET', path: '/{adAccountId}/ads', label: 'Ads', rows: '`data` array', params: 'fields=id,name,adset_id,campaign_id,status,creative{id,name,title,body,object_story_spec},created_time' },
      { method: 'GET', path: '/{adAccountId}/adcreatives', label: 'Creatives', rows: '`data` array', params: 'fields=id,name,title,body,image_url,thumbnail_url,object_story_spec,call_to_action_type' },
      { method: 'GET', path: '/{adAccountId}/customaudiences', label: 'Custom audiences', rows: '`data` array', params: 'fields=id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_updated' },
      { method: 'GET', path: '/{adAccountId}/customconversions', label: 'Custom conversions', rows: '`data` array', params: 'fields=id,name,custom_event_type,rule' },
    ],
    notes: [
      'Budgets (daily_budget, lifetime_budget) are in the account currency\'s minor unit (cents); spend in insights is in major units.',
      'Insights for the last 28 days of conversions can still change (attribution windows): re-read recent days on a schedule.',
      'Rate limits are per ad account; an error with code 17 or 80004 means slow down — wait and retry, or use an async job.',
      'Error code 190 = the token expired or was revoked: reconnect the connection (Authorize again).',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/{customAudienceId}/users', label: 'Add people to a custom audience (hashed)', batch: 10000, upsert: 'Meta matches on the hashes',
          body: '{ payload: { schema: ["EMAIL"] or ["EMAIL","PHONE","FN","LN"], data: [[tools.sha256(email.trim().toLowerCase())], …] } } — send as form field payload=JSON.stringify(...)',
          notes: 'Every value must be SHA-256 of the normalised value (emails trimmed + lowercased; phones digits with country code). Create the audience first in Ads Manager (Customer list).' },
        { method: 'DELETE', path: '/{customAudienceId}/users', label: 'Remove people from a custom audience', batch: 10000, upsert: null, body: 'same payload as adding' },
        { method: 'POST', path: '/{pixelId}/events', label: 'Conversions API — send offline / server events', batch: 1000, upsert: 'event_id (deduplicated)',
          body: '{ data: [{ event_name: "Purchase", event_time: <unix seconds>, action_source: "system_generated"|"website"|"physical_store", event_id, '
            + 'user_data: { em: [sha256(email)], ph?: [sha256(phone)] }, custom_data?: { value, currency } }] }',
          notes: 'Events older than 7 days are rejected. events_received in the response is the count accepted.' },
      ],
      notes: ['Hash with tools.sha256 — never send raw emails or phone numbers.'],
    },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'Meta Ads',
    description: 'Facebook and Instagram ad accounts, campaigns, ads and Insights; custom audiences and Conversions API',
    version: '1.0.0',
  },
};
