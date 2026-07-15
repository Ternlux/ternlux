# Nodes

A workflow is a directed graph of typed nodes. Each node has one job
and one configuration screen, and at execution time each node is
dispatched to a typed handler that knows how to run it.

## Node types

| Node | What it does |
| --- | --- |
| [Start](start.md) | Decides when the workflow runs |
| [Data Source](data-source.md) | Pulls data from one input |
| [Transformer](transformer.md) | Reshapes data from a single upstream source |
| [Join](join.md) | Merges data from two or more upstream sources |
| [Output](output.md) | Writes the final result somewhere |
| [Branch](branch.md) | Routes execution down one of two paths based on a condition |

## How nodes flow into each other

You connect nodes by drawing edges from one output handle to another's
input handle. Most nodes have a single input handle and a single output
handle. Joins have multiple input handles. Branches have one input and
two output handles (one per route).

## Configuration vs description

Most nodes have two parts:

- **Configuration form** — strict, structured choices (which connection,
  which table, which output format, which trigger schedule).
- **Chat panel** — a free-form conversation with the AI assistant where
  you describe what you want done. The assistant asks clarifying
  questions if needed, then proposes a concrete operation to be saved
  into the node. You can revise the description and regenerate at any
  time.

Once a node is configured, the saved operation runs every time the
workflow runs — without re-asking the AI — until you change the
description or the node's configuration.

## Execution order

When a workflow runs, Ternlux follows the saved execution order, calling
each node's handler in turn. Each node logs its result, the records
processed, the duration, and any error to the execution history. If any
node fails, the run stops and the failure is recorded.
