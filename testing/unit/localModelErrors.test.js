// Errors from a local model explain what the model server was doing.
const test = require('node:test');
const assert = require('node:assert');

const ai = require('../../public/aiProviders');
const runtime = require('../../public/lib/localModels/runtime');

const timeout = () => Object.assign(new Error("Local model didn't respond within 600s."), { code: 'AI_TIMEOUT' });
const busy = (extra = {}) => ({
  running: true, busy: true, model: 'granite', requests: 1, busySeconds: 600,
  cpuCores: 4, lastError: null, promptTokens: 9213, writtenTokens: 0, ...extra,
});

test('timeout while still reading the request says so, with its size and the hardware', () => {
  const msg = ai.explainLocalFailure(timeout(), busy());
  assert.match(msg, /still reading your request \(9,213 tokens/);
  assert.match(msg, /after 10 minutes/);
  assert.match(msg, /hadn't started writing/);
  assert.match(msg, /this one has 4 cores/);
  assert.match(msg, /cloud provider in Settings → AI Provider/);
  assert.doesNotMatch(msg, /internet/i);
});

test('timeout while writing reports how much was written', () => {
  const msg = ai.explainLocalFailure(timeout(), busy({ writtenTokens: 1683 }));
  assert.match(msg, /had read your request \(9,213 tokens/);
  assert.match(msg, /written 1,683 tokens of its answer/);
  assert.match(msg, /still writing/);
});

test('timeout mentions requests queued behind the model', () => {
  assert.match(ai.explainLocalFailure(timeout(), busy({ requests: 2 })), /1 other request was waiting/);
  assert.match(ai.explainLocalFailure(timeout(), busy({ requests: 3 })), /2 other requests were waiting/);
  assert.doesNotMatch(ai.explainLocalFailure(timeout(), busy()), /other request/);
});

test('timeout with unknown request size still explains', () => {
  const msg = ai.explainLocalFailure(timeout(), busy({ promptTokens: null, busySeconds: null }));
  assert.match(msg, /still reading your request \(the conversation/);
});

test('nothing specific to say: generic message is kept', () => {
  assert.strictEqual(ai.explainLocalFailure(timeout(), busy({ busy: false })), null);
  assert.strictEqual(ai.explainLocalFailure(timeout(), busy({ busy: null })), null);
  assert.strictEqual(ai.explainLocalFailure(new Error('400 bad request'), busy()), null);
  assert.strictEqual(ai.explainLocalFailure(timeout(), null), null);
});

test('server not running: says it stopped and includes its last error', () => {
  const msg = ai.explainLocalFailure(new Error('connect ECONNREFUSED 127.0.0.1:39683'),
    { running: false, busy: null, cpuCores: 4, requests: 0, lastError: 'ggml: out of memory' });
  assert.match(msg, /isn't running/);
  assert.match(msg, /out of memory/);
  assert.match(msg, /Local Models/);
});

test('humanizeAIError uses the explanation and keeps the timeout code', () => {
  const err = timeout();
  err.localExplanation = ai.explainLocalFailure(err, busy());
  const e = ai.humanizeAIError(err, 'local', 'granite');
  assert.strictEqual(e.message, err.localExplanation);
  assert.strictEqual(e.code, 'AI_TIMEOUT');
  assert.strictEqual(e.userFacing, true);
});

test('local connection errors no longer blame the internet', () => {
  const local = ai.humanizeAIError(new Error('Connection error.'), 'local', 'granite');
  assert.doesNotMatch(local.message, /internet/i);
  assert.match(local.message, /local model server on this computer/);
  const cloud = ai.humanizeAIError(new Error('getaddrinfo ENOTFOUND api.openai.com'), 'openai', 'gpt');
  assert.match(cloud.message, /internet/i);
});

test('chatActivity when no chat server is running', async () => {
  const a = await runtime.chatActivity();
  assert.strictEqual(a.running, false);
  assert.strictEqual(a.busy, null);
  assert.ok(a.cpuCores > 0);
});
