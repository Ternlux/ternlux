# Embeddings

Ternlux uses embeddings — fixed-length numeric vectors produced from
text — for any operation that involves a vector store: writing rows
into a vector index, performing similarity search inside a join, or
exporting a dataset to a vector destination.

## Provider routing

Ternlux supports one embedding provider:

- **OpenAI** — used when an OpenAI key is configured.

If it isn't configured, any vector-related operation that needs
embeddings fails fast with a clear error message.

## Default models

When you don't pick a specific embedding model, Ternlux uses the small
OpenAI text embedding model from the current generation.

You can pick a different model on any operation. The model determines
the dimension of the vectors produced — Ternlux passes that dimension
through to the destination vector index.

## Where embeddings are produced

- **Joins that perform similarity search per row** — Ternlux embeds the
  driving values once per unique value, then runs per-row similarity
  searches against the vector source. This avoids re-embedding the same
  text many times.
- **Joins or transformations that write into a vector destination** —
  Ternlux runs the join or transformation first, then embeds the column
  you nominate, then upserts the resulting vectors into the
  destination index.
- **Outputs to a vector destination** — same pattern: embed the chosen
  column, upsert vectors with the rest of the row preserved as metadata.
