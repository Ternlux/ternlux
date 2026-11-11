# YouTube Analytics

Views, watch time, subscribers, traffic sources and demographics, plus every video's statistics.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **console.cloud.google.com** and pick (or create) a project — the one you use for Google Sheets or Drive in Ternlux works.
2. **APIs & Services → Library**: enable the **YouTube Analytics API** and **YouTube Data API v3**.
3. **OAuth consent screen**: External (or Internal for a Workspace org), add your email as a test user, and **Publish app** to *In production* — in Testing mode Google expires the refresh token after 7 days. An "unverified app" warning is fine for your own use.
4. **Credentials → Create credentials → OAuth client ID**: type **Desktop app** (or Web application with the redirect URI `http://localhost:3000/oauth/callback`).
5. Copy the **Client ID** and **Client secret** into Ternlux, then click **Authorize** and sign in.

## Add the connection

| Field | What to enter |
| --- | --- |
| Google OAuth client ID | Google Cloud console → APIs & Services → Credentials. Enable "YouTube Analytics API" and "YouTube Data API v3" in the project. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A channel with a few uploaded videos and some views.

## What you can read

- Channel or video analytics report
- The channel (id, title, totals, uploads playlist)
- Every uploaded video (from the uploads playlist)
- Video details and public statistics (up to 50 ids per call)

## Always up to date

Your channel and its uploads playlist are read live for each build.

## Good to know

- Analytics data lags about 2 days; estimatedRevenue and other money metrics need the yt-analytics-monetary.readonly scope (not requested).
- statistics values from the Data API are strings — convert with Number().
- Data API calls cost quota units (10,000 a day by default): list calls are 1 unit each.

## Writing to YouTube Analytics

YouTube Analytics is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **No channel:** pick the Brand Account that owns the channel on Google's sign-in screen.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
