/**
 * DuckDB extensions — shipped with the app rather than fetched on demand.
 *
 * Excel and Avro are read by DuckDB's own `excel` and `avro` extensions. Both
 * are CORE extensions, so `INSTALL excel` works — but it downloads the binary
 * from extensions.duckdb.org the first time, and a desktop app cannot make a
 * user's first spreadsheet depend on a network round trip. So the binaries are
 * fetched at BUILD time (scripts/fetch-duckdb-extensions.js) and shipped in the
 * app bundle; at runtime they are installed from that local path.
 *
 * An extension binary is specific to BOTH the DuckDB version and the platform —
 * `v1.5.5/osx_arm64/excel.duckdb_extension` — and DuckDB refuses to load a
 * mismatched one. Neither is guessed here: the running engine is asked
 * (`PRAGMA platform`, `SELECT version()`) and the answer picks the file, so a
 * DuckDB upgrade that lands without a matching re-fetch fails loudly at install
 * rather than quietly loading something wrong.
 *
 * If the bundled file is missing — a build made before the fetch script ran, or
 * a platform nobody packaged for — the network install is still tried, so the
 * feature degrades to "needs a connection once" rather than breaking.
 */

const fs = require('fs');
const path = require('path');

/** node platform+arch → the platform string DuckDB names its builds with. */
const DUCKDB_PLATFORMS = {
  'darwin:arm64': 'osx_arm64',
  'darwin:x64': 'osx_amd64',
  'linux:x64': 'linux_amd64',
  'linux:arm64': 'linux_arm64',
  // DuckDB publishes no windows_arm64 build; Windows on ARM runs the x64 one
  // through emulation, which is what an Electron x64 build does anyway.
  'win32:x64': 'windows_amd64',
  'win32:arm64': 'windows_amd64',
};

/** Every platform the fetch script knows how to download for. */
const ALL_PLATFORMS = [...new Set(Object.values(DUCKDB_PLATFORMS))];

/** The extension each file format needs before DuckDB can read it. */
const EXTENSION_FOR_FORMAT = {
  xlsx: 'excel',
  avro: 'avro',
};

/** Where the fetch script writes, and where the runtime looks. */
const BUNDLE_DIRNAME = 'duckdb-extensions';

/** The core repository a version+platform's extension is downloaded from. */
const extensionUrl = (version, platform, name) =>
  `http://extensions.duckdb.org/${version}/${platform}/${name}.duckdb_extension.gz`;

const platformFor = (nodePlatform = process.platform, nodeArch = process.arch) =>
  DUCKDB_PLATFORMS[`${nodePlatform}:${nodeArch}`] || null;

/**
 * The directory holding the bundled binaries.
 *
 * Packaged, they sit in the app's resources folder — OUTSIDE the asar archive,
 * because DuckDB installs from a real path and cannot read one from inside it.
 * In development they come from the repo's own `resources/`.
 */
function bundleDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, BUNDLE_DIRNAME));
  // public/duckdb/ → repo root
  candidates.push(path.join(__dirname, '..', '..', 'resources', BUNDLE_DIRNAME));
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[candidates.length - 1];
}

/** The bundled binary for one extension on one platform, if it is there. */
function bundledPath(platform, name) {
  const file = path.join(bundleDir(), platform, `${name}.duckdb_extension`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Where DuckDB keeps the extensions it has installed.
 *
 * Under userData rather than DuckDB's default `~/.duckdb`, so an install is
 * scoped to this app and a locked-down home directory cannot break it. Resolved
 * lazily — a main process that never opens a spreadsheet never loads electron
 * here, and the module stays usable from a plain node script.
 */
function extensionDirectory() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return path.join(app.getPath('userData'), BUNDLE_DIRNAME);
  } catch (_err) {
    return null; // not in Electron — DuckDB's own default applies
  }
}

// DuckDB takes forward slashes on every platform, and a Windows path's
// backslashes would otherwise have to survive a SQL string literal intact.
const pathLiteral = (value) => `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;

// name → promise of the completed LOAD. Cached so concurrent readers share one
// install rather than racing to issue it twice.
const loaded = new Map();
let directorySet = false;

/** Forget what has been loaded — for when the connection behind it is gone. */
function resetExtensions() {
  loaded.clear();
  directorySet = false;
}

/**
 * Make sure `name` is installed and loaded on the shared connection.
 *
 * @param {string} name - a core extension: 'excel' or 'avro'
 * @param {{ exec: function, query: function }} runners - passed in rather than
 *   imported, so this module and public/duckdb/index.js don't require each
 *   other in a cycle.
 */
function ensureExtension(name, { exec, query }) {
  if (!loaded.has(name)) {
    const pending = (async () => {
      if (!directorySet) {
        const dir = extensionDirectory();
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          await exec(`SET extension_directory = ${pathLiteral(dir)}`);
        }
        directorySet = true;
      }

      const { rows } = await query('PRAGMA platform');
      const platform = rows[0] && rows[0].platform;
      const bundled = platform ? bundledPath(platform, name) : null;

      if (bundled) {
        try {
          await exec(`INSTALL ${pathLiteral(bundled)}`);
        } catch (err) {
          // DuckDB refuses to install over an extension of the same name that
          // came from somewhere else — a network install by an older build of
          // this app, or by anything else sharing the extension directory. Ours
          // is the one that matches the engine we ship, so it wins. FORCE is
          // the retry rather than the default because it re-copies the binary
          // every time, and the ordinary case is that nothing is in the way.
          await exec(`FORCE INSTALL ${pathLiteral(bundled)}`);
        }
      } else {
        // Nothing shipped for this platform. The network install is the
        // fallback, and its failure carries the whole story.
        try {
          await exec(`INSTALL ${name}`);
        } catch (err) {
          throw new Error(
            `DuckDB's "${name}" extension is needed to read this file and is not bundled for `
            + `${platform || 'this platform'}. Installing it from extensions.duckdb.org failed: ${err.message}`,
          );
        }
      }

      await exec(`LOAD ${name}`);
      return name;
    })().catch((err) => {
      loaded.delete(name); // a later call gets to try again
      throw err;
    });
    loaded.set(name, pending);
  }
  return loaded.get(name);
}

module.exports = {
  ALL_PLATFORMS,
  BUNDLE_DIRNAME,
  DUCKDB_PLATFORMS,
  EXTENSION_FOR_FORMAT,
  bundleDir,
  bundledPath,
  ensureExtension,
  extensionUrl,
  platformFor,
  resetExtensions,
};
