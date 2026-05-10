# How plugins are loaded and managed

When DagFlux starts, it scans its plugin folder, validates each plugin,
and registers the ones that pass.

## Discovery

Plugins live in a dedicated folder split into two sub-folders:

- One for connectors.
- One for skills.

Each plugin sits in its own sub-directory, identified by a stable id
(such as `postgres`, `mongodb`, `pinecone`, `python-executor`). The id
never changes after install, so saved workflows always know which plugin
to use.

## Validation

A plugin is registered only if it declares its type correctly and
implements the required behaviours for that type:

- A **database connector** must be able to test the connection, list
  tables, list columns, and run queries.
- A **cloud-storage connector** must be able to test the connection,
  list containers / buckets, list objects, download objects, upload
  objects, and delete objects.
- A **skill** must declare which category it belongs to (transformer,
  join, or both) and provide a description plus an execute action.

Any plugin that doesn't meet its required behaviours is skipped — the
problem is logged but the rest of DagFlux keeps running.

## Optional behaviours that unlock features

A plugin can opt into extra capabilities that DagFlux uses when present:

- **Streaming reads** — large datasets are pulled in batches instead of
  all at once.
- **Batch inserts** — destination writes happen in chunks for speed.
- **Quoting** — DagFlux uses dialect-aware identifier quoting (for
  example, BigQuery backticks vs PostgreSQL schema-qualified names).
- **Preview queries** — the data preview pane uses the connector's
  preferred preview syntax.
- **OAuth flows** — the connection form gets an "Authorize" button.
- **Transform prompts** — the AI assistant uses the connector's own
  prompts when generating transformations for that database.
- **Vector bulk fetch** and **vector operations** — vector connectors
  expose extra hooks the join and output paths use.

## Install and uninstall

You can install a plugin from the catalog at any time. DagFlux downloads
the plugin package, replaces the existing folder if any, and reloads the
plugin list — so the new connector or skill is available immediately.

Uninstall removes the plugin's folder and unregisters it. Workflows that
reference an uninstalled plugin will fail to execute until the plugin is
reinstalled.
