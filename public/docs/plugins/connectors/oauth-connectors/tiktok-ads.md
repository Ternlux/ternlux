# TikTok Ads

Campaigns, ad groups, ads and reports by any dimensions — spend, impressions, clicks, conversions, audience breakdowns.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **business-api.tiktok.com/portal** → **My Apps** → **Create an app** (needs approval; a few days).
2. Advertiser redirect URL: `http://localhost:3000/oauth/callback`; tick the read scopes (Ad account, Ads management read, Reporting).
3. Copy the **App ID** and **Secret** into Ternlux and click **Authorize**; pick the advertiser accounts to grant.

## Add the connection

| Field | What to enter |
| --- | --- |
| App ID | business-api.tiktok.com/portal → My Apps → your app → Basic Information → App ID. |
| App secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

An advertiser account with a campaign that ran; a sandbox advertiser works for testing.

## What you can read

- Report — spend, impressions, clicks, conversions by any dimensions
- Campaigns
- Ad groups
- Ads
- Advertiser account details
- Custom audiences

## Always up to date

The advertiser accounts granted at sign-in are listed live for each build.

## Good to know

- IMPORTANT: TikTok answers HTTP 200 even on errors. Check response.data.code — anything but 0 is an error; throw with response.data.message.
- Array and object query parameters (dimensions, metrics, filtering, advertiser_ids) are JSON strings: JSON.stringify([...]).
- Every call needs the advertiser_id of one of the advertisers granted at sign-in (see the live account details).

## Writing to TikTok Ads

TikTok Ads is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **code 40001 / 40105:** the token or app id is wrong — reconnect.
- **Errors on HTTP 200:** TikTok reports them in `code`; the generated code checks it.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
