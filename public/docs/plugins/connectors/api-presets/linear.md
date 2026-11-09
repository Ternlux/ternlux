# Linear

Read issues, projects, cycles, teams, users, comments and workflow
states through Linear's GraphQL API. See
[Vendor API connections](README.md) for how these connections work in
general.

## Get a key

Linear's free plan works.

1. Sign up at linear.app and create a workspace.
2. **Settings → Account → Security & access → Personal API keys → New
   key.**
3. Name it. You can limit it to *Read* access and to certain teams.
4. Copy the key (`lin_api_…`).

## Add the connection

| Field | What to enter |
| --- | --- |
| Personal API key | `lin_api_…` |

**Test connection** sends `{ viewer { id name } }` and shows your name.

## Sample data

Create a team (the first one is made for you), then add five or so
issues with different priorities, estimates, labels and assignees. Move
some to *In Progress* and *Done*, put a few in a cycle and in a project,
and add a comment.

## What you can read

Issues, projects, cycles, teams, users, comments and workflow states.
Each endpoint in the sidebar is one GraphQL query; the request is
`POST /graphql` with the fields you ask for.

## Good to know

- Linear's API is GraphQL: ask for the fields you want ("title,
  priority, state name, assignee, completed date") and the assistant
  writes the query.
- Nested objects (state, assignee, team) come back as objects and are
  flattened into columns.
- Pages are walked with `first`/`after` cursors.
- Rate limits count requests and query complexity, so lean field lists
  go further.

## Writing to Linear

An Output node or a Join can send rows to Linear (see [Sending rows to an API](README.md#sending-rows-to-an-api)). A personal API key with write access (not limited to *Read*). Each row becomes one issue; team, state and label names are looked up as ids.

## Troubleshooting

- **401 / "Authentication required":** the key was revoked.
- **Empty results for a team:** the key was limited to other teams.
