# Skill capabilities at run time

When the AI assistant generates a piece of code (a transformation, a
join function, a REST API fetch, or a skill invocation), that code runs
inside DagFlux's background engine. Wherever it runs, it sees the same
predictable set of capabilities — so the AI's mental model of "what's
available to me" is the same across every node and every skill.

## What generated code can do

- **Look up your saved connections** by name or id, including their
  type, category, and whether they're a vector store.
- **Read and write data** through one unified data-access helper. The
  helper handles both saved connections (looked up by name or id) and
  local files (referenced by their absolute path and storage type).
  Whether the underlying system is SQL, document, or vector, the call
  shape is the same.
- **List tables / collections / indexes** and the columns or fields of
  any of them.
- **Call the AI** for a sub-task, with the same provider routing and
  history trimming the rest of the app uses.
- **Embed text into vectors** using whichever embedding provider is
  configured.
- **Make arbitrary HTTP requests** through a shared HTTP client.
- **Log to the run output** with a tagged prefix.

## Why this matters

The benefit of presenting one consistent surface is that the AI can
generate the same code regardless of which path is going to run it.
For example, a join function that performs per-row similarity search
uses the exact same calls whether the destination is a relational
database, a document store, or a vector store. The AI doesn't need to
know which path was selected — DagFlux routes it automatically.

The same surface is also documented to the AI in every prompt that
might generate code, so the model is prompted with the exact set of
helpers it's allowed to use. Generated code that drifts off the
supported surface fails fast with a clear error.

## Security boundary

The capabilities surface is a deliberately small, controlled set.
Generated code does not get raw access to the file system, the
operating system, or the network beyond what these helpers expose.
Credentials are still resolved inside the background engine, never
handed to the generated code as raw values.
