/**
 * What local models to offer: Ternlux's recommended list plus what is popular
 * on Hugging Face, each resolved to one concrete GGUF file with its size,
 * checksum and a fit estimate for this machine.
 *
 * Only the recommended repositories are written down (RECOMMENDED below). Which
 * file to download, how big it is and its checksum always come live from the
 * Hugging Face API, so a repository that adds or renames quantizations needs no
 * change here.
 */

const os = require('os');

const HF = 'https://huggingface.co';
const TIMEOUT_MS = 15000;

// Hand-picked, ungated, permissively licensed models that run well on a
// laptop. Repos only — the file is chosen by pickFile.
const RECOMMENDED = {
  chat: [
    { repo: 'ibm-granite/granite-4.2-3b-GGUF', label: 'Granite 4.2 3B', note: 'Small and fast. Good at following instructions and JSON.' },
    { repo: 'Qwen/Qwen3-4B-GGUF', label: 'Qwen3 4B', note: 'Strong all-rounder for its size.' },
    { repo: 'Qwen/Qwen3-8B-GGUF', label: 'Qwen3 8B', note: 'Better answers; needs 16 GB of memory.' },
    { repo: 'unsloth/Qwen3.5-9B-GGUF', label: 'Qwen3.5 9B', note: 'Newest and most capable here; needs 16 GB+.' },
  ],
  embedding: [
    { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', label: 'Nomic Embed Text v1.5', note: 'Recommended. 768 dimensions, long inputs.' },
    { repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF', label: 'Qwen3 Embedding 0.6B', note: 'Higher quality, multilingual. Larger.' },
    { repo: 'second-state/All-MiniLM-L6-v2-Embedding-GGUF', label: 'all-MiniLM-L6-v2', note: 'Tiny and very fast; short inputs only.' },
  ],
};

// Quantization preference. Chat models trade a little quality for half the
// memory at Q4; embedding models are small, so keep more precision.
const QUANT_PREFERENCE = {
  chat: ['Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q4_0', 'Q5_K_M', 'Q8_0'],
  embedding: ['Q8_0', 'F16', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'F32'],
};

// Hugging Face pipeline tags per role.
const PIPELINE_TAGS = {
  chat: ['text-generation'],
  embedding: ['feature-extraction', 'sentence-similarity'],
};

async function hf(pathAndQuery) {
  const res = await fetch(`${HF}${pathAndQuery}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hugging Face ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Pick the GGUF file to download from a repository's file list. Skips files a
 * single llama-server cannot load on their own: split parts and vision
 * projectors (mmproj).
 */
// Smallest file that can be a real model; anything below is metadata such as
// an importance matrix.
const MIN_MODEL_BYTES = { chat: 100e6, embedding: 5e6 };

function pickFile(files, role) {
  const ggufs = files.filter((f) => f.type !== 'directory'
    && /\.gguf$/i.test(f.path)
    && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path)
    && !/(mmproj|imatrix)/i.test(f.path)
    && (f.lfs?.size || f.size || 0) >= (MIN_MODEL_BYTES[role] || 0));
  if (ggufs.length === 0) return null;
  for (const q of QUANT_PREFERENCE[role] || []) {
    const re = new RegExp(`[-_.]${q}[-_.]`, 'i');
    const hit = ggufs.find((f) => re.test(`${f.path.replace(/\.gguf$/i, '')}.`));
    if (hit) return hit;
  }
  return [...ggufs].sort((a, b) => (a.size || 0) - (b.size || 0))[0];
}

/**
 * Memory a model needs to run, and how that compares with this machine.
 * A rough rule: the file is loaded whole, plus working memory for the context
 * (about 1.5 GB at Ternlux's 16k-token chat context; little for embeddings).
 * Apple Silicon shares one pool between CPU and GPU, so total RAM is the limit
 * everywhere this estimate is used.
 */
function fitFor(sizeBytes, role) {
  const total = os.totalmem();
  const overhead = role === 'chat' ? 1.5e9 : 0.3e9;
  const need = (sizeBytes || 0) * 1.1 + overhead;
  const ratio = need / total;
  return {
    needBytes: Math.round(need),
    totalBytes: total,
    rating: ratio <= 0.5 ? 'good' : ratio <= 0.75 ? 'tight' : 'too_large',
  };
}

/** Resolve a repository to the one file Ternlux would download, or null. */
async function resolveRepo(repo, role, extra = {}) {
  const [info, files] = await Promise.all([
    hf(`/api/models/${repo}`),
    hf(`/api/models/${repo}/tree/main`),
  ]);
  if (info.gated) return null; // needs a licence click-through and a token
  const file = pickFile(Array.isArray(files) ? files : [], role);
  if (!file) return null;
  const size = file.lfs?.size || file.size || null;
  return {
    repo,
    role,
    file: file.path,
    size,
    sha256: file.lfs?.oid || null,
    license: info.cardData?.license || null,
    downloads: info.downloads || 0,
    likes: info.likes || 0,
    label: extra.label || repo.split('/')[1].replace(/[-_]GGUF$/i, ''),
    note: extra.note || null,
    fit: fitFor(size, role),
  };
}

async function settle(promises) {
  const results = await Promise.allSettled(promises);
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

/** The recommended models for `role`, resolved live. */
async function recommended(role) {
  return settle((RECOMMENDED[role] || []).map((m) => resolveRepo(m.repo, role, m)));
}

/**
 * Popular GGUF repositories on Hugging Face for `role` (optionally matching
 * `query`), resolved to files and limited to what could run on this machine.
 */
async function search(role, { query = '', limit = 12 } = {}) {
  const tags = PIPELINE_TAGS[role] || [];
  const lists = await Promise.all(tags.map((tag) => {
    const qs = new URLSearchParams({ filter: 'gguf', pipeline_tag: tag, sort: 'downloads', limit: '30' });
    if (query) qs.set('search', query);
    return hf(`/api/models?${qs}`).catch(() => []);
  }));
  const seen = new Set();
  // This is a work tool: leave out models published as safety-stripped.
  const unwanted = /(uncensor|abliterat|nsfw|erotic|jailbreak)/i;
  const repos = lists.flat()
    .filter((m) => m && m.id && !m.private && !unwanted.test(m.id) && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .slice(0, 30)
    .map((m) => m.id);
  const resolved = await settle(repos.map((repo) => resolveRepo(repo, role)));
  return resolved.filter((m) => m.fit.rating !== 'too_large').slice(0, limit);
}

module.exports = { RECOMMENDED, recommended, search, resolveRepo, pickFile, fitFor };
