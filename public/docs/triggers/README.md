# Triggers

Triggers are what cause a workflow to run when you're not pressing the
"Run" button yourself. They live on Start nodes and are registered with
DagFlux at startup.

## Trigger types

- **Manual** — no trigger is registered. You run the workflow yourself
  from the canvas.
- **Schedule** — DagFlux registers a recurring trigger that fires on a
  schedule you choose:
  - At fixed minute intervals (15 minutes up to 24 hours).
  - Daily at a specific time.
  - Weekly on chosen days at a specific time.
  - Monthly on a chosen day at a specific time.
- **File watch** — DagFlux registers a watcher on a file or directory.
  The workflow runs whenever the watched location changes.
- **Webhook** — DagFlux generates an HTTP endpoint scoped to the
  workflow. The workflow runs whenever a request is made to that
  endpoint with the matching API token in the `Authorization` header.

## Lifecycle

When DagFlux starts, it walks every saved workflow and registers any
triggers its Start node declares. From that point on, scheduled and
file-watch triggers can fire even if you never open the workflow.

When you change a workflow's trigger configuration, the previous
registration is removed and the new one takes its place.

When you quit DagFlux, all triggers are cleanly stopped before the
local workspace is closed, so a trigger can never fire into a
half-shut-down engine.

## Concurrency

Two safeguards keep triggered runs sane:

- **No overlapping runs.** If the same workflow is already running when
  a trigger fires, the new fire is skipped. You can see skipped fires
  in the execution history.
- **Run isolation.** Each trigger fire creates its own execution
  record, with its own id, its own log timeline, and its own per-node
  metrics — so debugging which run did what is unambiguous.

## Notifications

Triggered runs send desktop notifications:

- When the run starts.
- When it completes successfully.
- When it fails (with the error message inline).

Manual runs don't send notifications, since you're already watching the
canvas.
