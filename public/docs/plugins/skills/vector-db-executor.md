# Vector Database Executor skill

A skill that handles every operation involving embeddings or vector
stores. It is the bridge between regular tabular / document data and
vector indexes, and the engine behind every vector-aware behaviour in
joins, transformers, and outputs.

The skill has the category "both" — it can be selected for both
transformer nodes and join nodes, and it is also called directly by
other nodes (output, data preview) when they need to read or write
vectors.

## Transformer node vs Join node — which one this belongs in

Selecting this skill does NOT decide the node type; the node type is
chosen first, and only some vector work belongs in a transformer:

- **Transformer** — use it only when the operation stays within a single
  source: embedding/vectorising a column into a vector table (Mode 1), or
  in-place maintenance of a vector store's own records — update, delete, or
  tag them, optionally selected by a similarity or metadata search (Mode 2).
  A transformer NEVER produces "row + its matches" output.
- **Join** — use it for ALL similarity *matching*: "for each row, find the
  top-K most similar rows and combine / enrich / attach the matches"
  (recommendations, semantic join, "find similar items"). This is true even
  when the matches come from the SAME vector table (a self-join). Mode 2 is
  the wrong fit here because it only rewrites each record in place — it can't
  emit each row joined to its top-K neighbours. Route these through a JOIN
  node (the join engine calls this skill's join hooks automatically).

## When the AI picks this skill

The assistant offers this skill whenever your request involves:

- Embedding text into vectors and storing them in a vector store.
- Performing semantic similarity search.
- The source or destination is a vector database (Pinecone, LanceDB).
- You mention "embeddings", "vectors", "similarity search",
  "vectorise this column", or "find rows similar to ...".

If you don't have an embedding API key configured (OpenAI), the skill
returns a clear error before any work starts and points you to the
settings screen.

## Embedding providers and models

One embedding provider is supported:

- **OpenAI** — uses the same key as your ChatGPT key.
  - `text-embedding-3-small` (1536 dimensions) — recommended default.
  - `text-embedding-3-large` (3072 dimensions) — higher quality.
  - `text-embedding-ada-002` (1536 dimensions) — legacy.

## Vector destinations

- **LanceDB** — local vector database. No API key required. Default
  when no other vector connection exists.
- **Pinecone (and other cloud vector stores)** — requires a saved
  connection. If only one connection exists for the chosen vector type,
  the skill auto-selects it. If multiple exist, the skill asks you to
  pick which connection by name.

For Pinecone index names, the skill enforces the platform's naming
rules: lowercase letters, numbers, and hyphens only — no underscores,
no uppercase. The skill sanitises the name automatically and tells you
if a rename happened.

## The two modes

The skill behaves very differently depending on whether the source is
already a vector database or not.

### Mode 1 — Source is regular data, destination is a vector store

This is the "embed and insert" path. The skill:

1. Loads all rows from the source. **The source data is not filtered —
   every record from the source is included in the import.** There is
   currently no way to narrow down or exclude rows on the way in; if you
   need a subset, filter the data before it reaches this skill (for
   example with a transformer upstream).
2. Picks the embedding column you nominate, plus the embedding
   provider and model.
3. For OpenAI, estimates the cost up front from the token count of
   the texts to embed. Costs above one US dollar trigger a warning so
   you can confirm before sending data to a paid API.
4. Generates embeddings in batches — one hundred texts per batch —
   handling large datasets without overwhelming the provider.
5. Tags each record with the original text, the provider, the model,
   and an embedded-at timestamp so future debugging is easy.
6. Upserts the resulting vectors into the destination, with the rest
   of the row preserved as metadata.

If your data already contains a vector field (`vector`, `values`, or
`embedding`), the skill skips the embedding step and just upserts —
useful when you're moving vectors between stores.

### Mode 2 — Source is a vector store

When the source is a vector database, the skill behaves like a
NoSQL-style transformer. You describe what should be done in plain
language ("update all archived vectors to set status to 'inactive'",
"delete vectors with views below 10", "tag all vectors similar to
'product documentation' as documentation").

The skill drives the workflow in three steps:

1. **Find the vectors to act on.** Two search methods are available:
   - **Embedding search.** You describe a search query in natural
     language. The skill embeds your query using the same model the
     vectors were produced with, then runs a similarity search to find
     matching records.
   - **Metadata filter.** For Pinecone, a filter object on metadata
     fields. For LanceDB, a SQL `WHERE` clause. An empty filter means
     "all records" — the skill warns when this would affect every
     vector in the index.
2. **Apply a transform function to each found record.** The AI writes
   a small JavaScript function that receives the record plus a shared
   state object that persists across the loop. The function returns:
   - The modified record → Ternlux **updates** the record in the index.
   - `null` → Ternlux **deletes** the record from the index.
   - The unchanged record → Ternlux **skips** the record (no operation).
   - The new state → passed to the next record. The state is useful
     for counting, grouping, or tracking changes across the run.
   You can optionally seed an initial state object.
3. **Apply the changes.** Updates and deletes are batched and pushed to
   the index. For LanceDB, updates are implemented as delete-then-add.
   If the schema changed (a new field was added), the entire table is
   recreated with the merged schema preserved.

The skill always confirms with a plain-language explanation of what it
will do before running.

## Used by joins

The skill exposes two narrow hooks the join engine calls when a join
involves a vector source or destination:

- **Pull rows from a vector source for a join** — the skill fetches
  vectors using either an embedding search or a metadata filter, then
  flattens each record so the id and metadata fields appear as
  top-level keys (the vector itself is dropped because it isn't useful
  as a join key). From the join's perspective, the vector source then
  looks like any other tabular source.
- **Embed and upsert joined rows into a vector destination** — after
  the join engine produces the joined rows, this hook embeds the
  column you nominated and upserts the resulting vectors into the
  destination index. For LanceDB the rest of the row is flattened into
  the record; for Pinecone the rest is preserved as metadata.

This is what enables joins to mix vector and non-vector sources
freely, and to land the result anywhere — including back into a
vector store.

## Used by outputs

When you choose a vector store as an Output destination, Ternlux
delegates the embedding and upsert to this skill. The same applies to
the LanceDB local-file export format. The skill auto-detects whether
the source data already contains vectors (which it does when the
source is itself a vector store) or whether it needs to embed first.

## Used by data previews

The skill is also called when you preview data from a vector source
in the UI. Vectors are shown in a compact form (`[N dimensions]`)
rather than dumping the raw float arrays, with the id, metadata, and
namespace shown in full.

## Common failure modes

- **No embedding API key configured.** The skill returns a clear
  error before doing anything else.
- **Dimension mismatch.** When upserting into Pinecone, the index's
  dimension must match the model's dimension. If they don't, the
  upsert fails with the specific dimension numbers shown.
- **No valid text in the embedding column.** The skill skips empty /
  null values rather than embedding empty strings.
- **Index does not exist (Pinecone).** Pinecone indexes must be
  created in the Pinecone dashboard first — Ternlux does not create
  them. LanceDB tables are created automatically on first upsert.

## What the skill remembers per record

When upserting into Pinecone (where vectors and metadata are stored
separately), Ternlux preserves:

- The vector itself.
- Every original column from the source row as metadata.
- The text that was embedded.
- The embedding provider and model used.
- The timestamp the record was embedded.

When upserting into LanceDB (where the schema is flat), the same
fields are stored as columns alongside the vector. Null values are
replaced with empty strings to keep the underlying storage format
happy.
