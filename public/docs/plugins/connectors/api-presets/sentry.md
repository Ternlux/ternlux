# Sentry

Organizations, projects, issues, events, releases, teams and Discover queries over errors and transactions.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free Developer plan is enough to try it.

1. Settings → Account → **Personal Tokens** → **Create New Token** (or Organization → Developer Settings → Organization tokens).
2. Give it **org:read**, **project:read** and **event:read**; copy it.
3. Base URL: `https://sentry.io/api/0` (EU: `https://de.sentry.io/api/0`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://sentry.io/api/0 (US), https://de.sentry.io/api/0 (EU), or https://<your host>/api/0 for self-hosted. |
| Auth token | Sentry → Settings → Account → Personal Tokens (or Developer Settings → Organization tokens) with org:read, project:read and event:read. |

**Test connection** calls `GET /organizations/`.

## Sample data

Create a project and send a test error with the SDK's "verify" snippet.

## What you can read

- Organizations (find the org slug)
- Projects
- Issues across the organization
- Error events of a project
- Events of one issue
- Releases
- Discover query (aggregate errors or transactions)
- Usage stats (events accepted, dropped)
- Teams

## Good to know

- Issue counts are strings; firstSeen / lastSeen are ISO-8601.
- Rate limits are per token and endpoint; on 429 wait Retry-After seconds.

## Writing to Sentry

An Output node or a Join can send rows to Sentry (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Bulk update issues (resolve, ignore, assign) — matches on issue id

- Sentry is mostly read here; the token needs event:write to change issues.

## Troubleshooting

- **403:** the token lacks a scope.
- **Empty issues:** the default period is 24h — ask for a longer one.
