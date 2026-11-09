# Jira

Read Jira Cloud issues (by JQL), projects, comments, worklogs, change
history, users, statuses, boards and sprints. See
[Vendor API connections](README.md) for how these connections work in
general.

## Get an API token

Jira's free plan (up to 10 users) works.

1. Sign up at atlassian.com/software/jira/free. You pick a site name,
   which becomes your address: `https://your-site.atlassian.net`.
2. Open **id.atlassian.com/manage-profile/security/api-tokens** (avatar →
   *Manage account* → *Security* → *API tokens*).
3. **Create API token** — the plain one, not *Create API token with
   scopes*. Name it and pick an expiry.
4. Copy the token.

The token acts as you, so it can read whatever your account can.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | `https://your-site.atlassian.net` — your site address, no path |
| Atlassian account email | The email you sign in with |
| API token | The token you copied |

**Test connection** calls `GET /rest/api/3/myself` and shows your name.

## Sample data

Create a project from the **Scrum** or **Kanban** template; Jira can add
sample issues. Otherwise create five or so issues of different types and
priorities, move some across the board, add a comment, log work on one,
and start a sprint.

## What you can read

Issues by JQL search, projects, an issue's comments, worklogs and
changelog, users, field definitions, statuses, boards, a board's sprints
and the issues in a sprint.

## Good to know

- Issues are found with JQL, for example
  `project = ABC AND status = Done AND resolved >= -30d`. Describe what
  you want and the assistant writes it.
- A search must be restricted — by project, date, assignee or similar.
  Jira refuses an unrestricted one ("Unbounded JQL queries are not
  allowed"), so "all issues" is read project by project.
- Custom fields appear as `customfield_NNNNN`; the assistant reads the
  field list to name them.
- Comments and descriptions are rich-text documents; generated fetches
  turn them into plain text.
- Dates are ISO-8601 with an offset.

## Writing to Jira

An Output node or a Join can send rows to Jira (see [Sending rows to an API](README.md#sending-rows-to-an-api)). The API token acts as you, so you need permission to create issues in the project. Up to 50 issues per request.

## Troubleshooting

- **401:** wrong email or token, or the email isn't the token owner's.
- **404:** the base URL has a path or a typo; use only
  `https://your-site.atlassian.net`.
- **Empty search:** your account can't browse that project.
