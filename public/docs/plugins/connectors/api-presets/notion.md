# Notion

Read database rows, page properties and content, comments and users.
See [Vendor API connections](README.md) for how these connections work
in general.

## Get a secret

A free Notion plan works.

1. Sign in at notion.so.
2. Open **notion.so/profile/integrations** (Settings → Connections →
   *Develop or manage integrations*).
3. **New integration**: give it a name, pick the workspace, type
   **Internal**, and save.
4. Under **Capabilities**, *Read content* is enough. Turn on *Read
   comments* or *Read user information* if you need them.
5. Copy the **Internal integration secret** (`ntn_…`).
6. **Share your pages with it.** Open each database or page you want to
   read, click **•••** (top right) → **Connections** → add your
   integration. Sharing a parent page shares everything under it.

**Step 6 is the one people miss.** The integration sees nothing until a
page is shared with it.

## Add the connection

| Field | What to enter |
| --- | --- |
| Internal integration secret | The secret you copied |

**Test connection** calls `GET /v1/users/me` and shows the integration's
name.

## Sample data

Create a page with a **database** (a table): add columns such as Status
(select), Owner (person), Due (date) and Estimate (number), fill in five
or so rows, and share the page with the integration.

## What you can read

Search across shared pages and databases, database rows (queries with
filters and sorts), a database's schema, single pages and their
properties, page content blocks, comments and workspace users.

## Good to know

- Notion now calls a database's table a **data source**: a database has
  one or more data sources, and rows are read from the data source. Ask
  by database name and the assistant finds the id with search first.
- Ids are the 32-character hex string at the end of a Notion URL.
- Property values are nested by type (title, select, date…); generated
  fetches flatten them into plain columns.
- Rate limit: about 3 requests a second.

## Writing to Notion

An Output node or a Join can send rows to Notion (see [Sending rows to an API](README.md#sending-rows-to-an-api)). In the integration's **Capabilities**, turn on *Insert content* and *Update content*, and share the database with it. Rows are written one at a time (about three a second).

## Troubleshooting

- **Search returns nothing, or 404 on a database:** the page isn't shared
  with the integration (step 6).
- **401:** the secret was regenerated — copy the new one.
