# Connections

A connection is a saved, named handle to one external system. You set up
a connection once and then reference it from any number of nodes in any
number of workflows.

## What a connection holds

Every connection has:

- A name you choose (e.g. "Production Postgres", "Sales Snowflake").
- A type (which connector backs it).
- A category — database, file, REST API, or cloud storage.
- The non-secret configuration (host, port, base URL, default schema,
  bucket region, etc.).
- The secret configuration (passwords, tokens, API keys), stored
  separately and encrypted.

## Connection types

| Type | What it points at | Examples |
| --- | --- | --- |
| Database | Plugin-driven database connection | PostgreSQL, MySQL, MongoDB, Pinecone, LanceDB |
| File | Local file imported into the workspace | CSV, Excel, Parquet, Avro, JSON, SQLite, NeDB |
| API | REST API base URL plus your own key/value credentials | Auth headers, API keys, tenant ids, query parameters |
| Cloud storage | Bucket-style storage with object pickers | S3, Google Cloud Storage, Azure Blob, Google Drive, SharePoint, OneDrive, Dropbox |

## How forms are built

Ternlux generates the connection form from the connector's own
configuration schema. Each field has a name, a type (text, number,
password, boolean, key/value list), a label, an optional default value,
and a flag indicating whether it's sensitive. Sensitive fields go to the
encrypted credential store; everything else is saved with the public
connection record.

A key/value field (used by the REST API connector) lets you enter up to
50 entries of your own — auth headers, API keys, tenant ids, query
parameters, anything the endpoint needs. Keys must be unique within a
connection, and rows left without a key are discarded when you save. The
values are encrypted and are never sent to the chat: the assistant sees
only your key names and refers to each value by a placeholder, so a key
named `X-API-Key` appears in the generated request as `{{X_API_KEY}}`
and is filled in at run time. When you edit a saved connection the
values come back blank — leave one blank to keep what's stored, or
delete the row to remove it.

For a few connectors with richer setup needs (e.g. Postgres, MySQL,
MSSQL, MongoDB, spreadsheet uploads, local file imports), Ternlux uses
hand-tailored forms instead of the generic builder. The end result is
the same: a saved connection with public + secret parts.

## Contents

- [Credentials and authentication](credentials-and-auth.md) — how
  secrets are stored and how OAuth-based connections are authorised
- [Data Explorer](data-explorer.md) — browsing a database connection's
  schema and running queries against it directly
