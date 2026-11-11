# LinkedIn Pages

Company page followers, follower demographics, post statistics, page views and posts.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **linkedin.com/developers** → **Create app** linked to your company Page.
2. **Products** tab → request **Community Management API**.
3. **Auth** tab: add the redirect URL `http://localhost:3000/oauth/callback`; copy the Client ID and Secret.
4. Paste both into Ternlux and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Client ID | linkedin.com/developers → My apps → your app → Auth → Client ID. The app needs the Community Management API product. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A company Page you administer with a few posts.

## What you can read

- Pages you administer
- Page details
- Total followers
- Follower statistics (by function, seniority, industry, country — or over time)
- Post statistics (impressions, clicks, engagement)
- Page views by section and visitor demographics
- The page's posts

## Always up to date

The Pages you administer are read live for each build.

## Good to know

- Times are epoch milliseconds (timeRange.start / end).
- Statistics need the member to be an ADMINISTRATOR (or analyst) of the page; a 403 names the missing role or scope.

## Writing to LinkedIn Pages

LinkedIn Pages is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **403:** you are not an admin of that Page, or the product is not approved.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
