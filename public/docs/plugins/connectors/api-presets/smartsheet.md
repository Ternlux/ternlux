# Smartsheet

Sheets (rows and columns), reports, workspaces, folders, users and search; add and update rows.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

30-day free trial is enough to try it.

1. Account (avatar) → **Personal Settings** → **API Access**.
2. **Generate new access token**, name it and copy it.
3. EU accounts use `https://api.smartsheet.eu/2.0`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | https://api.smartsheet.com/2.0, or https://api.smartsheet.eu/2.0 for an EU account. |
| API access token | Smartsheet → Account → Personal Settings → API Access → Generate new access token. |

**Test connection** calls `GET /users/me`.

## Sample data

Create a sheet with a few columns and rows.

## What you can read

- Sheets you can see (find the sheet id)
- A sheet's rows and columns
- Reports
- A report's rows
- Workspaces
- Search across sheets
- Users (admins only)

## Good to know

- Cells are keyed by numeric columnId, not title — always map through the sheet's columns. Use displayValue for formatted text, value for raw.
- Rate limit: 300 requests a minute per token; on 429 back off.

## Writing to Smartsheet

An Output node or a Join can send rows to Smartsheet (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Add rows
- Update rows by row id — matches on row id

- No upsert: read the sheet once in state (first batch), index rows by a key column's value, then PUT matches and POST the rest.
- Partial success: send query allowPartialSuccess=true and read response.data.failedItems for per-row errors.

## Troubleshooting

- **401:** the token was revoked.
- **Columns look like numbers:** cells are keyed by column id — the assistant maps them to titles.
