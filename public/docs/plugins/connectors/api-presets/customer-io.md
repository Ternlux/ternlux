# Customer.io

Campaigns, newsletters, broadcasts and their metrics, segments and members, messages, activities and people; identify people and track events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

14-day free trial is enough to try it.

1. Settings → Account Settings → **API Credentials** → **App API Keys** → **Create App API Key** (pick the workspace).
2. To send rows too: the **Track API Keys** tab → copy the **Site ID** and **API Key**.
3. Base URL: `https://api.customer.io/v1` (EU: `https://api-eu.customer.io/v1`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://api.customer.io/v1 for a US account, https://api-eu.customer.io/v1 for an EU account. |
| App API key | Customer.io → Settings → Account Settings → API Credentials → App API Keys → Create App API Key. |
| Site ID (for sending rows) | Only to send rows: Settings → Workspace Settings → API Credentials → Track API Keys → Site ID. Optional. |
| Track API key (for sending rows) | Only to send rows: the API Key next to that Site ID. Optional. |

**Test connection** calls `GET /workspaces`.

## Sample data

Add a few people (People → Add People), build a segment and send a newsletter to yourself.

## What you can read

- Campaigns
- A campaign's metrics
- Newsletters (one-off sends)
- A newsletter's metrics
- API-triggered broadcasts
- Segments
- People in a segment
- Messages sent (with delivery metrics)
- Activity log
- One person's attributes

## Good to know

- Timestamps are unix seconds.
- App API rate limit: 10 requests a second.

## Writing to Customer.io

An Output node or a Join can send rows to Customer.io (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Identify people and track events (batch) — matches on identifiers (email or id)

- Sending rows needs the Site ID and Track API key fields filled on the connection.

## Troubleshooting

- **401 on reads:** use the App API key, not the Track key.
- **401 on writes:** the Site ID and Track API key are missing or swapped.
