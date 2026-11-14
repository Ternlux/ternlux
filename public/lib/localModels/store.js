/**
 * Local model files: download from Hugging Face, list, delete.
 *
 * Models are single GGUF files under <userData>/models, described by
 * <userData>/models/models.json:
 *   [{ id, role: 'chat' | 'embedding', repo, file, size, sha256, label, addedAt }]
 *
 * `id` is what the OpenAI-compatible API calls the model (the request's
 * `model`), so it is also what a node or the default provider records.
 *
 * Downloads stream to `<file>.part` and resume from where they stopped (HTTP
 * Range), check free disk space first, and are verified against the SHA-256
 * Hugging Face publishes for the file (its LFS oid) before they are renamed
 * into place — so a model in the manifest is always complete.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HF = 'https://huggingface.co';

let rootDir = null;
const active = new Map(); // downloadId → { controller, info }

function init(userDataDir) {
  rootDir = path.join(userDataDir, 'models');
  fs.mkdirSync(rootDir, { recursive: true });
}

function dir() {
  if (!rootDir) throw new Error('local model store not initialised');
  return rootDir;
}

const manifestPath = () => path.join(dir(), 'models.json');

function readManifest() {
  try {
    const list = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeManifest(list) {
  const tmp = `${manifestPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, manifestPath());
}

/** Installed models whose file is still on disk. */
function list() {
  return readManifest().filter((m) => fs.existsSync(path.join(dir(), m.file)));
}

function get(id) {
  return list().find((m) => m.id === id) || null;
}

function pathOf(model) {
  return path.join(dir(), model.file);
}

function idFor(repo, file) {
  const base = path.basename(file).replace(/\.gguf$/i, '');
  const taken = readManifest().find((m) => m.id === base && m.repo !== repo);
  return taken ? `${repo.split('/')[0]}-${base}` : base;
}

async function freeBytes() {
  try {
    const s = await fs.promises.statfs(dir());
    return s.bavail * s.bsize;
  } catch (_) {
    return null; // unknown — do not block the download on it
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Download one GGUF file. `onProgress({ id, received, total, done, error })`
 * is called as bytes arrive (throttled). Resolves with the manifest entry.
 */
async function download({ repo, file, size, sha256, role, label }, onProgress = () => {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid Hugging Face repository');
  if (!/\.gguf$/i.test(file || '') || file.includes('..')) throw new Error('Only .gguf files can be downloaded');
  if (!['chat', 'embedding'].includes(role)) throw new Error('role must be chat or embedding');

  const id = idFor(repo, file);
  if (active.has(id)) throw new Error('This model is already downloading');
  const existing = get(id);
  if (existing) return existing;

  const dest = path.join(dir(), path.basename(file));
  const part = `${dest}.part`;
  let received = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const free = await freeBytes();
  const needed = Math.max(0, (size || 0) - received) + 512 * 1024 * 1024;
  if (free != null && size && free < needed) {
    throw new Error(`Not enough disk space: ${(needed / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free.`);
  }

  const controller = new AbortController();
  active.set(id, { controller, info: { id, repo, file, role, total: size || null } });
  let lastTick = 0;
  const report = (extra = {}) => onProgress({ id, repo, file, role, received, total: size || null, ...extra });

  try {
    const url = `${HF}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, {
      headers: received ? { Range: `bytes=${received}-` } : {},
      signal: controller.signal,
      redirect: 'follow',
    });
    if (res.status === 416) {
      // The part file is already complete.
    } else if (!(res.status === 200 || res.status === 206)) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    } else {
      if (res.status === 200 && received) received = 0; // server ignored Range: start over
      const out = fs.createWriteStream(part, { flags: received ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          received += chunk.length;
          const now = Date.now();
          if (now - lastTick > 250) { lastTick = now; report(); }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
    }

    if (size && fs.statSync(part).size !== size) {
      throw new Error('Download incomplete — try again to resume.');
    }
    report({ verifying: true });
    if (sha256) {
      const got = await sha256File(part);
      if (got !== sha256) {
        fs.rmSync(part, { force: true });
        throw new Error('Downloaded file failed its checksum and was removed. Try again.');
      }
    }
    fs.renameSync(part, dest);

    const entry = {
      id, role, repo, file: path.basename(file), size: fs.statSync(dest).size,
      sha256: sha256 || null, label: label || id, addedAt: new Date().toISOString(),
    };
    writeManifest([...readManifest().filter((m) => m.id !== id), entry]);
    report({ done: true });
    return entry;
  } catch (err) {
    const cancelled = controller.signal.aborted;
    report({ error: cancelled ? 'cancelled' : err.message });
    throw cancelled ? new Error('Download cancelled') : err;
  } finally {
    active.delete(id);
  }
}

/** Stop a download. The partial file is kept so a retry resumes. */
function cancel(id) {
  const job = active.get(id);
  if (job) job.controller.abort();
  return !!job;
}

function downloads() {
  return [...active.values()].map((j) => j.info);
}

/** Remove a model file (and any partial download of it). */
function remove(id) {
  const entry = readManifest().find((m) => m.id === id);
  if (!entry) return false;
  const file = path.join(dir(), entry.file);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.part`, { force: true });
  writeManifest(readManifest().filter((m) => m.id !== id));
  return true;
}

module.exports = { init, dir, list, get, pathOf, download, cancel, downloads, remove, freeBytes };
