# Apollo.io

Your CRM contacts, accounts, deals, sequences and users; search Apollo's people and company database.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Settings → Integrations → **API** → **Create new key**.
2. Tick **Set as master key** for contacts, accounts and sequences (or pick the endpoints).
3. Copy the key.

## Add the connection

| Field | What to enter |
| --- | --- |
| API key | Apollo → Settings → Integrations → API → Create new key. A master key is needed for contacts, accounts and sequences. |

**Test connection** calls `GET /auth/health`.

## Sample data

Save a few people to your contacts from Apollo search, and create an account and a deal.

## What you can read

- Contacts saved in your Apollo account
- Accounts saved in your Apollo account
- Deals
- Sequences
- Users in your team
- Search Apollo's people database (no emails or phones)
- Search Apollo's company database

## Good to know

- Database searches cost credits on most plans; contacts/accounts searches of your own data do not.
- Emails and phone numbers from the database need the enrichment endpoints (people/match), which consume credits — ask before using them.
- Rate limits depend on the plan and are returned in x-rate-limit-* headers.

## Writing to Apollo.io

An Output node or a Join can send rows to Apollo.io (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a contact — matches on email when run_dedupe is true
- Update a contact — matches on id
- Create an account
- Update an account — matches on id

- Send run_dedupe: true on contact creation so a re-run updates the existing contact instead of duplicating it.

## Troubleshooting

- **403 "master key required":** recreate the key as a master key.
- **402 / credits:** database searches and enrichment spend credits on most plans.
