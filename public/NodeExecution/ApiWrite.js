/**
 * ApiWrite — send rows to a REST API with an AI-written function.
 *
 * The write side of ApiFetch, used by an Output node whose destination is an
 * API connection and by a Join that writes to one (the join lands in the
 * workflow's DuckDB first, then this sends that table). Same safety rules as a
 * fetch: the code is written with {{PLACEHOLDER}} tokens, the credentials are
 * filled in here in the main process, and HTTP errors are fatal (strictAxios).
 *
 * The function contract the writing prompt asks for:
 *
 *   async function sendBatch({ axios, rows, batchIndex, state }) {
 *     …one or more requests for these rows…
 *     return { sent: <rows accepted>, failed: [{ index, error }] };
 *   }
 *
 * `state` is one object shared by every batch of the run, for what a lookup
 * found (a company already created, a list id) — so batch 4 does not create
 * the company batch 1 already made. It starts empty on every run.
 *
 * Rows arrive in batches of the size the code was written for (the vendor's
 * per-request limit). A batch that THROWS stops the run: batches before it
 * have already been written — an API has no transaction to roll back — so the
 * message says exactly how many rows went out. Rows the API rejected
 * individually (HubSpot's 207, Mailchimp's `errors`) come back in `failed` and
 * fail the node once every batch has been tried.
 */

const { loadApiFunction, strictAxios } = require('./ApiFetch');

const DEFAULT_BATCH = 100;
const MAX_BATCH = 10000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
const ERROR_SAMPLE = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function batchSizeOf(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH;
  return Math.min(n, MAX_BATCH);
}

// Re-chunk the source's pages into batches of exactly `size` rows (the last
// one shorter). Pages are whatever the reader yields — 5,000 rows, say — and
// the API takes 10 or 100 at a time.
async function* batchesOf(pages, size) {
  let buf = [];
  for await (const page of pages) {
    for (const row of page || []) {
      buf.push(row);
      if (buf.length === size) { yield buf; buf = []; }
    }
  }
  if (buf.length) yield buf;
}

// What a sendBatch returned → { sent, failed[] }. A bare number is the sent
// count; nothing at all means "every row went".
function readOutcome(result, batchLength) {
  if (typeof result === 'number' && Number.isFinite(result)) return { sent: result, failed: [] };
  if (!result || typeof result !== 'object') return { sent: batchLength, failed: [] };
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const sent = Number.isFinite(Number(result.sent)) ? Number(result.sent) : Math.max(0, batchLength - failed.length);
  return { sent, failed };
}

// 429 is the one error a batch is retried on: nothing was written. A 5xx or a
// network error may have written part of the batch, so it is not retried.
function retryAfterMs(err) {
  if (err?.response?.status !== 429) return null;
  const header = err.response.headers?.['retry-after'];
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : 2000;
  return Math.min(Math.max(ms, 500), MAX_RETRY_WAIT_MS);
}

function errorText(e) {
  const body = e?.response?.data;
  const detail = body && typeof body === 'object'
    ? JSON.stringify(body).slice(0, 300)
    : (typeof body === 'string' ? body.slice(0, 300) : '');
  return `${e?.message || String(e)}${detail ? ` — ${detail}` : ''}`;
}

/**
 * @param {object} p
 * @param {AsyncIterable<object[]>} p.pages      the source, a page at a time
 * @param {string}  p.apiConnectionId
 * @param {object}  [p.apiConnectionConfig]      the connection's public config
 * @param {string}  p.apiWriteCode               sendBatch source, with placeholders
 * @param {number}  [p.batchSize]                rows per call (the vendor's limit)
 * @param {string}  [p.destinationName]          for messages ("HubSpot")
 * @returns {Promise<{ success, warning?, message, rowCount, failedCount, errors }>}
 */
async function writeRowsToApi({
  pages, apiConnectionId, apiConnectionConfig = {}, apiWriteCode, batchSize, destinationName = 'the API',
}) {
  const loaded = await loadApiFunction({ apiConnectionId, apiConnectionConfig, code: apiWriteCode });
  if (loaded.error) return { success: false, message: loaded.error, rowCount: 0, failedCount: 0, errors: [] };
  const send = loaded.fn;
  const size = batchSizeOf(batchSize);
  const axios = strictAxios();
  const state = {};

  let sent = 0;
  let total = 0;
  let batchIndex = 0;
  const failed = [];
  for await (const rows of batchesOf(pages, size)) {
    total += rows.length;
    let outcome = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        outcome = readOutcome(await send({ axios, rows, batchIndex, state }), rows.length);
        break;
      } catch (err) {
        const wait = retryAfterMs(err);
        if (wait !== null && attempt < MAX_RATE_LIMIT_RETRIES) {
          console.log(`[ApiWrite] ${destinationName} rate-limited batch ${batchIndex + 1}; retrying in ${wait} ms`);
          await sleep(wait);
          continue;
        }
        const before = sent ? `${sent} row${sent === 1 ? ' was' : 's were'} already sent and stay in ${destinationName}` : 'nothing was sent';
        return {
          success: false,
          message: `Writing to ${destinationName} stopped at batch ${batchIndex + 1} (rows ${total - rows.length + 1}–${total}): `
            + `${errorText(err)}. ${before}.`,
          rowCount: sent,
          failedCount: failed.length + rows.length,
          errors: failed.slice(0, ERROR_SAMPLE),
        };
      }
    }
    sent += outcome.sent;
    for (const f of outcome.failed) {
      failed.push({
        row: Number.isFinite(Number(f?.index)) ? (total - rows.length) + Number(f.index) + 1 : null,
        error: String(f?.error || f?.message || 'rejected').slice(0, 300),
      });
    }
    batchIndex += 1;
  }

  if (total === 0) {
    return { success: true, warning: true, message: `The source is empty — nothing was sent to ${destinationName}.`, rowCount: 0, failedCount: 0, errors: [] };
  }
  const summary = `Sent ${sent} of ${total} row${total === 1 ? '' : 's'} to ${destinationName} in ${batchIndex} request batch${batchIndex === 1 ? '' : 'es'}.`;
  if (failed.length) {
    const sample = failed.slice(0, ERROR_SAMPLE)
      .map((f) => `${f.row ? `row ${f.row}: ` : ''}${f.error}`).join('; ');
    return {
      success: false,
      message: `${summary} ${destinationName} rejected ${failed.length}: ${sample}`,
      rowCount: sent,
      failedCount: failed.length,
      errors: failed.slice(0, ERROR_SAMPLE),
    };
  }
  return { success: true, message: summary, rowCount: sent, failedCount: 0, errors: [] };
}

module.exports = { writeRowsToApi, batchesOf, readOutcome, DEFAULT_BATCH, MAX_BATCH };
