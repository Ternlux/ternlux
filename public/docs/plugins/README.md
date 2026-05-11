# Plugins

DagFlux is built around plugins. Every database integration, every cloud
storage integration, and every AI-routable capability is a plugin. New
ones can be added without modifying the rest of the application.

There are two kinds of plugins:

- **Connectors** — bridges to one external system: a database, a vector
  store, a cloud bucket, a spreadsheet service, a REST API, or a local
  file format.
- **Skills** — AI-routable executors that the assistant can choose
  instead of vanilla SQL or NoSQL when the job calls for it.

## Contents

- [Plugin manager](plugin-manager.md) — discovery, validation, install /
  uninstall
- [Connectors](connectors/README.md) — what every connector can do, plus
  representative examples (relational, document, vector)
- [Skills](skills/README.md) — what skills are and how the AI uses them

## Where plugins come from

DagFlux ships with a curated set of plugins. You can install additional
plugins from the catalog at any time, and uninstall ones you don't use.
Every plugin is self-contained — it has its own folder, its own
dependencies, and an icon and configuration form that DagFlux renders
automatically.

## Roles you'll see in the product

- A connector marked as a **vector store** unlocks the vector-aware
  paths in joins (similarity search), in outputs (embedding and upsert),
  and in the AI assistant.
- A connector marked as **cloud storage** activates the file picker UX
  and bucket / object listing screens.
- A skill marked for **transformer**, **join**, or **both** appears as
  an option whenever the AI is generating a transformation or join, so
  it can be chosen if it's a better fit than vanilla SQL or NoSQL.
