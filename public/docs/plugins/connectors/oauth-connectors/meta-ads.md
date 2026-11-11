# Meta Ads

Facebook and Instagram ad accounts, campaigns, ads and Insights; custom audiences and Conversions API.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **developers.facebook.com** → **My Apps** → **Create app** → use case *Other* → type **Business**.
2. Add the **Facebook Login for Business** product; under its Settings add `http://localhost:3000/oauth/callback` to **Valid OAuth Redirect URIs** (Meta allows localhost in development mode).
3. App settings → **Basic**: copy the **App ID** and **App secret**.
4. While the app is in Development mode only people with a role on the app can sign in — add yourself under App roles. Advanced access for other users needs Meta's app review.
5. Paste both into Ternlux and click **Authorize**. Meta issues a long-lived token (about 60 days); click Authorize again when it expires.

## Add the connection

| Field | What to enter |
| --- | --- |
| Meta app ID | developers.facebook.com → My Apps → your app → App settings → Basic → App ID. |
| App secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

An ad account with at least one campaign; a paused campaign with past delivery still has Insights.

## What you can read

- Ad accounts
- Insights — spend, impressions, clicks, conversions (any level, any breakdown)
- Start an async insights job (large ranges or many ads)
- Campaigns
- Ad sets
- Ads
- Creatives
- Custom audiences
- Custom conversions

## Always up to date

Your ad accounts (with currency, timezone and status) are read live for each build.

## Good to know

- Budgets (daily_budget, lifetime_budget) are in the account currency's minor unit (cents); spend in insights is in major units.
- Insights for the last 28 days of conversions can still change (attribution windows): re-read recent days on a schedule.
- Rate limits are per ad account; an error with code 17 or 80004 means slow down — wait and retry, or use an async job.
- Error code 190 = the token expired or was revoked: reconnect the connection (Authorize again).

## Writing to Meta Ads

An Output node or a Join can send rows here:

- Add people to a custom audience (hashed) — matches on Meta matches on the hashes
- Remove people from a custom audience
- Conversions API — send offline / server events — matches on event_id (deduplicated)

- Hash with tools.sha256 — never send raw emails or phone numbers.

## Troubleshooting

- **Error code 190:** the token expired — click Authorize again.
- **Error code 17 / 80004:** rate limit — use smaller date ranges or the async insights job.
- **(#200) permissions:** the app lacks ads_read for that account — check Business Settings.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
