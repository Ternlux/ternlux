# Join chat

The Join chat assists you in describing how two or more sources should
be combined. It runs in two phases — analyse first, then generate the
join — and never assumes information it hasn't been given.

## Information the assistant must gather

Before generating, the assistant insists on:

- **The exact column relationships between every pair of tables.** Even
  if two columns are obviously named the same, the assistant asks for
  confirmation.
- **The join type for every pair** — inner, left, or full outer.
- **The columns to include in the final result.**
- **For new-table mode, the target table or collection name.**

The assistant asks one specific question at a time, building on what
you've already said. It only proceeds to generate when it's one
hundred percent certain from your explicit statements.

## Vector-aware behaviour

When at least one source is a vector store or you mention embeddings or
similarity, the assistant decides which of two scenarios applies:

- **Scenario A — vector store as a regular database.** You just want to
  read records (id and metadata fields) and join them on a normal key.
  No embeddings, no similarity search. The assistant writes a
  metadata-only fetch and joins the resulting rows like any other
  source.
- **Scenario B — embedding or similarity search inside the join.** You
  want embeddings to participate in the join logic itself, e.g. "for
  each customer match the five most similar articles". The assistant
  expresses the entire embedding plus search plus match flow inside a
  JavaScript join function, which DagFlux runs in the background
  engine.

The assistant asks only the questions Scenario B actually needs:
which column to embed, which vector source to search, an embedding
provider and model if there's a choice, and the desired similarity top
count.

## Destination-aware generation

The assistant emits a different shape depending on what kind of
destination you chose:

- **Relational destination** — generates per-source SQL or operations
  that DagFlux uses to load each external source into a temporary
  table, plus the final SQL that joins the temp tables and any tables
  already in the destination. Every per-source query includes a marker
  that DagFlux replaces with the destination's preferred pagination
  syntax, and the column order across the create-table statement,
  the select, and the explicit column list always matches.
- **Document destination** — generates per-source fetch operations and
  a JavaScript join function that combines them into the final
  documents.
- **Vector destination** — generates per-source fetch operations, a
  JavaScript join function that produces the joined rows, and a
  vector-destination block describing which column to embed and which
  embedding provider and model to use.

## Behavioural rules

- The assistant never invents a vector engine for the destination. If
  the destination is a document store, that's fine — the embedding and
  similarity search happen in the background engine before insertion.
- The assistant never asks you to "switch to a SQL engine that can
  execute embeddings" because none is required.
- The assistant treats each table pair independently — different pairs
  can use different join types in the same join.
- When a skill (e.g. the JavaScript executor or the vector skill) is a
  better fit than vanilla SQL or NoSQL, the assistant routes the join
  through the skill instead.
