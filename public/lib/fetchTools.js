/**
 * Helpers handed to AI-written API code as `tools`, next to `axios`:
 *   async function fetchData({ axios, tools }) { … }
 *
 * The code runs without `require`, and several report APIs deliver their
 * results as a compressed file to download (Amazon Ads: gzip JSON; Microsoft
 * Advertising: gzip CSV) or ask the caller to wait between polls. These cover
 * exactly that, so the generated code never hand-rolls a CSV parser or a
 * decompressor.
 */

const zlib = require('zlib');

/** Wait `ms` milliseconds (capped at a minute per call). */
function sleep(ms) {
  const wait = Math.max(0, Math.min(Number(ms) || 0, 60000));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/** Turn axios `arraybuffer` data (ArrayBuffer, Buffer or typed array) into a Buffer. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  throw new Error('gunzip expects the response body as binary — request it with responseType: "arraybuffer"');
}

/**
 * Decompress a gzip (or zlib/deflate) body to text. Data that is not
 * compressed comes back as text unchanged, since some servers decompress for
 * you and some don't.
 */
function gunzip(data) {
  const buf = toBuffer(data);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0x78) {
    try { return zlib.inflateSync(buf).toString('utf8'); } catch (_) { /* not zlib after all */ }
  }
  return buf.toString('utf8');
}

/**
 * Parse CSV text into an array of objects keyed by the header row.
 * Handles quoted fields, escaped quotes ("") and newlines inside quotes.
 * `skipRows` drops that many lines before the header (Microsoft Advertising
 * reports start with a few lines of report metadata); `skipFooterMatching`
 * drops trailing rows whose first cell matches it (their copyright footer).
 */
function parseCsv(text, { delimiter = ',', skipRows = 0, skipFooterMatching = null } = {}) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const body = rows.slice(skipRows).filter((r) => !(r.length === 1 && r[0] === ''));
  if (!body.length) return [];
  const header = body[0].map((h) => h.trim());
  const footer = skipFooterMatching ? new RegExp(skipFooterMatching) : null;
  return body.slice(1)
    .filter((r) => !(footer && footer.test(r[0] || '')))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? null : r[i]])));
}

/**
 * The files inside a ZIP archive, as [{ name, text }]. Covers what report APIs
 * send (Microsoft Advertising reports: one CSV in a zip) — stored or deflated
 * entries, no encryption, no zip64.
 */
function unzip(data) {
  const buf = toBuffer(data);
  const files = [];
  // Walk the central directory: it has every entry's true sizes, which a
  // streamed archive leaves out of the local headers.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('unzip: not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('unzip: damaged central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(dataStart, dataStart + compressed);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`unzip: unsupported compression method ${method} in ${name}`);
    if (!name.endsWith('/')) files.push({ name, text: content.toString('utf8').replace(/^\uFEFF/, '') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/**
 * Lowercase hex SHA-256 of a string, for audience and conversion uploads that
 * require hashed emails or phone numbers (Meta, Google, LinkedIn, Pinterest,
 * TikTok). Normalise first as the API asks — usually trimmed and lowercased.
 */
function sha256(value) {
  return require('crypto').createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

/** Parse newline-delimited JSON (one object per line), skipping blank lines. */
function parseJsonLines(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

module.exports = { sleep, gunzip, unzip, parseCsv, parseJsonLines, sha256 };
