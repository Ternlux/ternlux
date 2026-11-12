# Asana

Workspaces, teams, projects, sections, tasks, subtasks, stories (comments), tags, users and custom fields.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. My settings → **Apps** → **Manage developer apps**.
2. Under Personal access tokens, **Create new token**, name it and copy it.

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal access token | Asana → My settings → Apps → Developer apps → Personal access tokens → Create new token. |

**Test connection** calls `GET /users/me`.

## Sample data

Create a project with two sections and a handful of tasks (one completed, one with a due date).

## What you can read

- Workspaces (find the workspace gid)
- Projects
- Tasks of a project, section, or assignee
- Subtasks of a task
- Comments and activity on a task
- Sections of a project
- Users of a workspace
- Projects of a team
- Search tasks (premium workspaces)

## Good to know

- Ids are string gids. Dates (due_on) are YYYY-MM-DD; timestamps ISO-8601.
- Rate limit: 1,500 requests a minute on paid plans (150 free); on 429 wait Retry-After seconds.

## Writing to Asana

An Output node or a Join can send rows to Asana (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create a task
- Update a task — matches on task gid
- Comment on a task
- Up to 10 actions in one request

- No upsert: to update instead of duplicating, list the project's tasks (opt_fields=name) and match on name or a custom field.

## Troubleshooting

- **401:** the token was revoked.
- **Only gid and name come back:** ask for the fields with opt_fields — the assistant does this.
