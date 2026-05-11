# Start node

Every workflow begins with one Start node. Its only job is to decide
when the workflow runs. The chat panel walks you through every choice
in plain language and lets the AI fill in the technical bits (CRON
expressions, file event flags, schedule descriptions) for you.

## Trigger types

You pick one of three trigger types:

- **Manual** — the workflow only runs when you click "Run" yourself.
  This is the default and is the right choice while you're building or
  iterating on a workflow.
- **Time-based (schedule)** — the workflow runs automatically on a
  recurring schedule.
- **File / folder watch** — the workflow runs whenever a watched file
  or directory changes.
- **Webhook** — the workflow runs whenever an HTTP request is made to
  a generated webhook endpoint.

## Schedule sub-types

Scheduled workflows can fire on:

- **Interval** — every N minutes, picked from a fixed list of fifteen
  minute increments running up to twenty-four hours.
- **Daily** — at one specific time each day.
- **Weekly** — at one specific time on one or more chosen days of the
  week.
- **Monthly** — at one specific time on one chosen day of the month.

The chat builds a CRON expression and a human-readable description
("Every Monday at 9:30 am") side by side, so you can confirm the
schedule reads the way you intended before saving.

Inputs are validated inline:

- Day-of-month between 1 and 31.
- Time in 24-hour `HH:MM` form.
- Minute between 0 and 59.

## File / folder watch

You pick a path with the native file picker (single file or a whole
directory). Then you pick which file-system events should fire the
workflow:

- File events: add, change, delete.
- Directory events: add, change, delete (including new files inside).

Multi-select is allowed — for example, a watcher can fire on both
"add" and "change". The available event list narrows based on whether
the path you picked is a file or a directory.

## Webhook trigger

When you pick the webhook trigger type, you set an API token that the
caller must present in the `Authorization` header. DagFlux generates
the endpoint URL for you, scoped to the workflow's id, and shows it
in the configuration screen so you can copy it into the calling
system.

## What the Start node does at run time

At execution time, the Start node itself is a no-op — it doesn't read
or write data. Its real role is to be registered with DagFlux's
trigger system at startup, so that scheduled or file-watch triggers
can fire the workflow even when you have it closed. When you change
the trigger configuration, DagFlux automatically unregisters the old
trigger before registering the new one, so you never end up with
orphaned background jobs from a previous setup.

## Concurrency

The trigger system never starts a second run of the same workflow
while a previous run is still in progress. New trigger fires that
arrive during an active run are skipped, and you'll see them noted in
the execution history.

## Persistence across reopens

The chat detects when a Start node already has a saved trigger
configuration and restores all your selections — trigger type,
schedule sub-type, day / time, watched path, watch events — without
clearing the conversation, so reopening the node is non-destructive.
