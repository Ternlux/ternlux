# JavaScript Executor skill

A skill (transformer + join) that runs AI-authored JavaScript inside
the background engine. Used when a transformation or join needs custom
logic that doesn't map cleanly to vanilla SQL or NoSQL.

## When the AI picks this skill

The assistant offers this skill when:

- The transformation or join needs branching, conditional rewrites,
  or multi-step orchestration.
- The operation needs to call out to your saved connections, the AI,
  or external HTTP endpoints during execution.
- The logic would require generating multiple SQL statements or
  multiple document operations that are easier to express as a single
  function.

## What the script can use

The script runs in the background engine with a small, predictable
set of helpers — the same surface every AI-generated function in
DagFlux sees. From inside the script you can:

- Look up your saved connections by name or id.
- Read from any saved connection or any local file with a single
  unified call (SQL, document, or vector — the call shape is the
  same).
- List tables, collections, indexes, and their columns.
- Call the AI for a sub-task with one line.
- Embed text into vectors using your configured embedding provider.
- Make arbitrary HTTP requests.
- Log to the run output for debugging.

See the [Skill capabilities at run time](../../ai-providers/helpers-bundle.md)
page for the full description of this surface.

## Why use it instead of writing SQL

Three things make this skill the right pick over generated SQL:

- **Cross-system operations.** A single script can pull from a
  PostgreSQL table, look something up in MongoDB, embed it via
  OpenAI, and write the result to LanceDB — all in one pass, with no
  intermediate workflows.
- **Conditional logic.** Branching that would need a CASE-and-CTE
  forest in SQL is just an `if` in JavaScript.
- **External calls.** When the transformation needs to hit a third
  party API per row, JavaScript with the shared HTTP client is the
  natural shape.

## What it cannot do

The script is sandboxed to the helpers above. It does not get raw
file-system, operating-system, or network access beyond what the
helpers expose. Credentials are still resolved by the background
engine — the script never sees a decrypted password or token directly.
