# Google Analytics 4

GA4 reports — any dimensions and metrics, realtime, pivots — via your own Google OAuth client.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **console.cloud.google.com** and pick (or create) a project — the one you use for Google Sheets or Drive in Ternlux works.
2. **APIs & Services → Library**: enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. **OAuth consent screen**: External (or Internal for a Workspace org), add your email as a test user, and **Publish app** to *In production* — in Testing mode Google expires the refresh token after 7 days. An "unverified app" warning is fine for your own use.
4. **Credentials → Create credentials → OAuth client ID**: type **Desktop app** (or Web application with the redirect URI `http://localhost:3000/oauth/callback`).
5. Copy the **Client ID** and **Client secret** into Ternlux, then click **Authorize** and sign in.

## Add the connection

| Field | What to enter |
| --- | --- |
| Google OAuth client ID | Google Cloud console → APIs & Services → Credentials → your OAuth client (type Desktop app or Web application). |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

Any GA4 property you can view works; Google's public **GA4 demo account** (Google Merchandise Store) has rich data — add it from the GA4 docs' "Demo account" page.

## What you can read

- Run a report (any dimensions and metrics)
- Up to 5 reports in one call
- Realtime report (last 30 minutes)
- Pivot report
- Every dimension and metric this property supports (incl. custom ones)
- Check which dimensions/metrics can be combined
- Accounts and their properties (find a property id)
- Web and app data streams of a property
- Key events (conversions)
- Custom dimension definitions

## Always up to date

Your properties, and the chosen property's custom dimensions, custom metrics and key events, are read live each time a node is built.

## Good to know

- propertyId is the number only (123456789), not "properties/123456789" and not the G-XXXX measurement id.
- Common dimensions: date, dateHour, country, city, deviceCategory, sessionDefaultChannelGroup, sessionSource, sessionMedium, sessionCampaignName, pagePath, pageTitle, landingPage, eventName, firstUserSource, itemName. Common metrics: activeUsers, newUsers, sessions, engagedSessions, engagementRate, screenPageViews, eventCount, keyEvents, totalRevenue, purchaseRevenue, ecommercePurchases, averageSessionDuration, bounceRate.
- Custom definitions are named customEvent:<param>, customUser:<prop> and customItem:<param>; the live account details list the real ones.
- Data for the last 48–72 hours can still change (GA4 keeps processing). A scheduled run should re-read the last 3 days.
- Quota is per property per day (tokens); keep returnPropertyQuota: true and do not loop one day per request when one range works.
- 403 PERMISSION_DENIED = the signed-in user has no access to that property; 400 INVALID_ARGUMENT usually names the bad dimension or metric.

## Writing to Google Analytics 4

Google Analytics 4 is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **403 PERMISSION_DENIED:** the signed-in Google user has no access to that property.
- **invalid_grant after a week:** the consent screen is still in Testing — publish it and authorize again.
- **400 INVALID_ARGUMENT:** a dimension or metric name is wrong or the pair is incompatible; the error names it.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
