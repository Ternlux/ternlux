# Google Ads

Any GAQL report — campaigns, ads, keywords, search terms, conversions — and offline conversion uploads.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **console.cloud.google.com** and pick (or create) a project — the one you use for Google Sheets or Drive in Ternlux works.
2. **APIs & Services → Library**: enable the **Google Ads API**.
3. **OAuth consent screen**: External (or Internal for a Workspace org), add your email as a test user, and **Publish app** to *In production* — in Testing mode Google expires the refresh token after 7 days. An "unverified app" warning is fine for your own use.
4. **Credentials → Create credentials → OAuth client ID**: type **Desktop app** (or Web application with the redirect URI `http://localhost:3000/oauth/callback`).
5. Copy the **Client ID** and **Client secret** into Ternlux, then click **Authorize** and sign in.
6. Google Ads → Tools → **API Center**: copy the **developer token** into the connection. A new token works only on test accounts until Google approves Basic access (since September 2026 access can also be granted to the Cloud project).
7. If your accounts sit under a manager (MCC) account, put its id in **login-customer-id**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Google OAuth client ID | Google Cloud console → APIs & Services → Credentials. Enable the "Google Ads API" in the same project. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Developer token | Google Ads → Tools → API Center. Leave blank only if your Cloud project was granted API access directly. Optional. |
| Manager account id (login-customer-id) | Only when your accounts are under a manager (MCC) account: its id, digits only. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

Create a Google Ads **test manager account** (ads.google.com, "test account") and a test client under it to try queries without spend.

## What you can read

- Run a GAQL query (any report)
- Accounts this login can reach
- GAQL with paging (nextPageToken)

## Always up to date

The accounts your login can reach, with names, currencies and which are managers, are read live for each build.

## Good to know

- Common resources: customer, campaign, ad_group, ad_group_ad, ad_group_criterion (keywords), keyword_view, search_term_view, campaign_budget, geographic_view, user_location_view, shopping_performance_view, conversion_action, customer_client (a manager's accounts).
- Money is in micros: metrics.cost_micros / 1e6 is the cost in account currency. ctr is a fraction.
- Date filters: segments.date DURING LAST_7_DAYS|LAST_30_DAYS|THIS_MONTH|LAST_MONTH, or segments.date BETWEEN '2025-01-01' AND '2025-01-31'. A query that selects segments.date must also filter on it.
- Under a manager account: query the client's customerId and send login-customer-id = the manager id (set on the connection).
- Errors: DEVELOPER_TOKEN_NOT_APPROVED = the token only works on test accounts; USER_PERMISSION_DENIED = wrong login-customer-id; the error body's details[].errors[].message names the bad field.

## Writing to Google Ads

An Output node or a Join can send rows here:

- Upload offline click conversions (from your CRM)
- Upload offline call conversions

- Conversions are not deduplicated by the API on re-runs — keep the same orderId per conversion to let Google drop duplicates.
- conversionDateTime needs a timezone offset (yyyy-mm-dd hh:mm:ss+|-hh:mm) and must be after the click.

## Troubleshooting

- **DEVELOPER_TOKEN_NOT_APPROVED:** the token only works on test accounts — apply for Basic access.
- **USER_PERMISSION_DENIED:** set login-customer-id to the manager account.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
