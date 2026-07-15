# Chat assistant

The chat assistant is the app-wide conversation panel. Unlike the
per-node chat panels — which each configure one node (see
[Chat prompts](../chat-prompts/README.md)) — the assistant talks about
your whole workspace: your saved workflows, your connections, and your
execution history. It can also run live queries and outbound requests
to answer questions with real data, and it is the entry point for
building or changing a workflow by describing what you want.

## What it can do

- **Answer questions about your workspace** — list and inspect
  workflows, connections, and past executions, and read the product
  documentation to explain how Ternlux behaves.
- **Fetch live data** — run a read query against any saved connection,
  call an external HTTP endpoint, or generate and run a one-off
  JavaScript function for logic a single query can't express (per-row
  AI calls, embeddings, orchestrating several sources). These compute
  an answer to show you; they do not save anything.
- **Chart results** — when a result reads better as a picture, the
  answer can include charts (bar, line, pie, scatter, KPI, or a table)
  built directly from the rows it just fetched.
- **Build and modify workflows** — when you ask to create or change a
  workflow, the assistant hands the conversation to a focused
  workflow-builder that gathers the missing details and proposes a
  concrete plan for you to accept. See
  [Workflow builder](workflow-builder.md).

## Two agents, one conversation

Behind the single chat panel the assistant runs in one of two modes,
and switches between them automatically. You never pick a mode; the
conversation just flows.

- **Main mode** is the general-purpose helper. It knows how to look at
  workflows, connections, and executions, run queries, call endpoints,
  and read the docs. It knows nothing about the internals of building a
  workflow — its only build-related action is to recognise when you
  want to create or modify one and hand the conversation off.

- **Workflow mode** is a focused sub-agent that takes over after that
  hand-off. It owns the node and chat-prompt reference material, asks
  the clarifying questions needed to build what you described, and asks
  the planner to produce a plan. When the plan is accepted, the build
  is cancelled, or you change the subject, it hands control back to main
  mode.

The hand-off is one-directional and explicit each way: main mode triggers
the builder when you ask to create or modify a workflow, and the builder
returns control once the build is settled or you pivot to something else.
Until the builder hands back, your messages are answered by the builder,
not by the main assistant.

## How a turn works

The assistant works one turn at a time. On each turn it does exactly one
of two things:

1. **Gather** — it runs one or more tools (look up a workflow, list
   connections, run a query, call an endpoint, read a doc) and waits for
   the results, which are fed back to it on the next turn.
2. **Answer** — it replies to you, optionally with charts.

Independent look-ups are batched into a single turn; anything that
depends on a previous result waits for the next turn. A short live status
line ("thought") is shown while the assistant is working so you can see
what it is doing.

Each turn carries the current mode and, during a build, the active
workflow session. This is how the panel can immediately continue on its
own right after a hand-off — for example, starting to ask build questions
the moment you ask to create a workflow, without needing another message
from you.

## Reading large results safely

The assistant is careful not to flood the conversation with data it
can't actually read:

- Query results are capped per call, and very large or wide results are
  trimmed in the assistant's working memory — so before running a broad
  query it first counts rows, then narrows the filter or adds a limit.
- Large workflows are summarised to an outline (each node as an id, type,
  and one-line description) and the assistant drills into only the
  specific nodes relevant to your question.

## Safety and scope

- **Read-and-compute, not silent changes.** In main mode the assistant
  reads your workspace and runs queries, HTTP calls, and one-off scripts
  to answer you — none of which save anything. The only thing that
  changes a workflow is a build plan you explicitly accept.
- **Secrets stay server-side.** The assistant refers to connections by
  name and never sees or emits credentials, tokens, or API keys; those
  are held by the connection and substituted only at execution time.
  The assistant only sends authentication on an outbound request when
  you have explicitly provided it.
- **Honest about actions.** The assistant only claims to have done
  something when a tool actually did it; if a tool errors, it reads the
  error and adjusts rather than pretending.

## Related

- [Workflow builder](workflow-builder.md) — how a described workflow
  becomes a plan and then real nodes
- [Chat prompts](../chat-prompts/README.md) — the per-node chat panels
  the builder mirrors when it configures each node
- [Nodes](../nodes/README.md) — what each node type does
- [AI providers](../ai-providers/README.md) — which models power the
  assistant
