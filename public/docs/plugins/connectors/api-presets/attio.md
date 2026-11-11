# Attio

Records of any object (people, companies, deals, custom objects), lists and entries, notes, tasks and members.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

Free plan is enough to try it.

1. Workspace settings → **Developers** → **New access token**.
2. Give it **Read** access to records, lists, notes and tasks (and **Read-write** on records and lists to send rows).
3. Copy the token.

## Add the connection

| Field | What to enter |
| --- | --- |
| API access token | Attio → Workspace settings → Developers → New access token; give it read (and write, to send rows) access to records and lists. |

**Test connection** calls `GET /self`.

## Sample data

Add three People and two Companies, and create a list (pipeline) with a couple of entries.

## What you can read

- Records of an object (people, companies, deals, custom)
- Objects in the workspace (find api_slug)
- An object's attributes and their types
- Lists (pipelines)
- Entries of a list (with entry values such as stage)
- Notes
- Tasks
- Workspace members

## Good to know

- Standard objects: people, companies, deals, users, workspaces; custom ones by their api_slug (see /objects).
- Record ids are data[i].id.record_id.
- Rate limit: about 100 reads and 25 writes a second; on 429 honour Retry-After.

## Writing to Attio

An Output node or a Join can send rows to Attio (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Assert a record — create or update on a unique attribute — matches on matching_attribute (email_addresses for people, domains for companies)
- Create a record
- Update a record (append to multi-value attributes) — matches on record_id
- Add a record to a list

- Prefer the assert (PUT) endpoint so re-runs update instead of duplicating. A companies record links to people through the team attribute.

## Troubleshooting

- **403:** the token lacks the scope for that object or list — edit its permissions.
- **404 on an object:** use its api_slug (people, companies, deals, or your custom slug).
