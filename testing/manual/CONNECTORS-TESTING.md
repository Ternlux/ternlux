# Testing the OAuth connectors and API-token presets

This covers the 18 OAuth connectors (`plugins/connectors/<id>`), the 25 new
REST presets (`plugins/connectors/rest-api/presets`), and the token-refresh
hook (`public/lib/oauthTokens.js`).

## 1. Automated tests (no accounts needed)

```bash
npm run test:unit
CI=true npx react-scripts test --watchAll=false --testPathPattern connections/apiPresets
```

`testing/unit/apiConnectors.test.js` covers:
- **Token refresh:** a token is refreshed before it expires and saved; a provider that doesn't rotate keeps its refresh token; two runs at once share one refresh; a failed refresh reports why.
- **Sign-in:** the authorization URL with PKCE, and the code exchange and refresh form bodies (including Basic client auth) against a mock token server.
- **Placeholders:** each connector's placeholders, base URL and headers.
- **401 retry:** a 401 forces one refresh and one retry.
- **Live account details:** for GA4 and Salesforce.
- **File helpers:** gzip, zip, CSV and sha256.
- **Every connector:** its data and its setup guide.

`apiPresets.test.js` checks all 40 presets and their guides.

## 2. Run the app in dev

```bash
npm run electron-dev
```

The dev renderer is now served on **port 3100**, so port 3000 stays free for the OAuth callback (`http://localhost:3000/oauth/callback`). Before this change, OAuth sign-in could not work in dev, because the React server was using port 3000.

## 3. Per-connection test (same steps for each)

1. **Connections → New connection** → the tile under *API*.
2. **Fill the form:**
   - **OAuth:** create the app first. The steps are in `public/docs/plugins/connectors/oauth-connectors/<id>.md`, and the in-app assistant can walk you through them ("how do I set up Salesforce?"). Fill in the client ID and secret, click **Authorize**, and sign in.
   - **Token:** fill in the fields from `public/docs/plugins/connectors/api-presets/<id>.md`.
3. **Test connection.** It should say "Connected to X as …".
4. **Read:** add a Data Source node, pick the connection, pick an endpoint (optional), and ask for something in the node chat. Approve the code and run it.
5. **Analysis:** ask the main chat a question about the data. It writes code with `ctx.apiCredentials`.
6. **Write** (where supported): add an Output node or a Join with the connection as the destination. Pick a write endpoint, then build and run it. Check the records in the service.
7. **Token refresh:** for any connection with a short-lived token (Google, Salesforce, Microsoft, Snapchat, Outreach, Zoho), test once, wait past its expiry (or edit `expiryDate` in the connection record to the past), and run again.
   - The run should succeed.
   - `db-credentials.dat` should hold the new token.
   - The connection's `dbConfig.expiryDate` should have moved forward.
8. **Live account details:** rebuild a GA4 or Salesforce node after adding a custom dimension or field in the service. The assistant should use the new name without being told it.

## 4. What to try per service

| Connector | Free way to test | Read prompt | Write prompt |
| --- | --- | --- | --- |
| Google Analytics 4 | GA4 demo account (Google Merchandise Store) | "sessions and conversions by default channel group, last 90 days, by week" | — |
| Search Console | Any verified site | "top 100 queries by clicks last 28 days with CTR and position" | — |
| Google Ads | Test manager + test client account | "campaign cost, clicks and conversions by day, last 30 days" | offline click conversions (needs gclids) |
| YouTube Analytics | Your channel | "views and watch time per video this year" | — |
| Meta Ads | An ad account with past delivery | "spend, impressions and purchases by campaign by day, last 14 days" | add emails to a custom audience |
| Facebook Pages & Instagram | A Page (≥100 likes for insights) + linked IG | "my last 50 Instagram posts with likes, reach and saves" | — |
| LinkedIn Ads | Ad account (Advertising API approved) | "campaign spend and clicks by month" | — |
| LinkedIn Pages | A company Page you admin | "follower count and post impressions last 30 days" | — |
| Salesforce | Free Developer Edition org | "open opportunities with account name, stage and amount" | upsert contacts by email / external id |
| Dynamics 365 | Power Apps Developer Plan | "active accounts with revenue and primary contact" | create contacts |
| Zoho CRM | Free account (sample data) | "deals closing this quarter with owner" | upsert leads by email |
| Outreach | Your instance | "prospects added this month and their sequence state" | create/update prospects |
| Salesloft | Your instance | "people on cadence X" | create/update people |
| TikTok Ads | Sandbox advertiser | "spend and conversions by campaign by day, last 30 days" | — |
| Microsoft Advertising | Any account with history | "campaign performance report, last month, daily" (submit → poll → zip) | — |
| Pinterest Ads | Business account | "campaign spend and clicks last 30 days" | — |
| Snapchat Ads | Ad account with history | "daily spend and swipes per campaign, last 14 days" | — |
| Amazon Ads | Sponsored Products account | "SP campaign report, last 7 days" (async gzip report) | — |
| Close, Attio, ActiveCampaign, Apollo | Trials / free plans | contacts or leads updated this month | upsert contacts (sync / assert / run_dedupe) |
| Zendesk, Front, Gorgias | Trials | tickets created this week with status and assignee | create/update users or customers |
| Asana, monday, ClickUp, GitLab, Sentry, Smartsheet | Free plans | open tasks or issues per project | create tasks, issues or rows |
| Brevo, Customer.io, Mixpanel, Amplitude, PostHog, Segment, Plausible | Free plans | events or campaigns over the last 30 days | Brevo contacts import; Customer.io / Mixpanel / Amplitude / PostHog / Segment events |
| Shopify, WooCommerce, Square | Dev store / own site / sandbox | orders this month with totals | customers |
| BambooHR, Twilio | Trials | employees by department; messages and cost by day | add employee; send SMS (billed) |

## 5. What was validated, and against what

Each connector and preset file records its sources in its header comment. The facts were taken from Airbyte's manifests and docs and n8n's node definitions, cloned 2026-11-12:

- **Hosts and versions:**
  - Google Ads v23
  - Meta Graph v23.0
  - LinkedIn-Version 202601 (Ads) / 202610 (Pages)
  - Bing Ads v13 REST and Reporting
  - TikTok open_api v1.3
  - Pinterest v5
  - Snapchat v1
  - Amazon Ads regional hosts
  - Outreach v2, Salesloft v2
  - GA4 Data/Admin v1beta
  - Search Console webmasters/v3
- **Auth:** the token endpoints, scopes and header names (`developer-token`, `DeveloperToken`/`CustomerAccountId`, `Access-Token`, `Amazon-Advertising-API-ClientId`/`-Scope`, `Zoho-oauthtoken`) all match Airbyte's manifests.
- **Report formats:** Microsoft Advertising reports are zipped CSV (Airbyte's `BingAdsReportZipCsvDecoder`) and Amazon reports are gzipped JSON. `tools.unzip` and `tools.gunzip` handle both.
- **Discovery:** Salesforce, Dataverse and Zoho discover their objects at runtime, as Airbyte does. Ternlux does this on every build, through each connector's live account details.
- **Writes:** n8n's operations were the checklist (Salesforce upsert on external id, Zoho upsert with `duplicate_check_fields`, ActiveCampaign contact sync, Brevo upsert, Customer.io identify/track).
- **Left out:**
  - **NetSuite and X Ads**, per your call.
  - **Heap:** there's no read API; data leaves through Heap Connect. Neither Airbyte nor n8n has a source for it.
  - **Amplitude raw export:** it's a zip of gzip files.

### Not verified without real accounts

The automated tests run against mock servers; no real account was used:

- No sign-in or API call was made against a real provider.
- The OAuth callback server's handling of a busy port was not run live.
- Provider rules that only show up live (redirect URL rules, app review, API access tiers) are documented in each guide but untested.
