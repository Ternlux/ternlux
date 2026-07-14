# Workflow builder

When you ask the [chat assistant](README.md) to create or change a
workflow, a focused workflow-builder takes over the conversation. Its job
is to turn what you describe in plain language into a real workflow — a
graph of nodes and edges — without you ever drawing the graph yourself.

The builder never changes anything on its own. It produces a **plan** you
review, and only your acceptance turns that plan into nodes.

## New workflow vs. modify

The first thing the builder decides is the target:

- **A brand-new workflow** when your request describes a self-contained
  pipeline that doesn't refer back to anything that already exists.
- **A change to an existing workflow** when your request adds to, removes
  from, fixes, or otherwise refers to a specific workflow.

Having a workflow open in the editor when you start does **not** by
itself mean you want to change it — the builder treats "open" as a hint,
not an instruction, and confirms which workflow you mean if it's
ambiguous. It also honours a mid-conversation change of mind: if you
start by modifying and then say "make it a new workflow," the latest
intent wins.

## Gathering the details

Before it can plan, the builder needs to know enough to configure each
node concretely. It asks one short, specific question at a time, naming
the connections, tables, and columns it already knows so you can answer
quickly. Each question and your answer become part of the conversation
history, and the builder never re-asks something you've already answered.

The details it gathers map to the per-node chat panels documented under
[Chat prompts](../chat-prompts/README.md) — because each node is
ultimately configured by the same templates those panels use. Broadly:

- **Start** — how the workflow is triggered (manually, on a schedule, or
  when a file changes).
- **Data source** — which saved connection, and which table, collection,
  or index it reads.
- **Transformer** — the reshaping logic in concrete terms, whether it
  creates a new table or updates in place, and where the result lives.
- **Join** — for every pair of sources, the join keys and join type, the
  columns to keep, and the destination.
- **Output** — where the final result is written: a file (and its
  format and path) or a different connection and table.

### What chat can't configure

Some sources need the editor's native pickers and can't be set up from
chat. **Cloud-storage** sources and destinations (such as S3, GCS,
Dropbox, or Google Drive) and **Google Sheets** fall into this group. If
your pipeline needs one, the builder tells you to add and configure that
node in the editor first; chat can then build the transformers and joins
that read from the data it materialises locally.

## Proposing a plan

Once it has enough, the builder submits the request to the **planner**.
The planner writes a fresh, self-contained description of the workflow
you want *now* — synthesised from the whole conversation, not just your
first message — and produces one of three results:

- **A clarifying question**, when something is still missing. It's
  surfaced to you directly; your next message is the answer, and the
  builder submits again.
- **A finished plan** — a flat, ordered list of build steps, one per
  node, each carrying the exact instructions used to build that node.
- **An error**, when it couldn't produce a valid plan after retrying.
  The reason is shown as plain text so you can see what went wrong.

### The plan model

The planner thinks in the same five node types the editor uses, wired as
a directed graph that flows `start → data source → (transformer | join)*
→ (output?)`:

- **Start** is always step zero and decides only *when* the workflow
  runs; data sources attach to it automatically.
- **Data source** is the only node that brings external data in — one
  connection per node, so N inputs means N data-source nodes.
- **Transformer** takes exactly one upstream and reshapes it. It is a
  terminal write: its result is persisted as it runs, with no separate
  save step.
- **Join** takes two or more upstreams and merges them — including
  similarity ("find the top-K most similar") matching and self-joins —
  and also writes its result as it runs.
- **Output** is added only to deliver the result somewhere the upstream
  can't write itself (a file export, or a different connection or table).
  If the pipeline already ends at a transformer or join's own target, no
  output node is planned.

## Accept or cancel

A finished plan is shown as an **Accept / Cancel** card describing the
steps it would build. This is the decision point:

- **Accept** applies the plan — the builder runs every step in order,
  assembles the nodes and edges, and writes the workflow once (creating a
  new one, or updating the existing one for a modify). Triggers, like a
  schedule or file-watch, are registered as part of the build.
- **Cancel** discards the plan and changes nothing.

Proposing is not applying: a plan never modifies your workflow until you
accept it. After a plan is shown the builder simply waits — it can't
accept on your behalf. Once you accept, cancel, or change the subject,
the builder hands control back to the main assistant.

## How a built node matches a hand-built one

Each step is built by the same per-node logic the editor's chat panels
use, so a node the builder creates is configured the same way one you'd
build by hand would be — it samples live tables to confirm columns,
generates the same kind of operation (SQL, document operation,
JavaScript, REST fetch, or a skill), and records the same deterministic
local paths for any file or local target. Where a request is a better fit
for a skill (such as Python, JavaScript, or vector operations) than plain
SQL or NoSQL, the relevant skill is offered into the plan and takes over
that step.

## Related

- [Chat assistant](README.md) — the conversation panel and the two-agent
  hand-off that reaches the builder
- [Chat prompts](../chat-prompts/README.md) — the per-node chat panels
  the builder mirrors
- [Nodes](../nodes/README.md) — what each node type does at run time
- [Externalized node code](../architecture/workflow-code.md) — how the
  SQL/JS/Python a built node carries is stored on disk
