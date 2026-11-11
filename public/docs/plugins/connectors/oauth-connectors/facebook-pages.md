# Facebook Pages & Instagram

Page posts, comments and insights; Instagram profile, media and insights.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Open **developers.facebook.com** → **My Apps** → **Create app** → use case *Other* → type **Business**.
2. Add the **Facebook Login for Business** product; under its Settings add `http://localhost:3000/oauth/callback` to **Valid OAuth Redirect URIs** (Meta allows localhost in development mode).
3. App settings → **Basic**: copy the **App ID** and **App secret**.
4. While the app is in Development mode only people with a role on the app can sign in — add yourself under App roles. Advanced access for other users needs Meta's app review.
5. Paste both into Ternlux and click **Authorize**. Meta issues a long-lived token (about 60 days); click Authorize again when it expires.

## Add the connection

| Field | What to enter |
| --- | --- |
| Meta app ID | developers.facebook.com → My Apps → your app → App settings → Basic → App ID. |
| App secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A Page you manage with a few posts; link an Instagram Business or Creator account to it for Instagram data.

## What you can read

- Pages you manage — WITH each Page's access_token
- Page posts with engagement counts
- Page insights by day
- One post's insights
- Comments on a post
- Instagram account profile
- Instagram posts, reels and carousels
- One Instagram post's insights
- Instagram account insights
- Current stories (last 24 hours only)

## Always up to date

Your Pages and their linked Instagram accounts are read live for each build.

## Good to know

- Instagram requires a Business or Creator account linked to a Facebook Page; its id comes from the Page's instagram_business_account.
- Instagram account insights cover the last 2 years at most and 30 days per request; loop over windows.
- Error code 190 = the token expired or was revoked: reconnect (Authorize again).

## Writing to Facebook Pages & Instagram

Facebook Pages & Instagram is read-only here, so it is not offered as an Output or Join destination.

## Troubleshooting

- **No insights:** Pages with fewer than 100 likes return none.
- **(#100) invalid metric:** Meta retired that metric — drop it.
- **Error 190:** reconnect.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
