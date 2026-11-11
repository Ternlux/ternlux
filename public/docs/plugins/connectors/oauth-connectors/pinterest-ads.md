# Pinterest Ads

Ad accounts, campaigns, ad groups, ads and their analytics; boards, pins and organic analytics.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **developers.pinterest.com** → **My apps** → **Connect app** (trial access is granted after a short review).
2. Redirect URI `http://localhost:3000/oauth/callback`; copy the **App ID** and **App secret key**.
3. Paste both into Ternlux and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| App ID | developers.pinterest.com → My apps → your app → App ID. |
| App secret key | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A business account with an ad account; boards and pins work on any account.

## What you can read

- Ad accounts
- Campaigns
- Ad groups
- Ads
- Ad account analytics by day
- Campaign analytics
- Ad group analytics
- Ad analytics
- Async report (many entities, targeting breakdowns)
- Audiences
- Your boards
- Pins on a board
- Pin analytics (organic)
- Account analytics (organic)

## Always up to date

Your ad accounts are read live for each build.

## Good to know

- Money columns ending _IN_MICRO_DOLLAR are micros (divide by 1e6); SPEND_IN_DOLLAR is dollars.
- Analytics endpoints allow 90 days per request and about 2 years back — loop over windows.

## Writing to Pinterest Ads

Pinterest Ads is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **401 "Authentication failed":** reconnect.
- **Trial access** limits calls — request Standard access for production.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
