# Ternlux Documentation

Ternlux is a desktop application for designing, automating, and running
data workflows. You assemble a workflow as a graph of typed nodes — a
trigger, one or more data sources, transformations, joins, and outputs —
and let the built-in AI assistant translate plain-language descriptions
into the exact operations needed to move and reshape your data.

This documentation is the conceptual map of the product. It explains how
each part of Ternlux behaves, what it can do, and how the pieces fit
together. It does not document source code.

## How Ternlux works in one minute

You start with a blank canvas and drop nodes onto it. Each node has a job:

- A **Start** node decides when the workflow runs (manually, on a
  schedule, when a file changes, or when an HTTP webhook is called).
- A **Data Source** node points at one input — a database table, a cloud
  bucket file, a local spreadsheet, a REST API, etc.
- A **Transformer** node modifies data from a single upstream source.
- A **Join** node merges data from two or more upstream sources.
- An **Output** node writes results to a file, a database, a cloud
  bucket, or a vector store.
- A **Branch** node checks a condition and routes execution down one of
  two paths.

When you describe what you want a node to do in plain language, Ternlux
asks clarifying questions if needed, then generates the precise operation
that will run at execution time. You see and approve that operation
before the workflow is saved.

When the workflow runs, Ternlux executes nodes in order, logs every step,
and records the result so you can inspect what happened.

Throughout, your credentials and AI provider keys stay encrypted on your
machine and are never visible inside generated workflows or sent
anywhere except to the service the connection actually targets.

## Documentation map

| Section | What it covers |
| --- | --- |
| [Architecture](architecture/README.md) | How Ternlux is structured, what runs locally, how runs are recorded |
| [Plugins](plugins/README.md) | How Ternlux is extended with connectors and AI skills |
| [Connections](connections/README.md) | Saved data sources, credential storage, OAuth |
| [AI providers](ai-providers/README.md) | Which AI providers Ternlux supports and how it uses them |
| [Nodes](nodes/README.md) | What each node type does and how it behaves at run time |
| [Chat assistant](chat-assistant/README.md) | The app-wide AI assistant that answers questions, runs queries, and builds workflows |
| [Chat prompts](chat-prompts/README.md) | How the AI assistant turns descriptions into operations |
| [Triggers](triggers/README.md) | Scheduled, file-based, and webhook automation |

## What Ternlux can do

In one workflow you can:

- Pull data from any supported database (relational, document, or vector),
  cloud storage bucket, local file, spreadsheet service, or REST API.
- Reshape it with AI-generated SQL, NoSQL operations, or custom code,
  either creating a new dataset or modifying the source in place.
- Combine data from multiple sources with joins — including hybrid joins
  that mix relational, document, and vector sources, and joins that
  perform similarity search per row.
- Write the result to a local file (in many formats), back into a
  database, into a cloud bucket, or into a vector index (with embeddings
  generated automatically).
- Run the whole workflow on demand, on a schedule, when a file changes,
  or in response to an HTTP webhook.

Ternlux ships with a curated set of integrations and can install more
on demand from the plugin catalog.
