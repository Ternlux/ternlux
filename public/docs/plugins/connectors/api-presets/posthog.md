# PostHog

Any HogQL (SQL) query over events, persons and sessions; projects, insights, feature flags, cohorts, annotations; capture events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free tier is enough to try it.

1. Settings → **Personal API keys** → **Create personal API key**.
2. Scopes: **query:read**, and read on projects, persons and insights; copy it (`phx_…`).
3. To send events: Project settings → copy the **Project API key** (`phc_…`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://us.posthog.com, https://eu.posthog.com, or your self-hosted PostHog address. |
| Personal API key | PostHog → Settings → Personal API keys → Create (scopes: query:read, plus project:read, person:read, insight:read as needed). |
| Project API key (for sending events) | Only to send rows: Project settings → Project API key (it is public by design). Optional. |

**Test connection** calls `GET /api/users/@me/`.

## Sample data

Install the snippet on a test page and click around, or capture a few events with the Python or Node library.

## What you can read

- HogQL query (SQL over events, persons, sessions)
- Projects (find the project id)
- Saved insights
- Feature flags
- Cohorts
- Persons
- Annotations

## Good to know

- Query API rate limit: 120 queries an hour per team; list endpoints 240 a minute.
- Timestamps are UTC ISO-8601.

## Writing to PostHog

An Output node or a Join can send rows to PostHog (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Capture events (batch) — matches on uuid (deduplicated)

- Sending events needs the Project API key field filled on the connection.

## Troubleshooting

- **403:** the personal key lacks the scope or the project.
- **The base URL:** US Cloud is `https://us.posthog.com`, EU `https://eu.posthog.com`.
