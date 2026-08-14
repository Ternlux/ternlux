# Data Explorer

The Data Explorer is a direct query workspace for a saved database
connection. You browse the schema, inspect a table's columns, write a
query, and run it against the live database — the same kind of tool as a
standalone database client, built into Ternlux so you don't have to leave
the app to look at your data.

Open it from the **Connections** tab: choose a database connection and
pick **Explore DB**. It opens in a panel over the connections list.

The Explorer needs the desktop app. Direct database connections are made
by the local background engine, so outside the desktop app the panel
shows a notice instead of a schema tree.

## Which connections can be explored

Any **database** connection whose connector can list tables, list
columns, and run queries — which covers every relational and document
database Ternlux ships a connector for.

Vector stores, cloud storage, and REST API connections have no Explore
action. Those have their own preview paths: vector indexes are queried
from the vector skill, cloud objects through the storage browser, and
REST endpoints through the generated fetch function on a Data Source
node.

## The schema tree

The left panel lists what the connection can see. Press **Load Schema**
to read it, and the refresh button to re-read it after the database
changes.

- Tables are grouped under their schema, schemas sorted alphabetically,
  tables sorted within each schema.
- Each schema shows a count of the tables inside it.
- Views and collections carry a tag so you can tell them apart from
  ordinary tables.
- If the connection exposes only one schema, it expands automatically.
  With several, everything starts collapsed.

## Column inspector

Selecting a table loads its columns into a collapsible panel above the
editor:

- **Column** — the column name, with a key icon on primary keys.
- **Type** — the database's own type name.
- **Nullable** — whether the column accepts nulls.

If the connector can't report column metadata, the panel says so and the
query editor still works.

## Writing queries

Selecting a table also pre-fills the editor with a starting query. The
shape of that query — and the language the editor highlights — depends on
whether the connection is relational or a document store.

### Relational databases (SQL)

The editor is a SQL editor: syntax highlighting, line numbers, and word
wrap. The pre-filled query is a preview of the table you selected,
limited to 100 rows, built two ways for correctness:

- The **connector's own preview syntax** is used, so the statement is
  valid for that database rather than a generic `SELECT`.
- The table name is **quoted the way that database expects** —
  schema-qualified for PostgreSQL and Snowflake, backticks for BigQuery,
  square brackets for SQL Server.

You can replace it with anything. The editor is free text and the
statement runs as written, so alongside `SELECT` you can run joins,
aggregates, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, or
anything else the connection's credentials are permitted to do.

### Document stores (MongoDB and other NoSQL)

The editor switches to JSON. Selecting a collection pre-fills a query
document:

```json
{
  "collection": "orders",
  "filter": {},
  "limit": 100
}
```

- **`collection`** — which collection to read.
- **`filter`** — a MongoDB filter document. `{}` matches everything;
  narrow it the same way you would in any Mongo client, e.g.
  `{ "status": "shipped", "total": { "$gt": 100 } }`.
- **`limit`** — the maximum number of documents to return.

## Running a query

Press **Run**, or `Cmd/Ctrl+Enter` from inside the editor.

**Statements execute immediately.** There is no preview, no approval
step, and no confirmation prompt. Whatever is in the editor is sent to
the database exactly as written, using the credentials saved on that
connection. If the statement modifies or removes data — `UPDATE`,
`DELETE`, `DROP`, `TRUNCATE`, `ALTER` — it does so the moment you run it,
and Ternlux cannot undo it.

This is deliberate: the Explorer is a direct client, not a guided
builder. It behaves differently from the per-node chat panels, which
generate an operation and show you a preview before anything is saved or
run. Two habits are worth keeping:

- **Read before you write.** Start from the pre-filled `SELECT`, narrow
  it until the rows are the ones you mean, and only then turn it into a
  change.
- **Scope the credential.** If a connection only ever needs to read,
  create it with a read-only database user. That puts the limit in the
  database, where it holds regardless of what gets typed into an editor.

### Local files (CSV, JSON, Parquet)

A file connection accepts `INSERT`, `UPDATE`, `DELETE` and `ALTER` too,
even though no file format supports changing a row where it lies. The
statement is simply run first. If it fails — which is what DuckDB does
when asked to write to a file, since files are exposed as read-only
views — the statement is identified and its target worked out, then it
runs against a copy of that file, which is written back over the
original in its own format. The write goes to a temp file and is renamed
into place, so a failure leaves the file as it was.

A failed statement changes nothing (DuckDB rolls it back), so nothing is
ever run twice, and a statement that turns out not to be a write just
reports its original error.

Two consequences worth knowing:

- **The file is rewritten, not edited.** A CSV comes back with the
  quoting and formatting DuckDB writes, which is not necessarily
  character-for-character what was there before. Only the file the
  statement actually changed is rewritten — the others are read where
  they lie and never copied.
- **Any attached file, not just the one you opened.** Other local files
  are attached so you can join across them, and you can write to them
  too: `UPDATE people.people SET …` rewrites that file and leaves the
  rest alone.

### Local databases (DuckDB and SQLite)

A connection pointing at a `.duckdb` or `.sqlite` file behaves like a
real database, because it is one. Its tables are attached and addressed
where they live, so `UPDATE`, `INSERT`, `DELETE` and `ALTER` run
natively — nothing is copied and no file is rewritten. SQLite goes
through DuckDB too, and is written through it, so the same statements
work on either.

Several databases can be open at once and joined to each other, and to
CSV/JSON/Parquet files, in a single query — a SQLite table joined to a
DuckDB table joined to a CSV is one statement.

Reading a SQLite database needs DuckDB's `sqlite` extension, which it
downloads the first time and caches per machine. That one moment needs
a network connection; everything after it is local.

## Reading results

The result area reports how many rows came back, then renders them:

- **Relational results** appear as a table, 50 rows per page, scrolling
  horizontally for wide result sets. Nulls are shown as a distinct
  `NULL` rather than an empty cell.
- **Document results**, and any result the connector returns as JSON,
  appear as a formatted JSON block.

If the query fails, the database's own error message is shown above the
results and the editor keeps your query so you can correct it and run
again.

Queries you run in the Explorer are ad-hoc, so they are not saved into a
workflow and do not create entries in the execution history. Only
workflow runs are recorded there.

## What leaves your machine

The query goes from the background engine to the database the connection
points at. Results come back to your machine and are displayed.

Nothing goes to Ternlux. Unlike the per-node chat panels and the app-wide
assistant, the Explorer makes no AI calls at all — queries you write here
and the rows they return are not sent to any AI provider.

## Related

- [Connections](README.md) — what a connection holds and how forms are
  built
- [Credentials and authentication](credentials-and-auth.md) — how the
  secret part of a connection is stored and used at query time
- [Transformer chat](../chat-prompts/transformer.md) — the guided,
  preview-before-save path for generating an operation instead of writing
  it yourself
