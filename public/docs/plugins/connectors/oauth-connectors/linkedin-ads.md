# LinkedIn Ads

Ad accounts, campaigns, creatives and ad analytics by campaign, company, job function, seniority and country.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **linkedin.com/developers** → **Create app** (you need a LinkedIn Page to attach it to).
2. **Products** tab → request **Advertising API** (approval can take a few days).
3. **Auth** tab: add `http://localhost:3000/oauth/callback` as an authorized redirect URL; copy the **Client ID** and **Client Secret**.
4. Paste both into Ternlux and click **Authorize**. Tokens last 60 days.

## Add the connection

| Field | What to enter |
| --- | --- |
| Client ID | linkedin.com/developers → My apps → your app → Auth → Client ID. The app needs the Advertising API product. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

An ad account you have a role on (Campaign Manager → Account settings → manage access).

## What you can read

- Ad accounts
- Campaign groups
- Campaigns
- Creatives
- Ad analytics (spend, impressions, clicks, conversions) by a pivot
- Ad analytics with up to 3 pivots at once
- Conversion definitions

## Always up to date

Your ad accounts are read live for each build.

## Good to know

- Ids come back as numbers in some fields and URNs (urn:li:sponsoredCampaign:123) in others; keep the number after the last colon to join.
- costInLocalCurrency is a string in the account currency.
- A 426 or "version not supported" error means the LinkedIn-Version header is too old — it is set on the connection.
- Analytics data is retained for 2 years at most.

## Writing to LinkedIn Ads

LinkedIn Ads is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **403:** the member has no role on that ad account, or the Advertising API is not approved yet.
- **426 / version not supported:** the LinkedIn-Version is retired — update the connector.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
