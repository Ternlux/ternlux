# Externalized node code (`workflow-code/`)

Workflow nodes carry their generated source — SQL, JavaScript, Python — as
plain strings inside the node config. Keeping that code inline in the
workflows database has two problems: it bloats every stored document, and the
code is impossible to read or edit with a real editor. Ternlux solves both by
**externalizing** code fields to files on disk and leaving only a pointer
behind in the database.

The logic lives in [`public/lib/workflowCode.js`](../../lib/workflowCode.js)
and is wired into the workflows datastore in
[`public/electron.js`](../../electron.js) (`wrapKeySafeDb`).

## How it works

On **write** (insert/update), every known code field is pulled out of the
node config, written to a file, and replaced by a sentinel object:

```json
{ "__codeFile": "My_Workflow/Clean_Customers/transformFunction.js" }
```

On **read** (find/findOne), the sentinel is reversed: the file is read back and
the real string is re-inlined, so the editor and the execution engine see
workflows exactly as if the code had never left the document.

### On-disk layout

Files live under your user data directory:

```
{userData}/workflow-code/{workflow}/{node}/{field}.{ext}
```

- `{workflow}` — the workflow's name (sanitized), falling back to its id.
- `{node}` — the node's label when it is distinctive and unique, otherwise the
  node id.
- Join nodes also externalize each `sourcesConfig[]` step under
  `{node}/sourcesConfig/{source}/{field}.{ext}`.

### Externalized fields

| Field | Ext | Produced by |
|-------|-----|-------------|
| `sourceSql`, `sourcePreviewSql` | `.sql` | Data Source node |
| `apiFetchCode` | `.js` | Data Source (REST API) |
| `targetSql`, `targetDdl`, `targetInsertSql`, `targetPreviewSql`, `joinSql` | `.sql` | Transformer / Join node |
| `nosqlOperation` | `.js` | NoSQL transforms |
| `transformFunction`, `javascriptFunction` | `.js` | JavaScript executor skill |
| `pythonCode` | `.py` | Python executor skill |

Per-source join steps externalize `ddl`, `sql`, `insertSql` (`.sql`) and
`nosqlOperation` (`.js`).

There is **no migration / backwards-compatibility path**: only the sentinel
form is inlined on read, so the database and the `workflow-code/` tree must
stay in sync.

## Deletion

When a workflow is removed, its entire `workflow-code/{workflow}` folder is
deleted (`deleteWorkflowCode`), using the same name-or-id directory rule the
externalizer used.

## Editing code on disk (live sync)

Because the files are the source of truth on read, you can edit a `.sql` /
`.js` / `.py` file under `workflow-code/{workflow}/` directly in an external
editor or with an AI tool. The Workflow Editor watches the open workflow's
code folder and **refreshes the canvas** when any file there changes, so the
on-disk code and the editor stay in sync. This watcher is editor-only and does
**not** run the workflow — that is the job of the file-watch *trigger*
([`public/triggers/fileWatchTriggers.js`](../../triggers/fileWatchTriggers.js)),
which is a separate mechanism.
