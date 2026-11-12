# Plausible

Visitors, pageviews, bounce rate, visit duration and goals by day, page, source, country, device and more.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

30-day free trial is enough to try it.

1. Account settings → **API keys** → **New API key** → choose **Stats API**.
2. Copy the key and note the site domain exactly as Plausible lists it.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://plausible.io, or your self-hosted Plausible address. |
| Stats API key | Plausible → Account settings → API keys → New API key (Stats API). |
| Site domain | The site exactly as it is named in Plausible (no https://). |

**Test connection** calls `POST /api/v2/query`.

## Sample data

Add the script to a test site and visit a few pages.

## What you can read

- Stats query (any metrics by any dimensions)
- Totals (v1)
- Time series (v1)
- Breakdown by a property (v1)
- Current visitors

## Good to know

- Rate limit: 600 requests an hour per API key.
- bounce_rate is a percentage; visit_duration is in seconds.

## Writing to Plausible

Plausible is read-only here.

## Troubleshooting

- **401:** wrong key, or a Sites API key used for stats.
- **400 "site_id":** the site domain does not match Plausible's spelling.
