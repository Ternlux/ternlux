# Zendesk

Tickets, comments, users, organizations, groups, ticket metrics, satisfaction ratings and Help Center articles.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

14-day free trial is enough to try it.

1. Admin Center → Apps and integrations → APIs → **Zendesk API**.
2. Turn on **Token access**, click **Add API token**, name it and copy it.
3. Use the email of the agent who made it, and your address (`https://yourcompany.zendesk.com`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | Your Zendesk address, as you see it in the browser. |
| Agent email | The email of the agent or admin who created the token. |
| API token | Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token. |

**Test connection** calls `GET /api/v2/users/me.json`.

## Sample data

Create two or three tickets from the agent workspace and solve one; a satisfaction rating needs a solved ticket.

## What you can read

- Tickets
- Every ticket changed since a time (best for syncing)
- A ticket's comments (conversation)
- Ticket metrics (reply time, resolution time, reopens)
- CSAT ratings
- Users (end users and agents)
- Organizations
- Groups
- Ticket field definitions (names for custom_fields ids)
- Search
- Help Center articles

## Good to know

- Custom ticket fields are in custom_fields as { id, value }; map ids to titles with /api/v2/ticket_fields.
- Rate limits depend on the plan (200–700 requests a minute); on 429 wait Retry-After seconds.

## Writing to Zendesk

An Output node or a Join can send rows to Zendesk (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create or update users (match on email or external_id) — matches on email or external_id
- Create or update an organization — matches on name or external_id
- Create tickets
- Update tickets by id — matches on id

- Bulk endpoints answer with a job_status; poll GET <job_status.url> with tools.sleep until status is "completed", then read results for per-row errors.

## Troubleshooting

- **401:** the email is not the token owner, or token access is off.
- **429:** you hit the plan's rate limit — Ternlux waits and retries.
