#!/usr/bin/env node
/**
 * Download the llama.cpp `llama-server` build Ternlux ships for local models.
 *
 * Local models run in llama.cpp's own OpenAI-compatible server, started by the
 * app only when a local model is used (public/lib/localModels/runtime.js). This
 * script fetches the official ggml-org/llama.cpp release build for each
 * platform at BUILD time, verifies its SHA-256, and keeps only what the server
 * needs: `llama-server` plus the shared libraries / backends it loads.
 * Every other tool in the release (llama-cli, llama-bench, …) is removed — on
 * Windows each .exe left in the app is a metered code-signing call.
 *
 *   node scripts/fetch-llama-server.js                  # this machine
 *   node scripts/fetch-llama-server.js --mac            # darwin-arm64 + darwin-x64
 *   node scripts/fetch-llama-server.js win32-x64 linux-x64
 *   node scripts/fetch-llama-server.js --all
 *   node scripts/fetch-llama-server.js --optional       # postinstall: never fail
 *
 * Output: resources/llama-server/<platform>-<arch>/ with a `server.json` naming
 * the server binary's relative path, and a `.llama-build` marker. A folder for
 * a different BUILD is replaced.
 *
 * GPU: Metal on Apple Silicon, Vulkan on Windows / Linux (NVIDIA, AMD and Intel
 * GPUs; falls back to CPU when no Vulkan driver is present). CUDA builds are
 * deliberately not shipped: hundreds of MB for a speed-up Vulkan mostly covers.
 *
 * To upgrade llama.cpp: change BUILD and the four digests below (the release's
 * GitHub API lists each asset's `digest`), then re-run. On Windows the new
 * llama-server.exe is signed once and reused from the signing cache after that.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BUILD = 'b12366';
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}`;

const ASSETS = {
  'darwin-arm64': { file: `llama-${BUILD}-bin-macos-arm64.tar.gz`, sha256: '6263965248c6c17b942eee1d91d9f810566d2ed1a7ec884130deb2339baee842' },
  'darwin-x64':   { file: `llama-${BUILD}-bin-macos-x64.tar.gz`,   sha256: '3f4ef9c548902b23661f1b3c4e9f2db8d81e4755932dd58422a83c8eaabe90b7' },
  'win32-x64':    { file: `llama-${BUILD}-bin-win-vulkan-x64.zip`, sha256: '1708e3125afc80bcad84b571a3d1563fc776cad39acb9f2f3937f9bfbba50028' },
  'linux-x64':    { file: `llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz`, sha256: 'f11eb7528080a85fc3e04fbc4b288facfcb3f5f9299c9840aede2c86b5d66304' },
};

const OUT_ROOT = path.join(__dirname, '..', 'resources', 'llama-server');
const MARKER = '.llama-build';

const LIB_RE = /\.(dylib|so(\.\d+)*|dll|metal|metallib)$/i;
const isServer = (name) => /^llama-server(\.exe)?$/i.test(name);

function hostKey() {
  return `${process.platform}-${process.arch}`;
}

function isSatisfied(key) {
  try {
    return fs.readFileSync(path.join(OUT_ROOT, key, MARKER), 'utf8').trim() === BUILD
      && fs.existsSync(path.join(OUT_ROOT, key, 'server.json'));
  } catch (_) {
    return false;
  }
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ternlux-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} → ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extract(archive, dir) {
  if (archive.endsWith('.zip')) {
    const AdmZip = require('adm-zip');
    new AdmZip(archive).extractAllTo(dir, true);
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Libraries that only the removed tools load (llama-cli, llama-bench, …):
// recent builds split each tool into a thin binary plus an `-impl` library.
const isOtherToolLib = (name) => /^(lib)?llama-.+-impl\./i.test(name) && !/^(lib)?llama-server-impl\./i.test(name);

/** Keep llama-server, its libraries and licences; drop every other tool. */
function prune(dir) {
  let removed = 0;
  for (const file of walk(dir)) {
    const name = path.basename(file);
    const keep = (isServer(name) || LIB_RE.test(name) || /^(LICENSE|licen[cs]e)/i.test(name)) && !isOtherToolLib(name);
    if (!keep) { fs.rmSync(file, { force: true }); removed += 1; }
  }
  return removed;
}

async function fetchOne(key) {
  const asset = ASSETS[key];
  if (!asset) throw new Error(`No llama-server build for ${key}. Known: ${Object.keys(ASSETS).join(', ')}`);
  if (isSatisfied(key)) {
    console.log(`[llama-server] ${key}: ${BUILD} already present`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-server-'));
  try {
    const archive = path.join(tmp, asset.file);
    console.log(`[llama-server] ${key}: downloading ${asset.file}`);
    await download(`${RELEASE_BASE}/${asset.file}`, archive);
    const digest = sha256Of(archive);
    if (digest !== asset.sha256) {
      throw new Error(`${asset.file}: SHA-256 mismatch (got ${digest}, expected ${asset.sha256})`);
    }

    const staging = path.join(tmp, 'x');
    fs.mkdirSync(staging);
    extract(archive, staging);
    const removed = prune(staging);

    const server = walk(staging).find((f) => isServer(path.basename(f)));
    if (!server) throw new Error(`${asset.file}: no llama-server binary inside`);
    if (!key.startsWith('win32')) fs.chmodSync(server, 0o755);

    const dest = path.join(OUT_ROOT, key);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(staging, dest, { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(path.join(dest, 'server.json'), JSON.stringify({
      build: BUILD,
      server: path.relative(staging, server).split(path.sep).join('/'),
    }, null, 2));
    fs.writeFileSync(path.join(dest, MARKER), BUILD);
    console.log(`[llama-server] ${key}: ready (${removed} unused tools removed)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const optional = args.includes('--optional');
  let keys = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--all')) keys = Object.keys(ASSETS);
  else if (args.includes('--mac')) keys = ['darwin-arm64', 'darwin-x64'];
  if (keys.length === 0) keys = [hostKey()];

  for (const key of keys) {
    try {
      await fetchOne(key);
    } catch (err) {
      if (optional) {
        console.warn(`[llama-server] ${key}: skipped (${err.message}). Local models will be unavailable in this dev build.`);
      } else {
        console.error(`[llama-server] ${key}: ${err.message}`);
        process.exit(1);
      }
    }
  }
}

if (require.main === module) main();

module.exports = { BUILD, ASSETS, OUT_ROOT, prune };
