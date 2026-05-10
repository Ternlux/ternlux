# Chat prompts

Each chat-enabled node has its own AI conversation panel. You describe
what you want; the assistant turns that into a concrete operation that
DagFlux can run.

The conversation always follows the same two-phase rhythm:

1. **Analyse** — the assistant reads your latest message in the context
   of the chat history. It decides whether it can answer your question
   directly, ask one clarifying question, or proceed to generate the
   operation.
2. **Generate** — once the assistant is sure it has every required
   piece of information, it produces the actual operation: SQL, a
   document operation, a JavaScript function, a REST fetch function, a
   vector operation, or a skill invocation.

The interactive layer handles the user-facing parts (showing the
answer, posting the next question, rendering the proposed operation)
and saves the generated operation into the node so it can run every
time the workflow executes — without re-asking the AI — until you
change the description.

## Contents

- [Join](join.md) — how the assistant generates joins, including the
  vector-aware paths
- [REST API](rest-api.md) — how the assistant generates REST fetch
  functions for each auth scheme
- [Transformer](transformer.md) — how the assistant generates
  transformations across SQL, document, and local sources

## Skills in prompts

Both Join and Transformer prompts include the list of available skills
when the assistant analyses your request. If a skill is a better fit
for what you described, the assistant returns a skill choice instead
of vanilla SQL or NoSQL, and the skill takes over the rest of the
conversation.
