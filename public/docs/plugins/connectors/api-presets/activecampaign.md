# ActiveCampaign

Contacts, lists, tags, campaigns, automations, deals, accounts and custom fields.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

14-day free trial is enough to try it.

1. Settings (bottom left) → **Developer**.
2. Copy the **URL** (e.g. `https://youraccount.api-us1.com`) and the **Key**.
3. In Ternlux, the base URL is that URL plus `/api/3`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | ActiveCampaign → Settings → Developer → URL, with /api/3 on the end. |
| API key | ActiveCampaign → Settings → Developer → Key. |

**Test connection** calls `GET /users/me`.

## Sample data

Add a few contacts, a list and a tag, and send a small campaign to yourself.

## What you can read

- Contacts
- Lists
- Tags
- Campaigns (sends, opens, clicks, unsubscribes)
- Automations
- Deals
- Deal stages
- Accounts (companies)
- Contact custom field definitions
- One contact's custom field values

## Good to know

- Most numbers and ids come back as strings; deal value is in cents.
- Related objects are side-loaded by id (contact.orgid, deal.contact); ask for include=… or fetch them separately.
- Rate limit: 5 requests a second per account.

## Writing to ActiveCampaign

An Output node or a Join can send rows to ActiveCampaign (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create or update a contact by email — matches on email
- Bulk import contacts (create or update) — matches on email
- Subscribe a contact to a list
- Tag a contact
- Create a deal

- Prefer /contact/sync (one contact) or /import/bulk_import (many) — both match on email, so re-runs update.

## Troubleshooting

- **403:** the key is wrong or the user lost API access.
- **404 on every call:** the base URL is missing `/api/3`.
