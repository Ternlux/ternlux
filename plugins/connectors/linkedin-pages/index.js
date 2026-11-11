/**
 * LinkedIn Pages connector — the company pages the user administers:
 * follower counts and statistics, share (post) statistics, page views and
 * the page's posts. Signs in with the user's own LinkedIn app, which needs
 * the Community Management API product.
 *
 * API facts cross-checked against LinkedIn's Community Management API docs,
 * the Airbyte source-linkedin-pages manifest (https://api.linkedin.com/rest,
 * LinkedIn-Version 202610, scopes r_organization_social and
 * rw_organization_admin, follower/share statistics streams) and the n8n
 * LinkedIn node. No code from either project.
 */

const BASE = 'https://api.linkedin.com/rest';
const VERSION = '202610';

async function getLiveContext(config, { axios }) {
  const { data } = await axios.get(`${BASE}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100`);
  const orgs = (data.elements || []).map((e) => String(e.organization || '').split(':').pop()).filter(Boolean);
  if (!orgs.length) return 'This LinkedIn member administers no company pages.';
  const lines = ['Company pages this member administers (organization id → name):'];
  for (const id of orgs.slice(0, 25)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data: org } = await axios.get(`${BASE}/organizations/${id}`);
      lines.push(`- ${id} "${org.localizedName || org.vanityName || ''}"`);
    } catch (_) {
      lines.push(`- ${id}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'linkedin-pages',
  name: 'LinkedIn Pages',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['r_organization_social', 'rw_organization_admin'],
    clientIdHelp: 'linkedin.com/developers → My apps → your app → Auth → Client ID. The app needs the Community Management API product.',
  },

  apiReference: {
    title: `LinkedIn Community Management API (${VERSION})`,
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/',
    baseUrl: BASE,
    headers: {
      Authorization: 'Bearer {accessToken}',
      'LinkedIn-Version': VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    test: { path: '/organizationAcls?q=roleAssignee&count=1', identity: (d) => `${(d.elements || []).length ? 'page admin' : 'no pages yet'}` },
    pagination: 'start + count (≤ 100): request again with start += count while elements came back full; or pageToken when metadata.nextPageToken is set.',
    endpoints: [
      { method: 'GET', path: '/organizationAcls?q=roleAssignee', label: 'Pages you administer', rows: '`elements` array (organization URN, role, state)',
        params: 'role=ADMINISTRATOR, state=APPROVED, count' },
      { method: 'GET', path: '/organizations/{orgId}', label: 'Page details', rows: 'one object (localizedName, vanityName, localizedWebsite…)' },
      { method: 'GET', path: '/networkSizes/urn%3Ali%3Aorganization%3A{orgId}?edgeType=COMPANY_FOLLOWED_BY_MEMBER', label: 'Total followers', rows: 'one object (firstDegreeSize)' },
      { method: 'GET', path: '/organizationalEntityFollowerStatistics?q=organizationalEntity', label: 'Follower statistics (by function, seniority, industry, country — or over time)',
        rows: '`elements` array', params: 'organizationalEntity=urn%3Ali%3Aorganization%3A{orgId}; for a time series add '
          + 'timeIntervals=(timeRange:(start:<ms>,end:<ms>),timeGranularityType:DAY)',
        notes: 'Build the query string by hand (Rest.li tuples must stay unescaped; the URN inside is URL-encoded). Time series go back 12 months at most.' },
      { method: 'GET', path: '/organizationalEntityShareStatistics?q=organizationalEntity', label: 'Post statistics (impressions, clicks, engagement)',
        rows: '`elements` array (totalShareStatistics)', params: 'organizationalEntity=urn%3Ali%3Aorganization%3A{orgId}, optional timeIntervals as above, or shares=List(urn%3Ali%3Ashare%3A…)' },
      { method: 'GET', path: '/organizationPageStatistics?q=organization', label: 'Page views by section and visitor demographics',
        rows: '`elements` array', params: 'organization=urn%3Ali%3Aorganization%3A{orgId}, optional timeIntervals' },
      { method: 'GET', path: '/posts?q=author', label: 'The page\'s posts', rows: '`elements` array', params: 'author=urn%3Ali%3Aorganization%3A{orgId}, count (≤ 100), start, sortBy=LAST_MODIFIED' },
    ],
    notes: [
      'Times are epoch milliseconds (timeRange.start / end).',
      'Statistics need the member to be an ADMINISTRATOR (or analyst) of the page; a 403 names the missing role or scope.',
    ],
    writes: { endpoints: [], notes: ['This connector only reads; publishing posts is not supported.'] },
  },

  getLiveContext,
  configSchema: { fields: [] },
  metadata: {
    displayName: 'LinkedIn Pages',
    description: 'Company page followers, follower demographics, post statistics, page views and posts',
    version: '1.0.0',
  },
};
