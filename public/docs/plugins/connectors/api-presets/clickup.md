# ClickUp

Workspaces, spaces, folders, lists, tasks with custom fields, comments, time entries and goals.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Avatar → **Settings** → **Apps**.
2. Under API Token, **Generate** and copy it (`pk_…`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal API token | ClickUp → your avatar → Settings → Apps → API Token → Generate. |

**Test connection** calls `GET /user`.

## Sample data

Create a space with a list and a few tasks; add a custom field and log some time on one.

## What you can read

- Workspaces (called teams in the API)
- Spaces of a workspace
- Folders of a space
- Lists of a folder
- Lists not in a folder
- Tasks of a list
- Tasks across the whole workspace (filtered)
- Comments on a task
- Time entries
- Custom fields of a list

## Good to know

- Dates are unix MILLISECONDS as strings (due_date, date_created, date_updated).
- Custom field values are in task.custom_fields[] as { id, name, type, value }; dropdowns hold an option index — map it with type_config.options.
- Rate limit: 100 requests a minute per token (more on higher plans).

## Writing to ClickUp

An Output node or a Join can send rows to ClickUp (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a task
- Update a task — matches on task id
- Set one custom field — matches on task id
- Comment on a task

- No upsert: list the list's tasks and match on name or a custom field, then PUT; else POST.

## Troubleshooting

- **401 "Token invalid":** regenerate the token.
- **Dates look like big numbers:** ClickUp uses milliseconds — the assistant converts them.
