# Execution log

Every workflow run writes a record into the execution history. This is
what the Executions tab displays and what you use to confirm a run
succeeded, debug a failure, or audit when a workflow last produced
output.

## What's captured for each run

For every workflow run, DagFlux records:

- A unique execution id.
- Which workflow ran, by id and name.
- The current status: running, completed, or failed.
- Start time, end time, and total duration.
- How the run was triggered (manually, by schedule, by a file change,
  or by a webhook), including which trigger node fired it.
- A per-node breakdown — for every node that executed, the node name and
  type, when it started, how long it took, whether it succeeded, and
  how many records it processed.
- A timeline of log entries, each tagged with a level (info, error) and
  optionally with the node it belongs to.
- A summary of the run with the total records processed and a one-line
  description of the outcome.

## How a run progresses

When a run starts, DagFlux:

1. Creates the execution record with status "running".
2. Walks the workflow's execution order step by step.
3. For each node, logs which node is about to execute, dispatches it to
   the right backend handler, and records the node's result.
4. If a node fails, the run stops, the failure is logged, and the
   execution record is marked failed with the error message.
5. If every node succeeds, the run is marked completed, the summary is
   filled in, and the end time and total duration are written.

## Concurrency rules for triggered runs

When a workflow is fired by a schedule, a file change, or a webhook,
DagFlux ensures the same workflow does not start a second run while a
previous run is still in progress. New triggers that arrive during an
active run are skipped — they are recorded and the workflow simply
catches them on the next firing.

This protects you from overlapping runs that could double-write to the
same destination.

## Notifications

For triggered runs, DagFlux also sends desktop notifications when the
run starts, when it completes successfully, and when it fails. Manual
runs do not send notifications because you are already watching them.
