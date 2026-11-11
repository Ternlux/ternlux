# Microsoft Advertising

Bing Ads accounts, campaigns, ad groups, ads, keywords and performance reports.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **entra.microsoft.com** → **App registrations** → **New registration**.
2. Supported accounts: **Accounts in any organizational directory and personal Microsoft accounts**. Redirect URI: platform **Web**, `http://localhost:3000/oauth/callback`.
3. **API permissions → Add a permission**: **Microsoft Advertising API → msads.manage**, delegated; then **Grant admin consent** if your tenant requires it.
4. **Certificates & secrets → New client secret**: copy the **Value** (not the Secret ID).
5. Copy the **Application (client) ID** from Overview. Paste both into Ternlux and click **Authorize**.
6. Microsoft Advertising → Tools → **Developer Portal** → **Account** → request a developer token, and paste it into the connection.

## Add the connection

| Field | What to enter |
| --- | --- |
| Application (client) ID | Microsoft Entra admin center → App registrations → your app (accounts in any organizational directory and personal Microsoft accounts). |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Developer token | Microsoft Advertising → Tools → Developer Portal → Account → Request token (a Universal token works for every account you can access). |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

Any Microsoft Advertising account with a past campaign.

## What you can read

- The signed-in user (its Id)
- Ad accounts of the user
- Campaigns
- Ad groups of a campaign
- Ads of an ad group
- Keywords of an ad group
- Submit a performance report (step 1 of 3)
- Poll the report (step 2 of 3)
- Download the report (step 3 of 3)

## Always up to date

Your ad accounts (with their customer ids) are read live for each build.

## Good to know

- Campaign and report calls need the CustomerAccountId (account Id) and CustomerId (that account's ParentCustomerId) headers — from Accounts/Search, or the live account details. Add them to the request headers yourself.
- Spend and Revenue are in the account currency. TimePeriod is the date column of a Daily report.
- Errors come back with OperationErrors / BatchErrors arrays naming the Code and Message.

## Writing to Microsoft Advertising

Microsoft Advertising is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **105 / InvalidCredentials:** reconnect.
- **CustomerAccountId required:** the assistant adds it from the live account list.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
