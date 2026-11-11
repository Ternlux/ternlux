# OAuth connectors

These connectors sign in to a SaaS account with OAuth — you click
**Authorize**, sign in at the provider, and Ternlux keeps the tokens.
Like the [vendor API connections](../api-presets/README.md), their data is
read by request code the assistant writes on a Data Source node (or in the
chat), and the ones that take records can be an Output or Join
destination. What they add:

- **Sign-in with your own app.** Each provider needs an OAuth app (Google
  Cloud client, Salesforce External Client App, Meta app…). Each page below
  shows how to make one; the redirect URL is always
  `http://localhost:3000/oauth/callback`.
- **Tokens that stay fresh.** Access tokens expire within minutes or hours.
  Ternlux refreshes them before each call and saves what the provider sends
  back — including providers that rotate the refresh token (Microsoft,
  Salesforce, Outreach, Pinterest, Zoho) — so connections keep working
  across restarts. A rejected token gets one automatic refresh and retry.
  Meta and LinkedIn issue no refresh tokens to most apps; click
  **Authorize** again when their 60-day token runs out.
- **Your account as it is now.** Each time a node is built, the connector
  reads the account's current details — GA4 properties and their custom
  dimensions, Salesforce objects and fields, Dynamics tables, Zoho modules,
  ad accounts and profiles — so the assistant uses real names and ids,
  including anything added since you connected.
- **Report files.** Report APIs that hand back a compressed file (Amazon
  Ads, Microsoft Advertising) are unpacked for you.

Tokens and secrets are encrypted on this computer with the system keychain;
the assistant only sees field names, never values.

## The connectors

| Connector | What you can read | Receives rows |
| --- | --- | --- |
| [Google Analytics 4](google-analytics.md) | GA4 reports — any dimensions and metrics, realtime, pivots — via your own Google OAuth client | No |
| [Google Search Console](google-search-console.md) | Clicks, impressions, CTR and position by query, page, country and device — via your own Google OAuth client | No |
| [Google Ads](google-ads.md) | Any GAQL report — campaigns, ads, keywords, search terms, conversions — and offline conversion uploads | Yes |
| [YouTube Analytics](youtube-analytics.md) | Views, watch time, subscribers, traffic sources and demographics, plus every video's statistics | No |
| [Meta Ads](meta-ads.md) | Facebook and Instagram ad accounts, campaigns, ads and Insights; custom audiences and Conversions API | Yes |
| [Facebook Pages & Instagram](facebook-pages.md) | Page posts, comments and insights; Instagram profile, media and insights | No |
| [LinkedIn Ads](linkedin-ads.md) | Ad accounts, campaigns, creatives and ad analytics by campaign, company, job function, seniority and country | No |
| [LinkedIn Pages](linkedin-pages.md) | Company page followers, follower demographics, post statistics, page views and posts | No |
| [Salesforce](salesforce.md) | Any object by SOQL (Bulk API for large extracts); create, update and upsert records — via your own External Client App | Yes |
| [Microsoft Dynamics 365](microsoft-dynamics.md) | Every Dataverse table — accounts, contacts, leads, opportunities, cases, custom tables — read, create, update and upsert | Yes |
| [Zoho CRM](zoho-crm.md) | Every module by record list or COQL; create, update and upsert records | Yes |
| [Outreach](outreach.md) | Prospects, accounts, sequences, mailings, calls and tasks; create and update prospects and accounts | Yes |
| [Salesloft](salesloft.md) | People, accounts, cadences, emails, calls and meetings; create and update people and accounts | Yes |
| [TikTok Ads](tiktok-ads.md) | Campaigns, ad groups, ads and reports by any dimensions — spend, impressions, clicks, conversions, audience breakdowns | No |
| [Microsoft Advertising](microsoft-ads.md) | Bing Ads accounts, campaigns, ad groups, ads, keywords and performance reports | No |
| [Pinterest Ads](pinterest-ads.md) | Ad accounts, campaigns, ad groups, ads and their analytics; boards, pins and organic analytics | No |

## Adding one

1. Create the OAuth app at the provider (the connector's page has the steps).
2. **Connections → New connection**, pick the tile under *API*.
3. Paste the client ID and secret (and any other field the form asks for),
   click **Authorize**, sign in and allow access.
4. **Test connection**, then save.

## Using one

Exactly like a vendor API connection: pick it on a Data Source node, choose
an endpoint in the sidebar (optional), and describe what you want in the
node's chat — "sessions and conversions by channel for the last 90 days",
"open opportunities with their account names". The assistant writes the
request, shows you the code, and runs it after you approve. In the chat
assistant, ask your question and it fetches what it needs.

To send rows (Salesforce, Dynamics 365, Zoho CRM, Outreach, Salesloft,
Google Ads conversions, Meta audiences and Conversions API), pick the
connection as an Output node's destination or a Join's destination, see
[Sending rows to an API](../api-presets/README.md#sending-rows-to-an-api).
