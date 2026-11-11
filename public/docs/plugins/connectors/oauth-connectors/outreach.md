# Outreach

Prospects, accounts, sequences, mailings, calls and tasks; create and update prospects and accounts.
See [OAuth connectors](README.md) for how these connectors work in general.

## Create your app

1. Outreach **Developer Portal** → **Create app** → API access (OAuth).
2. Redirect URI `http://localhost:3000/oauth/callback`; add the scopes listed in the connector (read on prospects, accounts, sequences, mailings…; write on prospects and accounts).
3. Copy the Client ID and secret; Authorize in Ternlux.

## Add the connection

| Field | What to enter |
| --- | --- |
| Client ID | Outreach → Settings → Integrations → My apps (developer portal) → your app → API access → Client ID. |
| Client secret | From the same OAuth app. |
| Redirect URI | Add exactly this URL to the OAuth app's allowed redirect URLs. Optional. |

Click **Authorize**: your browser opens the provider's sign-in, and Ternlux receives the tokens on `http://localhost:3000/oauth/callback`. Then **Test connection** and save.

## Sample data

A few prospects in a sequence.

## What you can read

- Prospects (people)
- Accounts (companies)
- Opportunities
- Sequences
- Who is in which sequence, and their state
- Sequence steps
- Emails sent (opens, clicks, replies)
- Calls
- Tasks
- Users
- Prospect stages

## Good to know

- Flatten each record: { id, ...attributes } plus the related ids you need (relationships.account.data.id, relationships.owner.data.id).
- filter ranges use "..": filter[updatedAt]=2025-01-01T00:00:00Z..inf.
- Rate limit: 10,000 requests an hour per user; 429 carries the reset time.

## Writing to Outreach

An Output node or a Join can send rows here:

- Create a prospect
- Update a prospect — matches on id
- Create an account
- Update an account — matches on id

- No upsert endpoint: look the prospect up by email (or the account by domain) and PATCH it, else POST. Ids are integers.

## Troubleshooting

- **403:** a scope is missing from the app — add it and reconnect.
- **redirect_uri_mismatch:** the redirect URL in your app must be exactly `http://localhost:3000/oauth/callback` (or what you typed in the connection's Redirect URI field).
- **Port 3000 busy:** close the program using it while you authorize.
