# Mixpanel

Raw events (export), user profiles, segmentation, funnels, retention, cohorts and annotations; import events.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Organization settings → **Service accounts** → **Add service account**.
2. Give it the **Consumer** role (Admin to import events) and access to your project; copy the username and secret.
3. Project settings → copy the **Project ID**.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://mixpanel.com/api, or https://eu.mixpanel.com/api (EU residency) / https://in.mixpanel.com/api (India). |
| Service account username | Mixpanel → Organization settings → Service accounts → Add service account (role Consumer or higher, with access to the project). |
| Service account secret | Shown once when the service account is created. |
| Project ID | Project settings → Overview → Project ID. |

**Test connection** calls `GET /app/me`.

## Sample data

Send a few events from the Mixpanel quick-start snippet, or import a sample CSV.

## What you can read

- Raw events (export)
- User profiles
- Event counts over time, optionally split by a property
- Totals for several events
- A saved funnel's conversion by step
- Saved funnels
- Retention
- Cohorts
- A saved Insights report
- Annotations

## Good to know

- Every query needs project_id (the Project ID field).
- Query API rate limit: 60 queries an hour and 5 concurrent per project; Export: 60 an hour, 3 a second.
- Dates are in the project's timezone.

## Writing to Mixpanel

An Output node or a Join can send rows to Mixpanel (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Import events (historical or server-side) — matches on $insert_id (deduplicated)

- Give every event a stable $insert_id so re-runs do not double-count.

## Troubleshooting

- **401:** the service account has no access to that project.
- **429:** query limits are 60 an hour — fewer, larger queries work better.
