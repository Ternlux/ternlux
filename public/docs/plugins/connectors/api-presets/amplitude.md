# Amplitude

Event segmentation, funnels, retention, active users, session length, user activity, cohorts and annotations; send events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free Starter plan is enough to try it.

1. Settings → **Organization settings** → **Projects** → your project.
2. On the General tab copy the **API Key** and **Secret Key**.
3. EU projects use `https://analytics.eu.amplitude.com/api/2`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://amplitude.com/api/2, or https://analytics.eu.amplitude.com/api/2 for EU data residency. |
| API key | Amplitude → Settings → Organization settings → Projects → your project → General → API Key. |
| Secret key | Same page → Secret Key. |

**Test connection** calls `GET /events/list`.

## Sample data

Send a few events from the quick-start SDK snippet.

## What you can read

- Event segmentation (counts, uniques, sums over time)
- Funnel conversion
- Retention
- Active or new users over time
- Average session length
- Event types with this week's totals
- One user's event stream
- Chart annotations

## Good to know

- Dates are YYYYMMDD in the project's timezone. Event JSON goes URL-encoded in the e / se / re parameters.
- Rate limit: about 5 concurrent requests and a per-hour query cost budget; 429 means wait and retry.
- Cohort lists live at /api/3/cohorts (one level up from the base URL).

## Writing to Amplitude

An Output node or a Join can send rows to Amplitude (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Send events (HTTP V2) — matches on insert_id (deduplicated for 7 days)

- Set insert_id per event so a re-run is deduplicated.

## Troubleshooting

- **401:** key and secret are from different projects.
- **400 on segmentation:** the event JSON in `e` is malformed — the assistant URL-encodes it.
