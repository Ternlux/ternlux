# Startup behaviour

When DagFlux launches, it goes through a fixed sequence before showing
you the main window. Understanding this helps explain why the first
moment after launch may feel slightly slower than navigating the app
afterward.

## What happens at launch

1. **Local workspace is opened.** DagFlux opens its single shared SQLite
   workspace and prepares it for the workflows that will read from or
   write to it.
2. **Execution engine is wired up.** The components that run
   transformations, joins, and REST API fetches are connected to the
   credential store, the local workspace, and the AI helpers.
3. **Plugins are discovered.** Every installed connector and every
   installed AI skill is loaded from the plugin folder. Each is checked
   to make sure it implements the required behaviours; broken plugins
   are skipped and logged.
4. **Saved triggers are reactivated.** DagFlux walks through every saved
   workflow and re-registers any scheduled trigger or file watcher that
   the workflow relies on. From this moment on, scheduled workflows can
   fire even if you never open the workflow.
5. **Main window appears.** The visual canvas is loaded and you can
   start working.

## What happens at shutdown

When you quit DagFlux, the background engine performs a graceful
teardown:

1. All scheduled triggers stop firing.
2. All file watchers stop watching.
3. The shared local workspace is closed.

Triggers stop before the local workspace is torn down, so an in-flight
workflow can never land on a closed database.
