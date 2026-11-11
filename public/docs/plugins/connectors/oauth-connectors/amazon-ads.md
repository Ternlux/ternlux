# Amazon Ads

Sponsored Products, Brands and Display campaigns, ad groups, keywords, targets and v3 reports.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **developer.amazon.com** → **Login with Amazon** → **Create a New Security Profile**; under Web Settings add the allowed return URL `http://localhost:3000/oauth/callback`.
2. Apply for **Amazon Ads API** access for that security profile (advertising.amazon.com/API → Onboarding); approval is required.
3. Copy the **Client ID** and **Client Secret**, pick your region, and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Login with Amazon client ID | developer.amazon.com → Login with Amazon → your security profile → Web Settings → Client ID. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |
| Region | The region of the marketplaces you advertise in. One connection per region. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A Seller or Vendor Central account with Sponsored Products, or a test account from the Ads API onboarding.

## What you can read

- Advertising profiles (one per marketplace and account)
- Sponsored Products campaigns
- Sponsored Products ad groups
- Sponsored Products keywords
- Sponsored Products product/category targets
- Sponsored Products ads
- Sponsored Brands campaigns
- Sponsored Display campaigns
- Portfolios
- Create a v3 report (step 1 of 3)
- Report status (step 2 of 3)
- Download the report (step 3 of 3)

## Always up to date

Your advertising profiles for the region are read live for each build.

## Good to know

- Every call except /v2/profiles needs the header Amazon-Advertising-API-Scope: <profileId> — add it per request (see the live account details).
- v3 endpoints need their versioned media type in BOTH Content-Type and Accept; a 415 means the media type is wrong.
- cost and sales are in the profile currency.
- 429 means throttled: wait (tools.sleep) and retry.

## Writing to Amazon Ads

Amazon Ads is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **401 "Not authorized to access scope":** the profile id is from another region, or the security profile is not approved.
- **415:** a v3 endpoint needs its versioned media type.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
