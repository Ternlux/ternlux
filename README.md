# Ternlux

<p align="center">
  <a href="https://github.com/Ternlux/ternlux/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/Ternlux/ternlux?label=release"></a>
  <a href="https://github.com/Ternlux/ternlux/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/Ternlux/ternlux/total"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-informational">
</p>

<p align="center">
  <img src="assets/demo.gif" width="600" alt="Ternlux demo: a left join built from one chat message, run locally, then moved into Postgres">
</p>

**For analysts and small data teams** who work across files and databases and
want AI help that joins across sources, writes code you can read, and turns a
one-off question into a pipeline you can schedule.

Ternlux is a free, local-first desktop app for ETL and data analysis. Connect
databases, warehouses, cloud storage, APIs and local files, describe a pipeline
in plain English, review the plan the AI drafts, and run it as deterministic
code: pushed down to the target database, or locally on the built-in engine.
Joins work across sources, so a Postgres table, an Excel file and an S3 folder
can meet in one step. Bring your own model: OpenAI, Claude, Gemini, any
OpenAI-compatible endpoint, or a local model through Ollama or LM Studio.

- Connectors: Postgres, MySQL, SQL Server, BigQuery, Snowflake, MongoDB,
  Pinecone, LanceDB, S3, GCS, Azure Blob, Google Drive, OneDrive, Dropbox,
  SharePoint, Google Sheets, Slack, REST APIs and local files.
- Query CSV, Parquet, Excel, JSON, Avro and SQLite files in place with built-in
  DuckDB.
- Credentials are encrypted with your OS keychain, stay on your machine, and
  never reach the model.

**Download:** signed and notarized builds for macOS, Windows and Linux are on
the [Releases page](https://github.com/Ternlux/ternlux/releases/latest) and at
[ternlux.com](https://www.ternlux.com/). The app updates itself.

If Ternlux saves you time, a star helps other analysts and data engineers
find it.

## Tutorial

[![Ternlux tutorial on YouTube](https://img.youtube.com/vi/lyfZjq1DRUM/maxresdefault.jpg)](https://youtu.be/lyfZjq1DRUM)

## Build from source

Requirements: Node.js 22 or later, npm, and Git. Python 3 is needed for the
Python skill.

```bash
git clone https://github.com/Ternlux/ternlux.git
cd ternlux
npm install
for d in plugins/connectors/* plugins/skills/*; do (cd "$d" && npm install --omit=dev); done
npm run electron-dev
```

`npm run electron-dev` starts the React dev server on port 3000 and opens the
app. To try it without touching an existing Ternlux profile:

```bash
npx electron . --user-data-dir=/tmp/ternlux-test-profile
```

### Package an unsigned build

The `dist:*` and `release:*` scripts sign, notarize and publish with Ternlux's
own certificates, so they won't work on your machine. For an unsigned local
package:

```bash
npx react-scripts build && node scripts/minify-dist.js
SKIP_DMG_NOTARIZE=true npx electron-builder --mac -c.mac.identity=null -c.mac.notarize=false
SKIP_WIN_SIGN=true npx electron-builder --win
npx electron-builder --linux -c.npmRebuild=false
```

Run the `--mac`, `--win` or `--linux` line for your platform. Output goes to
`dist/`. Please give builds you distribute a different name and icon; see
[TRADEMARKS.md](TRADEMARKS.md).

## Project layout

| Path | What it is |
|---|---|
| `public/electron.js` | Electron main process: IPC, secrets, workflow execution, triggers |
| `public/pluginManager.js` | Loads connector and skill plugins |
| `public/chat`, `public/ChatPrompts` | AI assistant and prompt templates |
| `src/` | React renderer |
| `plugins/connectors`, `plugins/skills` | Plugins, each its own npm package |
| `public/docs` | Developer documentation |

The app talks to `api.ternlux.com` only for the optional account, the plugin
catalog, and opt-in anonymous telemetry (`public/analytics.js`). Set
`BACKEND_URL` to point it elsewhere.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE). The Ternlux name and logo
are trademarks of Ternlux Inc.; see [TRADEMARKS.md](TRADEMARKS.md).
