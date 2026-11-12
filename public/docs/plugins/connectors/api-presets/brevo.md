# Brevo

Contacts, lists, segments, email and SMS campaigns with stats, transactional email events, CRM deals, companies and tasks.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan (300 emails a day) is enough to try it.

1. Your name (top right) → **SMTP & API** → **API keys** tab.
2. **Generate a new API key**, name it and copy it (`xkeysib-…`).

## Add the connection

| Field | What to enter |
| --- | --- |
| API key | Brevo → your name (top right) → SMTP & API → API keys → Generate a new API key. |

**Test connection** calls `GET /account`.

## Sample data

Import a few contacts into a list and send a test campaign to yourself.

## What you can read

- Contacts
- Lists
- Contacts of a list
- Segments
- Contact attribute definitions
- Email campaigns with statistics
- SMS campaigns
- Transactional email events (delivered, opened, clicked, bounced)
- Transactional email totals for a period
- CRM deals
- CRM companies

## Good to know

- Contact attribute names are UPPERCASE (FIRSTNAME, LASTNAME, SMS).
- Rate limits depend on the endpoint and plan; on 429 wait for x-sib-ratelimit-reset seconds.

## Writing to Brevo

An Output node or a Join can send rows to Brevo (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Import contacts (create or update) into lists — matches on email
- Create or update one contact — matches on email (with updateEnabled: true)
- Create a CRM company
- Create a CRM deal

- Use /contacts/import for many rows — it matches on email, so re-runs update.

## Troubleshooting

- **401 "Key not found":** the key was deleted.
- **403 on IP:** the account restricts API access to authorised IPs — allow yours under Security.
