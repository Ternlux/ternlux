# Transformer node

A Transformer node reshapes data from a single upstream source. You
describe what you want done; the AI assistant generates the operation.

A transformer is a terminal write: it persists its own result as part
of running, so nothing has to be added after it to save the output.

## Storage location

You choose where the transformed data should live:

- **Database** — generated and stored inside the same database the
  source comes from.
- **Local** — pulled from the source and written to a table in the
  workflow's own DuckDB database, `workflow-data/<workflow>.duckdb`.
  Previews and downstream nodes query that table with SQL. This is
  automatically the only option when the source is already local — you
  can't choose "database" when the source is a local file.

Each workflow gets its own database, so two workflows running at the
same time never touch the same file, and table names only have to be
unique within one workflow.

When the storage location is local, the operation mode is forced to
"new table" — you can't perform an in-place update on a remote
database while storing the result locally.

A transformer can only write to its own source connection or to local
storage. It has no field for a different saved connection, so it can
never move data from connection A into connection B — that is an
Output node's job, and a data source can feed one directly.

## Operation mode

You also choose how the result relates to the source:

- **New table** — create a brand-new table or collection holding the
  transformed data. The source is left untouched.
- **In place** — modify the data by updating, deleting, or altering
  rows or documents rather than producing a separate result. This
  changes the source itself: a database table is altered where it
  stands, and a local file is rewritten. An in-place transformer's
  target IS its source table.

The chat only asks about storage location when the operation mode is
"new table" — for in-place updates the question is skipped because
the result has to live where the source lives.

## One structural and one data change per node

A transformer runs at most one DDL statement and at most one DML
statement, in that order. A request that needs two structural changes,
or a structural change interleaved with two data changes, is two
transformer nodes.

## How the AI generates the operation

The assistant uses a different prompt depending on the source's
database type. Each prompt knows the dialect and idioms of that
database and produces operations that follow them. The assistant
first asks any clarifying questions it needs (which mode, which
target name, which storage location), then generates the operation.

The chat applies database-specific identifier quoting automatically
(schema.table for PostgreSQL, square brackets for SQL Server,
dataset.table for BigQuery, etc.) — you don't have to think about
the dialect.

## What gets generated

The shape of the generated operation depends on the source:

- **Relational source, new table in the same database** — a `CREATE
  TABLE`, an `INSERT INTO ... SELECT`, and a preview query.
- **Relational source, new table stored locally** — a `SELECT` to fetch
  and transform rows. DuckDB writes the result straight into the node's
  table; the `SELECT` defines the shape, so no local `CREATE TABLE` is
  generated.
- **Relational source, in place** — an `ALTER TABLE`, an `UPDATE` /
  `DELETE`, or both. Filtering intent like "keep only X" becomes a
  delete of the records that don't match.
- **Document source, new collection** — an aggregation pipeline, a
  filter operation, or a custom JavaScript function (Ternlux picks
  the best fit for the request).
- **Document source, in place** — an update, delete, or in-place
  JavaScript transformation, applied in batches.
- **Local file, in place** — the `ALTER TABLE`, `UPDATE` and `DELETE`
  statements that make the change. The file is copied into a scratch
  table, the statements run against that, and the result is **written
  back over the file you imported**. Only what those statements touch
  changes. The write-back happens only if the whole script got through,
  so a failure leaves the file as it was, and the scratch table is
  dropped either way. A local *database* file (`.duckdb`, `.sqlite`) is
  modified directly, with no copy.
- **Vector source** — automatically routed through the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md)
  skill. You don't get a choice here — vector sources can't be acted
  on by SQL or vanilla NoSQL operations. The assistant generates a
  search step (similarity search or metadata filter) plus a per-record
  transform function that updates, deletes, or skips each matching
  vector.

## Skill-routed transformations

If the request is a better fit for a skill (Python, JavaScript, vector
operations) than for vanilla SQL or NoSQL, the AI assistant offers to
route the transformation through that skill instead. The skill
generates and runs its own logic and writes the result to the chosen
destination. If a skill returns an empty plan (rare), the assistant
falls back to vanilla generation so the node is never left without an
operation.

Note that the JavaScript skill's output is local-only — a table in the
workflow's DuckDB database. It cannot write back to a SQL or document
server, so a request that needs per-row JavaScript *and* a result
living in Mongo or SQL is two steps.

## Refining the operation

After the assistant proposes an operation, you can refine it by
sending a follow-up message ("also exclude records older than 2020",
"use the customer name column not the email"). The assistant
regenerates without losing the previous context, so the conversation
keeps building toward the final shape you want.

## When the source moves out from under the transformer

A transformer's generated SQL names its source table, and an in-place
transformer's target IS that table. So if the source node is later
rebuilt onto a **different table or connection**, Ternlux re-points the
node's recorded input at the new object but leaves the SQL and the
target alone — they describe the old one.

The node is then marked and **the transformer refuses to run**, naming
what moved. Only rebuilding it clears that. Without the refusal an
in-place transformer would go on writing to the table its source had
abandoned, and report success.

A source whose **columns** changed but whose table is the same is
refreshed silently; if the transformation names a column that no longer
exists, the chat's review says which node and which column.

## Preview before save

The chat shows the generated operation (SQL, document operation, or
JS code) along with a brief explanation in plain language and a
preview query so you can confirm the result before saving the node.
