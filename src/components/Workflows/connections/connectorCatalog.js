import React, { useState } from 'react';
import { C, MONO } from '../_designShared';

// Shared connector catalog — the single source of truth for what each
// connector/database type looks like. ConnectionTypeSelector renders it as the
// registry of things you can add; ConnectionsTab looks up the same entries to
// badge saved connections with their provider logo.

export const LOGO_PREFIX = 'http://www.ternlux.com/wp-content/uploads/2026/04/';
// Logos added with the API presets and the remaining file/storage connectors.
export const LOGO_PREFIX_2026_11 = 'http://www.ternlux.com/wp-content/uploads/2026/11/';

// `img` points at a logo hosted on ternlux.com; `letters` is the monogram shown
// when there's no logo or it can't load.
export const CONNECTION_TYPES = [
  // Local files
  { key: 'spreadsheet', title: 'CSV / Excel',     description: 'Query CSV or Excel files in place, no import step',     category: 'file', img: LOGO_PREFIX + 'CSV.png',  fileBased: true, tone: '#1890ff' },
  { key: 'json',        title: 'JSON',            description: 'Query JSON files in place, no import step',             category: 'file', img: LOGO_PREFIX + 'JSON.png', fileBased: true, tone: '#fa8c16' },
  { key: 'duckdb',      title: 'DuckDB',          description: 'Connect to an existing DuckDB database file',           category: 'file', img: LOGO_PREFIX_2026_11 + 'DuckDB.png', letters: 'DD', tone: '#fff100', fileBased: true },
  { key: 'sqlite',      title: 'SQLite',          description: 'Connect to an existing SQLite database file',           category: 'file', img: LOGO_PREFIX + 'SQLite.png', letters: 'SQ', tone: '#0f80cc', fileBased: true },
  { key: 'lancedb',     title: 'LanceDB',         description: 'Connect to local LanceDB vector database',             category: 'file', img: LOGO_PREFIX + 'LanceDB.png', tone: '#7c3aed', fileBased: true },
  { key: 'parquet',     title: 'Parquet',         description: 'Query Parquet files in place, no import step',          category: 'file', img: LOGO_PREFIX_2026_11 + 'Parquet.png', letters: 'PQ', tone: '#9254de', fileBased: true },
  { key: 'avro',        title: 'Avro',            description: 'Query Avro files in place, no import step',            category: 'file', img: LOGO_PREFIX_2026_11 + 'Avro.png', letters: 'AV', tone: '#eb2f96', fileBased: true },

  // Databases
  { key: 'postgres',  title: 'PostgreSQL',      description: 'Connect to a PostgreSQL database',                category: 'database', img: LOGO_PREFIX + 'PostgreSQL.png',           tone: '#336791' },
  { key: 'mysql',     title: 'MySQL / MariaDB', description: 'Connect to a MySQL or MariaDB database',          category: 'database', img: LOGO_PREFIX + 'MySQL.png',                tone: '#e48b00' },
  { key: 'mssql',     title: 'SQL Server',      description: 'Connect to a Microsoft SQL Server database',      category: 'database', img: LOGO_PREFIX + 'Microsoft_SQL_Server.png', tone: '#0078d4' },
  { key: 'mongodb',   title: 'MongoDB',         description: 'Connect to a MongoDB database or Atlas cluster',  category: 'database', img: LOGO_PREFIX + 'MongoDB.png',              tone: '#00a550' },
  { key: 'redshift',  title: 'Amazon Redshift', description: 'Connect to an Amazon Redshift data warehouse',    category: 'database', img: LOGO_PREFIX + 'Amazon_Redshift.png',      tone: '#ff9900' },
  { key: 'bigquery',  title: 'Google BigQuery', description: 'Connect to Google BigQuery data warehouse',       category: 'database', img: LOGO_PREFIX + 'Google_BigQuery.png',      tone: '#4285f4' },
  { key: 'snowflake', title: 'Snowflake',       description: 'Connect to a Snowflake data warehouse',           category: 'database', img: LOGO_PREFIX + 'Snowflake.png',            tone: '#29b5e8' },

  // Cloud storage
  { key: 's3',           title: 'Amazon S3',            description: 'Connect to Amazon S3 object storage', category: 'storage', img: LOGO_PREFIX + 'Amazon_S3.png',            tone: '#ff9900' },
  { key: 'gcs',          title: 'Google Cloud Storage', description: 'Connect to Google Cloud Storage',     category: 'storage', img: LOGO_PREFIX + 'Google_Cloud_Storage.png', tone: '#4285f4' },
  { key: 'azure-blob',   title: 'Azure Blob Storage',   description: 'Connect to Azure Blob Storage',       category: 'storage', img: LOGO_PREFIX + 'Azure_blob.png',           tone: '#0078d4' },
  { key: 'dropbox',      title: 'Dropbox',              description: 'Connect to Dropbox cloud storage',    category: 'storage', img: 'http://www.ternlux.com/wp-content/uploads/2026/05/Dropbox-scaled.png', letters: 'DB', tone: '#0061ff' },
  { key: 'google-drive', title: 'Google Drive',         description: 'Connect to Google Drive',             category: 'storage', img: LOGO_PREFIX_2026_11 + 'Google_Drive.png', letters: 'GD', tone: '#34a853' },
  { key: 'onedrive',     title: 'OneDrive',             description: 'Connect to Microsoft OneDrive',       category: 'storage', img: LOGO_PREFIX_2026_11 + 'OneDrive.png', letters: 'OD', tone: '#0078d4' },
  // Browsed spreadsheet-then-tab, and written like any other cloud target —
  // 'storage' is the section key the Cloud Storage group filters on.
  { key: 'google-sheets', title: 'Google Sheets',        description: 'Connect to Google Sheets via OAuth2.0', category: 'storage', img: LOGO_PREFIX + 'Google_Sheets.png', tone: '#34a853' },

  // APIs
  { key: 'rest-api',      title: 'REST API',      description: 'Generic HTTP endpoint — URL + your own key/value credentials here, request authored on the node', category: 'api', letters: 'API', tone: '#2563eb' },
  // Vendor presets of the REST API connector (plugins/connectors/rest-api/presets).
  // Same plugin, a form that asks only for the vendor's token.
  { key: 'rest-api:github',  title: 'GitHub',  description: 'Repos, issues, pull requests, commits and Actions runs — personal access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'GitHub.png', letters: 'GH', tone: '#24292f' },
  { key: 'rest-api:hubspot', title: 'HubSpot', description: 'Contacts, companies, deals, tickets and owners — service key',                    category: 'api', img: LOGO_PREFIX + 'HubSpot.png', letters: 'HS', tone: '#ff7a59' },
  { key: 'rest-api:stripe', title: 'Stripe', description: 'Customers, charges, invoices, subscriptions and payouts — secret or restricted key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Stripe.png', letters: 'ST', tone: '#635bff' },
  { key: 'rest-api:notion', title: 'Notion', description: 'Pages, databases (data sources), blocks and comments — integration secret', category: 'api', img: LOGO_PREFIX_2026_11 + 'Notion.png', letters: 'NO', tone: '#191919' },
  { key: 'rest-api:airtable', title: 'Airtable', description: 'Bases, tables and records — personal access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Airtable.png', letters: 'AT', tone: '#d18f00' },
  { key: 'rest-api:jira', title: 'Jira', description: 'Issues by JQL, projects, comments, worklogs and sprints — email + API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Jira.png', letters: 'JI', tone: '#0052cc' },
  { key: 'rest-api:pipedrive', title: 'Pipedrive', description: 'Deals, persons, organizations, activities and leads — API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Pipedrive.png', letters: 'PD', tone: '#017737' },
  { key: 'rest-api:sendgrid', title: 'SendGrid', description: 'Lists, single sends, stats and suppressions — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'SendGrid.png', letters: 'SG', tone: '#1a82e2' },
  { key: 'rest-api:klaviyo', title: 'Klaviyo', description: 'Profiles, events, lists, segments, campaigns and flows — private API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Klaviyo.png', letters: 'KL', tone: '#232426' },
  { key: 'rest-api:intercom', title: 'Intercom', description: 'Contacts, companies, conversations and tickets — access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Intercom.png', letters: 'IC', tone: '#1f8ded' },
  { key: 'rest-api:linear', title: 'Linear', description: 'Issues, projects, cycles and teams (GraphQL) — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Linear.png', letters: 'LN', tone: '#5e6ad2' },
  { key: 'rest-api:mailchimp', title: 'Mailchimp', description: 'Audiences, members, campaigns and reports — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Mailchimp.png', letters: 'MC', tone: '#b8960c' },
  { key: 'rest-api:freshdesk', title: 'Freshdesk', description: 'Tickets, conversations, contacts and agents — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Freshdesk.png', letters: 'FD', tone: '#25c16f' },
  { key: 'rest-api:calendly', title: 'Calendly', description: 'Scheduled events, invitees and event types — personal access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Calendly.png', letters: 'CA', tone: '#006bff' },
  { key: 'rest-api:typeform', title: 'Typeform', description: 'Forms, responses and workspaces — personal access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Typeform.png', letters: 'TF', tone: '#262627' },
  { key: 'rest-api:close', title: 'Close', description: 'Leads, contacts, opportunities, calls, emails and tasks — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Close.png', letters: 'CL', tone: '#1463ff' },
  { key: 'rest-api:attio', title: 'Attio', description: 'Records of any object, lists, notes and tasks — access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Attio.png', letters: 'AT', tone: '#111111' },
  { key: 'rest-api:activecampaign', title: 'ActiveCampaign', description: 'Contacts, lists, campaigns, automations and deals — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'ActiveCampaign.png', letters: 'AC', tone: '#356ae6' },
  { key: 'rest-api:apollo', title: 'Apollo.io', description: 'Contacts, accounts, deals, sequences; people and company search — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Apollo.png', letters: 'AP', tone: '#f0c419' },
  { key: 'rest-api:zendesk', title: 'Zendesk', description: 'Tickets, comments, users, organizations, metrics and CSAT — email + API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Zendesk.png', letters: 'ZD', tone: '#03363d' },
  { key: 'rest-api:front', title: 'Front', description: 'Conversations, messages, inboxes, contacts and events — API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Front.png', letters: 'FR', tone: '#a857f1' },
  { key: 'rest-api:gorgias', title: 'Gorgias', description: 'Tickets, messages, customers and satisfaction surveys — email + API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Gorgias.png', letters: 'GO', tone: '#161616' },
  { key: 'rest-api:asana', title: 'Asana', description: 'Projects, sections, tasks, subtasks and comments — personal access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Asana.png', letters: 'AS', tone: '#f06a6a' },
  { key: 'rest-api:monday', title: 'monday.com', description: 'Boards, items with column values, updates and activity (GraphQL) — API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Monday.png', letters: 'MO', tone: '#ff3d57' },
  { key: 'rest-api:clickup', title: 'ClickUp', description: 'Spaces, lists, tasks with custom fields, comments and time entries — API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'ClickUp.png', letters: 'CU', tone: '#7b68ee' },
  { key: 'rest-api:gitlab', title: 'GitLab', description: 'Projects, issues, merge requests, pipelines and deployments — access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'GitLab.png', letters: 'GL', tone: '#fc6d26' },
  { key: 'rest-api:sentry', title: 'Sentry', description: 'Issues, events, releases and Discover queries — auth token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Sentry.png', letters: 'SE', tone: '#362d59' },
  { key: 'rest-api:smartsheet', title: 'Smartsheet', description: 'Sheets, rows, reports and workspaces; add and update rows — access token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Smartsheet.png', letters: 'SS', tone: '#0073ec' },
  { key: 'rest-api:brevo', title: 'Brevo', description: 'Contacts, lists, email and SMS campaigns, CRM deals — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Brevo.png', letters: 'BR', tone: '#0b996e' },
  { key: 'rest-api:customer-io', title: 'Customer.io', description: 'Campaigns, newsletters, segments and messages; identify and track — API keys', category: 'api', img: LOGO_PREFIX_2026_11 + 'CustomerIO.png', letters: 'CI', tone: '#7131ff' },
  { key: 'rest-api:mixpanel', title: 'Mixpanel', description: 'Raw events, profiles, segmentation, funnels and retention — service account', category: 'api', img: LOGO_PREFIX_2026_11 + 'Mixpanel.png', letters: 'MP', tone: '#7856ff' },
  { key: 'rest-api:amplitude', title: 'Amplitude', description: 'Segmentation, funnels, retention and active users; send events — API + secret key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Amplitude.png', letters: 'AM', tone: '#1e61f0' },
  { key: 'rest-api:posthog', title: 'PostHog', description: 'HogQL over events and persons, insights and flags; capture events — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'PostHog.png', letters: 'PH', tone: '#f54e00' },
  { key: 'rest-api:segment', title: 'Segment', description: 'Sources, destinations, warehouses and usage; send events — API token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Segment.png', letters: 'SG', tone: '#52bd94' },
  { key: 'rest-api:plausible', title: 'Plausible', description: 'Visitors, pageviews and goals by page, source and country — API key', category: 'api', img: LOGO_PREFIX_2026_11 + 'Plausible.png', letters: 'PL', tone: '#5850ec' },
  // SaaS connectors with their own sign-in (plugins/connectors/<id>): OAuth
  // with the user's own app, request code written on the node like a REST API.
  { key: 'google-analytics', title: 'Google Analytics 4', description: 'GA4 reports — any dimensions and metrics, realtime and pivots — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Google_Analytics.png', letters: 'GA', tone: '#e37400' },
  { key: 'google-search-console', title: 'Google Search Console', description: 'Clicks, impressions, CTR and position by query, page and country — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Google_Search_Console.png', letters: 'SC', tone: '#4285f4' },
  { key: 'google-ads', title: 'Google Ads', description: 'Any GAQL report and offline conversion uploads — OAuth + developer token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Google_Ads.png', letters: 'GA', tone: '#fbbc04' },
  { key: 'youtube-analytics', title: 'YouTube Analytics', description: 'Views, watch time, subscribers, traffic sources and video stats — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'YouTube.png', letters: 'YT', tone: '#ff0000' },
  { key: 'meta-ads', title: 'Meta Ads', description: 'Facebook and Instagram campaigns, ads and Insights; audiences and Conversions API — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Meta.png', letters: 'MA', tone: '#0866ff' },
  { key: 'facebook-pages', title: 'Facebook Pages & Instagram', description: 'Page posts and insights; Instagram media and insights — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Facebook.png', letters: 'FB', tone: '#1877f2' },
  { key: 'linkedin-ads', title: 'LinkedIn Ads', description: 'Campaigns, creatives and ad analytics by company, job function and seniority — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'LinkedIn.png', letters: 'LI', tone: '#0a66c2' },
  { key: 'linkedin-pages', title: 'LinkedIn Pages', description: 'Company page followers, post statistics and page views — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'LinkedIn.png', letters: 'LP', tone: '#0a66c2' },
  { key: 'salesforce', title: 'Salesforce', description: 'Any object by SOQL or Bulk API; create, update and upsert records — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Salesforce.png', letters: 'SF', tone: '#00a1e0' },
  { key: 'microsoft-dynamics', title: 'Microsoft Dynamics 365', description: 'Every Dataverse table — read, create, update and upsert — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Dynamics_365.png', letters: 'D3', tone: '#0b53ce' },
  { key: 'zoho-crm', title: 'Zoho CRM', description: 'Every module by records or COQL; create, update and upsert — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Zoho_CRM.png', letters: 'ZC', tone: '#e42527' },
  { key: 'outreach', title: 'Outreach', description: 'Prospects, sequences, mailings, calls and tasks; create and update — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Outreach.png', letters: 'OU', tone: '#5951ff' },
  { key: 'salesloft', title: 'Salesloft', description: 'People, cadences, emails, calls and meetings; create and update — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Salesloft.png', letters: 'SL', tone: '#0a5b35' },
  { key: 'tiktok-ads', title: 'TikTok Ads', description: 'Campaigns, ad groups, ads and reports with audience breakdowns — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'TikTok.png', letters: 'TT', tone: '#010101' },
  { key: 'microsoft-ads', title: 'Microsoft Advertising', description: 'Bing Ads campaigns, keywords and performance reports — OAuth + developer token', category: 'api', img: LOGO_PREFIX_2026_11 + 'Microsoft_Advertising.png', letters: 'MS', tone: '#00809d' },
  { key: 'pinterest-ads', title: 'Pinterest Ads', description: 'Campaigns, ads and analytics; boards, pins and organic analytics — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Pinterest.png', letters: 'PI', tone: '#e60023' },
  { key: 'snapchat-ads', title: 'Snapchat Ads', description: 'Campaigns, ad squads, ads and daily or hourly stats — OAuth', category: 'api', img: LOGO_PREFIX_2026_11 + 'Snapchat.png', letters: 'SN', tone: '#fffc00' },
  { key: 'amazon-ads', title: 'Amazon Ads', description: 'Sponsored Products, Brands and Display campaigns and reports — Login with Amazon', category: 'api', img: LOGO_PREFIX_2026_11 + 'Amazon_Ads.png', letters: 'AA', tone: '#ff9900' },

  // Vector
  { key: 'pinecone', title: 'Pinecone', description: 'Connect to Pinecone vector database', category: 'vector', img: LOGO_PREFIX_2026_11 + 'Pinecone.png', letters: 'PC', tone: '#0f172a' },
];

const BY_KEY = CONNECTION_TYPES.reduce((acc, c) => { acc[c.key] = c; return acc; }, {});

// A saved connection records a finer-grained type than the picker offers: an
// import remembers the file format it came from, and a couple of connectors
// are only ever reached through a plugin. Those get their badge here.
const EXTRA_VISUALS = {
  csv:        { key: 'csv',        title: 'CSV',        img: LOGO_PREFIX + 'CSV.png', tone: '#1890ff' },
  excel:      { key: 'excel',      title: 'Excel',      img: LOGO_PREFIX_2026_11 + 'Excel.png', letters: 'XL', tone: '#217346' },
  shopify:    { key: 'shopify',    title: 'Shopify',    img: LOGO_PREFIX_2026_11 + 'Shopify.png', letters: 'SH', tone: '#95bf47' },
  clover_pos: { key: 'clover_pos', title: 'Clover POS', img: LOGO_PREFIX_2026_11 + 'Clover_POS.png', letters: 'CL', tone: '#059669' },
  square_pos: { key: 'square_pos', title: 'Square POS', img: LOGO_PREFIX_2026_11 + 'Square.png', letters: 'SQ', tone: '#7c3aed' },
};

// Type names that mean the same connector under a different spelling.
const ALIASES = {
  tsv: 'csv',
  xlsx: 'excel',
  xls: 'excel',
  api: 'rest-api',
  rest: 'rest-api',
  restapi: 'rest-api',
  sqlserver: 'mssql',
  postgresql: 'postgres',
  mariadb: 'mysql',
  googlesheets: 'google-sheets',
  'google_sheets': 'google-sheets',
  googledrive: 'google-drive',
  'google_drive': 'google-drive',
  'azure-blob-storage': 'azure-blob',
  'azure_blob': 'azure-blob',
};

// Look up the logo/monogram for a connector or database type. Returns null for
// anything unknown so callers can fall back to their own generic icon.
export const connectorVisual = (type) => {
  if (!type) return null;
  const key = String(type).trim().toLowerCase();
  const resolved = ALIASES[key] || key;
  return BY_KEY[resolved] || EXTRA_VISUALS[resolved] || null;
};

// Logo chip. Falls back to monogram letters when a connector has no logo, and
// again if the logo fails to load — the images are hosted remotely, so an
// offline app must still render something recognisable.
export const ConnectorLogo = ({ c, size = 44, imgSize, letterSize, style }) => {
  const [errored, setErrored] = useState(false);
  const showImg = c.img && !errored;
  const letters = c.letters || (c.title || '').slice(0, 2).toUpperCase();
  const inner = imgSize || Math.round(size * 0.64);
  return (
    <div className="cts-ico" style={{
      width: size, height: size, borderRadius: size >= 40 ? 6 : 5,
      background: C.surface, border: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', flexShrink: 0,
      ...style,
    }}>
      {showImg ? (
        <img
          src={c.img}
          alt={c.title}
          style={{ width: inner, height: inner, objectFit: 'contain' }}
          onError={() => setErrored(true)}
        />
      ) : (
        <span style={{
          fontFamily: MONO, fontSize: letterSize || Math.max(8, Math.round(size * 0.25)),
          fontWeight: 700, letterSpacing: '0.04em', color: c.tone || C.muted,
        }}>{letters}</span>
      )}
    </div>
  );
};
