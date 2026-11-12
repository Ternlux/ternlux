# Gorgias

Tickets and messages, customers, satisfaction surveys, users, tags, views and events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

7-day free trial is enough to try it.

1. Settings → **REST API**.
2. Copy the **Base API URL** (`https://yourstore.gorgias.com/api/`) — in Ternlux use the part before `/api`.
3. Copy your **username** (email) and the **API key**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | Your Gorgias address (the helpdesk URL). |
| Account email | The email you sign in to Gorgias with. |
| API key | Gorgias → Settings → REST API → Base API key (or create one). |

**Test connection** calls `GET /api/account`.

## Sample data

Create a test ticket from the helpdesk and add a customer.

## What you can read

- Tickets
- Messages of a ticket
- Customers
- Satisfaction surveys (score, comment)
- Users (agents)
- Tags
- Views
- Events (ticket created, updated, message sent…)

## Good to know

- Datetimes are ISO-8601 UTC.
- Rate limit: 40 requests every 20 seconds per account (more with an API key app); on 429 wait Retry-after seconds.

## Writing to Gorgias

An Output node or a Join can send rows to Gorgias (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a customer
- Update a customer — matches on id
- Create a ticket

- No upsert: GET /api/customers?email=… and PUT the match, else POST.

## Troubleshooting

- **401:** the email and key do not belong together.
- **404:** the base URL includes `/api` twice.
