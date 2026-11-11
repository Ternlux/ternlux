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
