# Architecture

DagFlux is a desktop application that runs entirely on your machine. The
visual canvas, the AI chat panels, and the workflow editor live in the
foreground. A background engine handles secret storage, plugin loading,
external connections, AI calls, scheduled triggers, and the actual
execution of workflows.

## Contents

- [Runtime topology](runtime-topology.md) — what runs where, and what's
  stored locally
- [Boot order](boot-order.md) — what happens when DagFlux starts up
- [Execution log](execution-log.md) — how each workflow run is recorded

## Key ideas

- **Everything is local.** Workflows, connections, execution history, and
  chat sessions live in files inside your user data directory. There is
  no cloud account.
- **Secrets are encrypted at the OS level.** Database passwords, API
  keys, and AI provider keys are stored using the operating system's
  secure storage (Keychain on macOS, Credential Store on Windows,
  Secret Service on Linux). They are decrypted only at the moment a
  connection or AI call is made.
- **The visual canvas never sees secrets.** Generated SQL, JavaScript,
  and REST API call code uses placeholder tokens for credentials. The
  background engine substitutes real values just before executing.
- **One local SQL workspace.** All "local" transformations and imports
  share a single SQLite database, so intermediate results are easy to
  reuse across workflows.
- **One execution log.** Every run — manual, scheduled, file-watch, or
  webhook — appends to the same execution history with per-node timing,
  record counts, and error details.
