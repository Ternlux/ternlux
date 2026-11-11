# Google Search Console

Clicks, impressions, CTR and position by query, page, country and device — via your own Google OAuth client.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **console.cloud.google.com** and pick (or create) a project — the one you use for Google Sheets or Drive in Ternlux works.
2. **APIs & Services → Library**: enable the **Google Search Console API**.
3. **OAuth consent screen**: External (or Internal for a Workspace org), add your email as a test user, and **Publish app** to *In production* — in Testing mode Google expires the refresh token after 7 days. An "unverified app" warning is fine for your own use.
4. **Credentials → Create credentials → OAuth client ID**: type **Desktop app** (or Web application with the redirect URI `http://localhost:3000/oauth/callback`).
5. Copy the **Client ID** and **Client secret** into Ternlux, then click **Authorize** and sign in.

## Add the connection

| Field | What to enter |
| --- | --- |
| Google OAuth client ID | Google Cloud console → APIs & Services → Credentials → your OAuth client. Enable the "Google Search Console API" in the same project. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

Any verified property works; data needs a few days of search traffic.

## What you can read

- Search performance (clicks, impressions, CTR, position)
- Properties the account can see
- Submitted sitemaps and their status
- Inspect one URL (index status, coverage, mobile usability)

## Always up to date

Your verified properties are listed live for each build.

## Good to know

- Data is available for about the last 16 months and lags 2–3 days; dataState "all" includes fresher, still-changing data.
- Filtering or grouping by query hides anonymised queries, so totals by query are lower than totals by date.
- ctr is a fraction (0.034 = 3.4%); position is the average ranking.
- 403 = the signed-in user is not a user of that property, or the siteUrl does not match exactly (http vs https, trailing slash, sc-domain:).

## Writing to Google Search Console

Google Search Console is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **403:** the user is not on that property, or the siteUrl differs (https vs http, trailing slash, `sc-domain:`).
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
