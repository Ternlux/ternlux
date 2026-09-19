# Join node

A Join node merges data from two or more upstream sources. You connect
two or more sources to it, describe how they should join in plain
language, and the AI assistant generates the join operation.

## Required information

Before generating the join, the assistant insists on:

- **The exact column relationships between every pair of tables.**
  Even if two columns are obviously named the same, the assistant
  asks for confirmation.
- **The join type for every pair** — inner, left, right, or full outer.
- **The columns to keep** in the final result.
- **A target table or collection name**, always — a join creates the
  table it writes.

The assistant asks one question at a time, building on what you've
already said. It only proceeds to generate when it's one hundred
percent certain from your explicit statements.

## A join always replaces its target

Every destination route rebuilds the target from this run's rows:
a SQL destination drops it, runs the generated `CREATE TABLE`, then
inserts; local DuckDB does `CREATE OR REPLACE TABLE AS`; a document
store drops the collection first.

So a join has **no write mode**. It cannot append to, merge into, or
preserve what its target already held, and "new table" is the only
operation mode — the executor only creates a destination in that mode,
so any other mode yields a join that cannot make the table it inserts
into.

**To add rows to a table that must keep what earlier runs put there**,
the join writes a staging table and an Output node appends from it:

    sources → join → staging table → output (append) → real destination

Put the staging table on the **destination's own connection** (not
local DuckDB) unless you want the work done locally: a source that
already lives on that connection is then read in place instead of
being pulled across the network and pushed back. The Output node is
the only node type with a write mode.

Appending only rows that aren't already there is a separate problem —
an append matches no keys. Read the destination table as its own data
source, feed it into the join, and anti-join against it (LEFT join on
the identity column, keep the rows with no match).

## Picking the destination

A Join can't be configured at all until it knows where its result
goes — the destination decides the SQL dialect, whether sources have
to be staged, and where the output lands. So selecting a Join with no
destination puts the picker in front of the conversation first. You
can also just name the destination in the chat.

The picker groups every available connection by category — Databases,
Vector, Cloud Storage, APIs, Local Files — and de-duplicates them so
you never see the same connection twice. One local option is always
offered alongside your saved connections: **Local file**, which writes
the joined rows to a table in the workflow's own DuckDB database.

## Destination types

The flow of a join depends entirely on what kind of destination you
chose:

### Relational destination

Ternlux makes the destination database the venue of the join. A source
that already lives on the destination connection is read **in place** —
no copy, no staging. For every source that doesn't, Ternlux creates a
temporary table inside the destination, loads that source's rows into
it (in batches, with chunked inserts), and then runs the AI-generated
join SQL against the temp tables and the tables already living there.
The temp tables are dropped when the join finishes.

Each temp table is named after its source NODE, lower-cased, and is
written into the DDL and the join SQL already quoted for the
destination's dialect — so the table the `CREATE` makes and the table
the load writes to are the same object on every engine.

### Local file destination

The workflow's own DuckDB database is the venue. Local files are read
where they lie — Parquet, CSV or JSON in place — and an upstream node's
output is already a table in that database. Only genuinely remote
sources are pulled across, and those are staged as tables in the same
database. The generated join SQL runs over all of them, its result
becomes this node's table, and the staging tables and views are dropped
afterwards whether the join succeeded or not.

### Document destination

Ternlux loads every source's rows into memory in the background
engine, then runs an AI-generated JavaScript join function over them.
The function's return value (an array of joined documents) is
bulk-inserted into the destination collection. The destination
collection is dropped first.

This is what lets Ternlux join data that lives in entirely different
systems — a relational source with a document source, for example —
into a single document collection.

### Vector destination

Similar to document destinations, but with one additional step:
after the join function produces the joined rows, Ternlux delegates
to the [Vector Database Executor](../plugins/skills/vector-db-executor.md)
skill, which embeds the column you nominated and upserts the
resulting vectors into the destination index. The rest of each row
is preserved as metadata for Pinecone, or as flat columns for
LanceDB.

## Vector sources

If one of your sources is a vector store, the assistant detects two
distinct intents:

- **You just want to read records from the vector store as if it
  were a regular database.** Records are pulled with optional
  metadata filters; the id and metadata fields are flattened into
  row-shaped objects. From there the join is treated like any other
  join.
- **You want similarity search to participate in the join itself.**
  For example, "for each customer, find the five most similar
  articles". Ternlux generates a JavaScript join function that embeds
  the driving values once per unique value, then performs per-row
  similarity searches against the vector source. The join function's
  output is then routed to the destination using the appropriate
  destination flow above.

The vector skill is excluded from the skill list the join builder can
route through: the join engine invokes that behaviour itself when the
request needs it, so there is nothing to pick.

## Limit and offset handling

Each external SQL source is read in chunks. The generated read carries
a `{LIMIT_OFFSET_HERE}` marker that the executor fills with the
pagination the SOURCE engine speaks — `OFFSET … FETCH NEXT` for SQL
Server, `LIMIT … OFFSET` elsewhere — so a large source loads a page at
a time without the query being rewritten per dialect. Local DuckDB
sources are streamed instead of paged, which is linear rather than
quadratic over a big table.

## When a source moves out from under the join

A join step records the connection, the table, the read SQL, the temp
table and its DDL — all generated together, for one specific source.
If that source node is later rebuilt onto a **different table or
connection**, Ternlux re-points the step at the new object but leaves
its SQL and DDL alone, because those describe the old one.

The node is then marked and **the join refuses to run**, naming what
moved. Only rebuilding the join clears it: nothing else regenerates
the statements, and a run allowed through would read the wrong table
where the names happen to line up, or write a `CREATE TABLE` shaped
for columns that no longer exist.

A source whose **columns** changed but whose table is the same is
refreshed silently — the step still reads what it names.

## Persistence across reopens

The chat saves the full join configuration — destination, target name,
per-source temp table names, join SQL, JS function — and the
conversation that produced it, so reopening the node restores
everything you've decided.
