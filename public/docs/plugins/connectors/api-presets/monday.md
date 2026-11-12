# monday.com

Boards, groups, columns, items and subitems with their column values, updates, users, workspaces and activity logs (GraphQL).
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Click your avatar → **Developers** → **My access tokens** → **Show**.
2. Copy the token (admins can also find it under Administration → Connections → API).

## Add the connection

| Field | What to enter |
| --- | --- |
| API token | monday.com → your avatar → Developers → My access tokens → Show (or Administration → Connections → API). |

**Test connection** calls `POST /v2`.

## Sample data

Create a board with a few items, a status column and a date column.

## What you can read

- Boards with their columns and groups
- Items of a board with column values
- The next page of items
- Find items by a column value
- Updates (comments)
- Users
- Board activity log

## Good to know

- GraphQL errors arrive with HTTP 200 in response.data.errors — throw on them.
- Each query spends complexity budget; ask only for the fields you need. ComplexityException means slow down.
- Ids are numbers in queries and strings in responses.

## Writing to monday.com

An Output node or a Join can send rows to monday.com (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Create an item
- Update an item's columns — matches on item id
- Post an update on an item

- column_values is a JSON STRING keyed by column id; each column type has its own shape (status { label }, date { date }, people { personsAndTeams }).
- No upsert: look the item up with items_page_by_column_values and change it, else create it.

## Troubleshooting

- **Errors with HTTP 200:** GraphQL reports them in the body; Ternlux shows them.
- **ComplexityException:** a query asked for too much at once — ask for fewer columns or items.
