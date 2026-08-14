# Join node

A Join node merges data from two or more upstream sources. You connect
two or more sources to it, describe how they should join in plain
language, and the AI assistant generates the join operation.

## Required information

Before generating the join, the assistant insists on:

- **The exact column relationships between every pair of tables.**
  Even if two columns are obviously named the same, the assistant
  asks for confirmation.
- **The join type for every pair** — inner, left, or full outer.
- **The columns to keep** in the final result.

For new-table mode, the assistant also requires a target table or
collection name. The assistant asks one question at a time, building
on what you've already said. It only proceeds to generate when it's
one hundred percent certain from your explicit statements.

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

The mode options shown depend on the destination type:

- **Relational destination** — both "new table" and "merge into
  existing table" are available. For "merge into existing", the chat
  loads the list of existing tables in that destination so you can
  pick one (or type a custom name when nothing matches).
- **Document destination (MongoDB)** — only "new table" is
  available. Document stores don't support upsert semantics for
  arbitrary documents, so Ternlux always creates a fresh collection.
- **Vector destination** — always "new table" (the upsert into the
  index is what the vector skill does for you).

## Destination types

The flow of a join depends entirely on what kind of destination you
chose:

### Relational destination

Ternlux makes the destination database the venue of the join. For
each source that lives outside the destination database, Ternlux
creates a temporary table inside the destination, loads the source's
rows into it (in batches, with chunked inserts), and then runs the
AI-generated join SQL against the temp tables and any tables already
living in the destination. After the join completes, the temp tables
are dropped.

Temp table names are generated to be unique per node and per source
position so two joins running concurrently never collide.

### Local file destination

The workflow's own DuckDB database is the venue. It reads each source
directly — Parquet, CSV or JSON files in place, upstream node tables in
the same database, rows pulled across from remote connections — runs
the generated join SQL over them, and writes the result as this node's
table. No temporary tables are created, and nothing is staged in a
database shared with other workflows.

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

The vector skill is hidden from the explicit "use a skill" picker
for joins because the skill's join behaviour is invoked automatically
by the join engine when needed — there's no need to choose it
manually.

## Limit and offset handling

For relational destinations, the SQL fetched from each external SQL
source is automatically wrapped with the destination database's
preferred pagination syntax (LIMIT/OFFSET, TOP, FETCH, etc.) so
large sources can be loaded in chunks without rewriting the query
for each dialect.

## Execution plan and confirmation

Before running, the chat shows you the full plan: which sources will
be loaded into temp tables, what the join SQL or function looks like,
and what gets inserted at the end. You confirm before anything is
written.

## Error recovery

If a join fails at execution time, the chat surfaces an "Ask AI to
fix the error" affordance so you can describe the fix in plain
language and let the assistant regenerate the relevant piece —
without losing the context of what you've already configured.

## Persistence across reopens

The chat saves the full join configuration (destination, mode,
target name, per-source temp table names, join SQL, JS function) so
reopening the node restores everything you've decided.
