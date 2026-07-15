# Skills

Skills are AI-routable executors that the assistant can choose instead
of vanilla SQL or NoSQL when a request calls for it.

## Shipped skills

| Skill | Category | Purpose |
| --- | --- | --- |
| [Vector Database Executor](vector-db-executor.md) | Both | Generates embeddings, runs every vector store operation (upsert, query, delete, update), and powers vector-aware joins and outputs |
| [Python Executor](python-executor.md) | Transformer | Runs AI-authored Python (pandas, numpy, etc.) for transformations that don't map cleanly to SQL |
| [JavaScript Executor](javascript-executor.md) | Both | Runs AI-authored JavaScript inside the background engine for cross-system or branching operations |

## When the AI picks a skill

When you describe a transformation or a join in plain language, the AI
assistant sees the list of available skills along with what each one can
do. If a skill is a better fit than vanilla SQL or NoSQL — for example,
"compute a per-row similarity score against this article index", or
"compute a moving average with pandas" — the assistant tells you it's
going to use the skill, asks any clarifying questions the skill needs,
and then generates the skill's parameters.

## Behaviour rules

- **Vector source auto-routing.** When you point a Transformer node at
  a vector source, the AI does not give you a choice — the operation is
  always routed through the vector skill, because vectors aren't a
  thing vanilla SQL or NoSQL can talk to.
- **Empty-skill fallback.** If a skill returns an empty plan, the
  assistant falls back to vanilla SQL or NoSQL generation so the node
  is never left with no operation.
- **Skill filtering for joins.** Some skills aren't valid for joins
  (the Vector Database Executor's join behaviour is invoked
  automatically by the join engine, not as a stand-alone skill choice).
  Joins only show skills that can produce a multi-source result.
- **Connection auto-selection.** When a skill needs a saved connection
  (e.g. "which Pinecone connection to write to"), the skill auto-picks
  if exactly one matching connection exists; otherwise it asks you to
  choose by name.

## What skills can use

Every skill execution receives the same predictable surface from
Ternlux. See [Skill capabilities at run time](../../ai-providers/helpers-bundle.md)
for the full description.

## Installation

The first install of a skill requires you to restart Ternlux so the
interactive layer can pick up the new capability. After that, the skill
appears in the connection-type selector under the "Skills" tab and is
automatically considered by the AI when generating transformations or
joins it's eligible for.
