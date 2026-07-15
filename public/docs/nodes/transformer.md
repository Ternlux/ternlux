# Transformer node

A Transformer node reshapes data from a single upstream source. You
describe what you want done; the AI assistant generates the operation.

## Storage location

You choose where the transformed data should live:

- **Database** — generated and stored inside the same database the
  source comes from.
- **Local** — pulled from the source and stored in Ternlux's local
  workspace. This is automatically the only option when the source is
  already local — you can't choose "database" when the source is a
  local file.

When the storage location is local, the operation mode is forced to
"new table" — you can't perform an in-place update on a remote
database while storing the result locally.

## Operation mode

You also choose how the result relates to the source:

- **New table** — create a brand-new table or collection holding the
  transformed data. The source is left untouched.
- **In place** — modify the source itself by updating, deleting, or
  altering rows or documents.

The chat only asks about storage location when the operation mode is
"new table" — for in-place updates the question is skipped because
the result has to live where the source lives.

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
  and transform rows, plus a local `CREATE TABLE` and parameterised
  insert that the local workspace will run.
- **Relational source, in place** — an `ALTER TABLE`, an `UPDATE` /
  `DELETE`, or both. Filtering intent like "keep only X" becomes a
  delete of the records that don't match.
- **Document source, new collection** — an aggregation pipeline, a
  filter operation, or a custom JavaScript function (Ternlux picks
  the best fit for the request).
- **Document source, in place** — an update, delete, or in-place
  JavaScript transformation. JavaScript transformations are processed
  in batches of ten thousand documents.
- **Local SQL source** — locally-executed `CREATE TABLE`, `INSERT`,
  `UPDATE`, `DELETE`, or `ALTER TABLE` statements.
- **Local document source** — filter, update, delete, or JavaScript
  operations against the local document file.
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

## Refining the operation

After the assistant proposes an operation, you can refine it by
sending a follow-up message ("also exclude records older than 2020",
"use a left join instead", "use the customer name column not the
email"). The assistant regenerates without losing the previous
context, so the conversation keeps building toward the final shape
you want.

## Placeholders

Generated operations may include placeholders like `{{current_date}}`
and `{{current_timestamp}}` that Ternlux substitutes with the actual
runtime values at execution time. This makes it easy to write
transformations like "set archived_date to today" once and have them
work for every future run.

## Preview before save

The chat shows the generated operation (SQL, document operation, or
JS code) along with a brief explanation in plain language and a
preview query so you can confirm the result before saving the node.
