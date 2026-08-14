# Data Source node

A Data Source node points at exactly one input. At execution time it
makes sure that input is materialised into a form downstream nodes can
read from — usually by writing into the local workspace.

## What you can point it at

You select a saved connection. The connection's category determines how
the node behaves:

- **Database connection** — the node references a specific table,
  collection, or index inside that database. No re-import is needed at
  execution time; downstream nodes read from the live database.
- **Vector database connection** — the node references a specific
  index (and namespace, for Pinecone). For LanceDB, the available
  tables are read directly from the file. For Pinecone, you can
  enumerate indexes / namespaces from the picker.
- **Local file connection** — the node references a file you've
  added as local files (CSV, Excel, Parquet, Avro, JSON, SQLite, NeDB,
  LanceDB). At execution time the file is re-imported into the local
  workspace so downstream nodes see fresh data.
- **Cloud storage connection** — the node references a specific object
  in a bucket. At execution time the object is downloaded and imported
  into the local workspace. The native cloud picker (or the platform's
  own file picker, for Drive) is used to select the file.
- **Spreadsheet service connection** (Google Sheets) — the node
  references a specific sheet. At execution time the sheet is fetched
  and imported into the local workspace.
- **REST API connection** — the node carries an AI-generated fetch
  function. At execution time the function runs (with credentials
  substituted in by the background engine) and the resulting rows are
  written into a local document collection.

## Sample data and schema preview

When you select a table, collection, or index, Ternlux fetches a
small sample (typically five rows) and the inferred column / field
list. This is shown in the chat panel so the AI assistant has
concrete context for any follow-up question (e.g. "what's in this
table?", "summarise the columns"). For sources that don't expose
schema directly, the AI infers it from the sampled rows.

## The REST API path

When you point a Data Source at a REST API connection, you describe
in plain language what data you want and the AI assistant generates a
custom fetch function. The function:

- Receives an HTTP client.
- Loops over pages, cursor tokens, or related endpoints as the API
  requires.
- Returns rows as an array of plain objects.

Once the function is generated, it's saved into the node and is
"clean" — the node can be reopened without Ternlux re-asking the AI.
If you refine your request (e.g. "also include items from the archive
endpoint"), the function is marked dirty and regenerated on the next
save. This avoids unnecessary regeneration on every reopen and keeps
generated code stable.

The function itself uses placeholder tokens, never literal
credentials, when referencing the connection's base URL or auth
header. The placeholders are filled in with real values only inside
the background engine, just before the function runs.

## The cloud storage path

When the source is a cloud bucket file, Ternlux:

1. Downloads the object using the cloud connection.
2. Detects the file type from its extension and shows the appropriate
   icon.
3. Imports the file into the local workspace — spreadsheets, CSVs,
   Parquet, and Avro go into the local SQL workspace; JSON files go
   into a local document collection.
4. Container / bucket names are used as a prefix on the table or
   collection name to avoid collisions when you import the same
   filename from different buckets.

For Excel files with multiple sheets, the chat lets you choose which
sheet (or sheets) to import.

## The local file path

When the source is a local file connection:

- For local SQL files, the original file is re-imported into the
  local workspace so downstream nodes see fresh data.
- For local JSON files, the file is parsed and the documents are
  loaded into a local document collection. Existing documents in the
  same collection are cleared before insert.
- For local LanceDB directories, the table list is read directly from
  the directory and exposed to downstream nodes as-is.

## Idempotency

Re-importing always drops the existing target table or collection
first, so re-running a workflow gives a deterministic result.

## NoSQL and SQL routing

When the source is a remote document store (MongoDB), the chat uses
collection / filter terminology and routes through the document path.
When it's a SQL database, table / query terminology is used. The
underlying difference is hidden from you — the same node config flow
covers both.
