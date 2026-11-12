# Segment

Workspace sources, destinations, warehouses, tracking plans, audit events and API-call / MTU usage; send identify, track and group calls.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Settings → Workspace settings → **Access Management** → **Tokens** → **Create token**.
2. Role: Workspace Member (read-only is enough); copy it (`sgp_…`).
3. To send events: a source's Settings → API Keys → **Write Key**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://api.segmentapis.com, or https://eu1.api.segmentapis.com for an EU workspace. |
| Public API token | Segment → Settings → Workspace settings → Access Management → Tokens → Create token (Workspace Member, read-only). |
| Source write key (for sending events) | Only to send rows: Connections → Sources → your HTTP API source → Settings → API Keys → Write Key. Optional. |

**Test connection** calls `GET /sources?pagination.count=1`.

## Sample data

Create an HTTP API source and a destination.

## What you can read

- Sources
- Destinations
- Warehouses
- Tracking plans
- Daily API calls (billing usage)
- Daily monthly-tracked-users usage
- Audit trail

## Good to know

- Segment's Public API is metadata only; to analyse events, connect the warehouse Segment loads them into.

## Writing to Segment

An Output node or a Join can send rows to Segment (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Send identify / track / group calls (batch) — matches on messageId (deduplicated)

- Sending rows needs the Write key field filled on the connection.

## Troubleshooting

- **Where are my events?** The Public API is metadata only — read events from the warehouse Segment loads.
- **403:** the token's role is too low for that resource.
