# Pinecone connector

Cloud vector database from Pinecone. Marked as a vector store, which
unlocks the vector-aware code paths throughout DagFlux. Most embedding
and similarity-search operations on Pinecone go through the
[Vector Database Executor](../skills/vector-db-executor.md) skill.

## What it lets you do

- Test that DagFlux can reach Pinecone with your API key.
- List every index in your account along with each index's
  namespaces. Each index/namespace combination shows up as a separate
  "table" in the picker, with metadata like dimension, metric, vector
  count, pod count, replica count, and pod type.
- Inspect the standard vector contract: id (primary), values (the
  vector itself, with the index dimension shown), metadata, and
  namespace.
- Run vector operations: similarity search, fetch by id, upsert
  vectors, update vectors, and delete vectors (by id list, by
  metadata filter, or all in a namespace).
- Bulk-extract every vector in an index/namespace, optionally filtered
  by metadata. Used by the Output node and by joins that read vector
  sources.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| API Key | Yes | Yes | — |

A single Pinecone API key. Stored encrypted.

## Setting up credentials

### Step 1 — Create a Pinecone account

Sign up at [pinecone.io](https://www.pinecone.io). The free tier is
sufficient for evaluation.

### Step 2 — Create at least one index

DagFlux does not create Pinecone indexes for you — they must exist
before you can write to them.

1. From the Pinecone console, click **Create Index**.
2. Pick a name. Pinecone names must be lowercase letters, numbers,
   and hyphens only — DagFlux will sanitise any name you provide
   later, but creating the index with a clean name is easier.
3. Set the **dimension** to match the embedding model you plan to
   use:
   - `text-embedding-3-small` → 1536
   - `text-embedding-3-large` → 3072
   - `text-embedding-ada-002` → 1536
   - `sentence-transformers/all-MiniLM-L6-v2` → 384
   - `BAAI/bge-small-en-v1.5` → 384
4. Pick a metric (cosine is the safe default).
5. Pick a pod size / capacity tier and create.

### Step 3 — Generate an API key

1. From the Pinecone console, open **API Keys** in the left nav.
2. Click **Create API Key**.
3. Give it a name (e.g. `dagflux`).
4. Copy the key — it's shown only once.

### Step 4 — Enter the API key in DagFlux

Paste the key into the **API Key** field. DagFlux will list every
index in your account along with their namespaces.

## Vector operations

Pinecone supports the full set of vector operations:

- **Similarity search** — find the most similar vectors to a query
  vector, with optional metadata filtering and result count.
- **Fetch by id** — pull specific records when you know their ids.
- **Upsert** — insert or update one or many vectors.
- **Update** — modify a single vector's values or metadata.
- **Delete** — by id list, by metadata filter, or "delete all in this
  namespace".

## Index naming rules

Pinecone has strict naming rules: lowercase letters, numbers, and
hyphens only — no underscores, no uppercase. DagFlux automatically
sanitises the index names you provide:

- Uppercase becomes lowercase.
- Invalid characters become hyphens.
- Sequences of hyphens collapse to a single hyphen.
- Leading or trailing hyphens are stripped.

If a rename happens, DagFlux logs the original name and the
sanitised name so you can spot it.

## Behaviour notes

- **Each (index, namespace) pair is a separate table.** Pinecone has
  one extra dimension over a regular database: namespaces. DagFlux
  surfaces each one as its own table in pickers, with the namespace
  shown as the schema and the index as the name. Stats include
  dimension, metric, vector count, pod count, replicas, and pod type.
- **Indexes must be pre-created in the Pinecone dashboard.** DagFlux
  does not create them for you — and the index dimension must match
  the embedding model dimension you plan to use.
- **Vectors as joinable rows.** When you use a Pinecone source in a
  join (Scenario A — vector store as a regular database), the id and
  metadata fields are flattened into top-level columns and the
  vector itself is dropped. From there the join treats it like any
  tabular source.
- **In-place transformations.** When you use a Pinecone source in a
  Transformer node, DagFlux automatically routes the operation
  through the Vector Database Executor skill, which lets you find
  records (by similarity search or metadata filter) and apply a
  per-record transform that updates, deletes, or skips each one.
  See the skill page for the full behaviour.
