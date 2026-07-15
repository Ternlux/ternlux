# Output node

An Output node takes data from one upstream source and writes it
somewhere.

## Destination

An Output node exports the upstream data to a destination: a local
file path or a saved connection. The downstream flow is completely
different depending on which one you chose, and the chat adjusts the
questions it asks accordingly.

## Loading the source

Before exporting, Ternlux loads the upstream data:

- **Vector source** — pulled in bulk from the vector index, including
  ids, vectors, metadata, and namespace. LanceDB sources are read
  through the local library; Pinecone (and other cloud vector stores)
  are read through their connector's bulk-fetch operation.
- **Local SQL or document source** — read directly from the local
  workspace or local document file.
- **Remote database source** — fetched through the source connector.

## Local file export

When the destination is a local file, you choose the format. Ternlux
supports eight formats:

- **JSON** — plain JSON array.
- **CSV** — comma-separated values.
- **Excel** — single-sheet workbook.
- **NeDB** — local document database file you can re-open later as a
  source.
- **SQLite** — Ternlux infers the right column types per dialect from
  a sample of the data, drops any pre-existing table named the same
  in the file, creates the table, and inserts the rows in a single
  transaction.
- **Parquet** — columnar format with a schema inferred from the data.
- **Avro** — record format with a schema inferred from the data.
- **LanceDB** — vector format, written through the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md)
  skill. Requires the source data to already contain vector fields.

The chat opens the native save dialog with a sensible default
filename (based on the node id and chosen extension), and validates
that you actually picked a path before proceeding.

For SQL-based formats, Ternlux infers types using a single pass over
a sample of the data: dates, timestamps, booleans, integers, floats,
and strings (with sized VARCHAR for the right dialects) are detected
and mapped to the dialect's canonical type.

## Database export

When the destination is a database connection:

- **Vector destination** — Ternlux delegates to the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md)
  skill, which embeds the chosen column and upserts the vectors with
  the rest of the row stored as metadata. For Pinecone, the table
  name field accepts both `index-name` and `index-name/namespace`
  formats — the chat hints at this in the placeholder text.
- **Cloud storage destination** — opens the cloud storage browser so
  you can pick the bucket and path interactively, instead of typing
  the path yourself. Ternlux serialises the data to JSON or CSV
  (based on the file extension you chose) and uploads.
- **Document destination** — Ternlux bulk-inserts the documents into
  the chosen collection.
- **Relational destination** — Ternlux infers column types from the
  data, creates the target table if it doesn't exist, and inserts
  the rows in chunks. The connector's batch-insert path is used when
  available; otherwise Ternlux falls back to chained insert
  statements. Identifier quoting is applied automatically per dialect
  (backticks for MySQL and BigQuery, square brackets for SQL Server,
  schema-qualified names for PostgreSQL and Snowflake).

For BigQuery and Snowflake destinations, the table name field
accepts the dialect's qualified format (`dataset.table` for BigQuery,
`schema.table` for Snowflake) and the chat hints at this in the
placeholder text.

## Retry behaviour

If the output fails at execution time, the chat lets you retry from
the beginning without losing the conversation. Output settings are
reset and reinitialised so you can adjust the destination or format
and try again immediately.
