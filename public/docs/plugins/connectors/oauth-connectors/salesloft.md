# Salesloft

People, accounts, cadences, emails, calls and meetings; create and update people and accounts.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Salesloft → Settings → **Your Applications** → **OAuth Applications** → **Create New**.
2. Redirect URI `http://localhost:3000/oauth/callback`; copy the Application Id and Secret.
3. Paste both into Ternlux and click **Authorize**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Application ID | Salesloft → Settings → Your Applications → OAuth Applications → your app → Application Id. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A cadence with a few people.

## What you can read

- People
- Accounts
- Cadences
- Who is on which cadence
- Cadence steps
- Emails (with open/click/reply counts)
- Calls
- Call data records (duration, recording)
- Meetings
- Notes
- Users
- Account stages

## Good to know

- Related records are objects { id, _href } (person.account, owner) — keep the id.
- Rate limit: 600 cost points a minute per team; 429 includes Retry-After.

## Writing to Salesloft

An Output node or a Join can send rows here:

- Create a person
- Update a person — matches on id
- Create an account
- Update an account — matches on id
- Add a person to a cadence

- A person needs email_address or phone + last_name. Creating an existing email returns 422 — look up by email and PUT instead.

## Troubleshooting

- **401 after a while:** reconnect — the refresh token was revoked.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
