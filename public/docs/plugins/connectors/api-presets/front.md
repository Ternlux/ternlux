# Front

Conversations and messages, inboxes, contacts, accounts, teammates, tags and events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

7-day free trial is enough to try it.

1. Settings → **Developers** → **API tokens** → **Create API token**.
2. Pick the scopes (shared resources, or private for your own inbox) and copy it.

## Add the connection

| Field | What to enter |
| --- | --- |
| API token | Front → Settings → Developers → API tokens → Create API token (choose the scopes and inboxes it may read). |

**Test connection** calls `GET /me`.

## Sample data

Connect an email inbox, send it a couple of messages and tag one.

## What you can read

- Conversations
- Search conversations
- Messages of a conversation
- Inboxes
- Contacts
- Accounts (companies)
- Teammates
- Tags
- Activity events (assign, tag, archive, reply…)

## Good to know

- Timestamps are unix seconds with decimals.
- Rate limit depends on the plan (50–500 requests a minute); on 429 wait Retry-After seconds.

## Writing to Front

An Output node or a Join can send rows to Front (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a contact
- Update a contact (alt:email:a@b.com works as the id) — matches on contact id or alt:email:<email>
- Create an account
- Update an account — matches on id

- A contact id can be written as alt:email:<address>, so an update by email needs no lookup; a 404 means create it instead.

## Troubleshooting

- **403:** the token's scope does not include that inbox or resource.
