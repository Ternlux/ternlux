# MongoDB connector

Representative document-store connector. The same general approach
(collections listed as tables, fields inferred from sample documents,
queries are filter / pipeline objects) applies to other document
stores.

## What it lets you do

- Test that Ternlux can reach your MongoDB cluster.
- List every collection in the connected database, with the database
  name shown as its "schema".
- Inspect the fields of any collection — Ternlux samples up to one
  hundred documents and reports the union of the fields it sees. The
  document id is marked as the primary field.
- Run filter queries to read documents.
- Drop collections and bulk-insert documents — used internally by
  outputs and joins.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Connection URI | Yes | Yes | — |

A single MongoDB URI carries host, port, username, password, and
database name. The full URI is stored encrypted.

## Setting up credentials

### Step 1 — Open MongoDB shell as an admin

Connect to your MongoDB instance with `mongosh` as a user with
`userAdminAnyDatabase` or `dbOwner` on the target database.

### Step 2 — Create a dedicated user

Switch to the `admin` database to create the user:

```javascript
use admin;

db.createUser({
  user: "ternlux",
  pwd: "choose-a-strong-password",
  roles: [
    { role: "readWrite", db: "mydb" }
  ]
});
```

For read-only access, use the `read` role instead of `readWrite`.

### Step 3 — Allow network access

If your MongoDB server is firewalled (especially MongoDB Atlas), add
your machine's IP to the access list:

- **MongoDB Atlas** — go to **Network Access** in the cluster page
  and add your IP.
- **Self-hosted** — open port 27017 (or your custom port) in your
  firewall / security group.

### Step 4 — Build the connection URI

The URI format is:

```
mongodb://USERNAME:PASSWORD@HOST:PORT/DATABASE?retryWrites=true
```

Or for MongoDB Atlas:

```
mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/DATABASE?retryWrites=true&w=majority
```

URL-encode the password if it contains special characters.

### Step 5 — Enter the URI in Ternlux

Paste the full URI into the **Connection URI** field. Ternlux uses
the database from the URI as the default; you can still browse other
databases on the same cluster from the picker.

## How transformations are generated

When you ask the AI to transform data in MongoDB, the assistant
chooses the right approach for the request — see
[Nodes — Transformer](../../nodes/transformer.md) for the full
breakdown.

## Behaviour notes

- Ternlux keeps a small connection pool per saved connection.
- Updating credentials closes the cached connection so the next query
  reconnects with the new URI.
- The connector is also used as a destination for joins and outputs;
  in those modes it accepts bulk inserts that come from data
  assembled in the local workspace or pulled from another source.
