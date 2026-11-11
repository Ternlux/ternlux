# Snapchat Ads

Ad accounts, campaigns, ad squads, ads and creatives, with daily, hourly and lifetime stats.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **business.snapchat.com** → Business Details → **OAuth Apps** → **+ OAuth App**.
2. Redirect URI `http://localhost:3000/oauth/callback`; copy the **Snap Client ID** and **Client Secret** (shown once).
3. Paste both into Ternlux and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| OAuth client ID | business.snapchat.com → Business Details → OAuth Apps → your app → Snap Client ID. |
| OAuth client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

An ad account with a past campaign.

## What you can read

- Organizations (with their ad accounts)
- Ad accounts
- Campaigns
- Ad squads (ad sets)
- Ads
- Creatives
- Audience segments
- Stats for the account, or broken down by campaign / ad squad / ad
- Stats for one campaign (also /adsquads/{id}/stats, /ads/{id}/stats)

## Always up to date

Your organizations and ad accounts are read live for each build.

## Good to know

- Every list wraps each item: { campaigns: [{ sub_request_status, campaign: {…} }] } — unwrap item.campaign.
- spend and *_value fields are in micro-currency: divide by 1e6.
- request_status "ERROR" with debug_message explains a bad request even on HTTP 200 for some calls; check it.

## Writing to Snapchat Ads

Snapchat Ads is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **E1008 / timezone:** stats start and end must be on midnight in the ad account's timezone.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
