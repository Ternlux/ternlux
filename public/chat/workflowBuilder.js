/**
 * Ternlux Workflow Builder — subagent that turns a natural-language request
 * into a `nodes[] + edges[]` workflow document and persists it.
 *
 * Two-phase contract (the outer chat agent calls these two tools):
 *
 *   1. planBuild({ userRequest, workflow, helpers, getDb })
 *      → returns a flat list of build steps, each with the EXACT prompt
 *        that will be used to build that node. The renderer surfaces this
 *        plan to the user and waits for a single confirmation.
 *
 *   2. executeBuild({ plan, workflow, helpers, getDb })
 *      → runs every step in order, accumulating `nodes[]` and `edges[]` in
 *        memory, then writes the workflow once (db:insert for `new`,
 *        db:update for `modify`).
 *
 * The per-node config shapes mirror what each NodeChat's `buildConfig()`
 * saves today — see src/components/Workflows/NodeChats/*NodeChat.js. We do
 * NOT touch those components.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DOCS_ROOT       = path.join(__dirname, '..', 'docs');
const NODE_DOCS_ROOT  = path.join(DOCS_ROOT, 'nodes');
const CHAT_DOCS_ROOT  = path.join(DOCS_ROOT, 'chat-prompts');
const SKILL_DOCS_ROOT = path.join(DOCS_ROOT, 'plugins', 'skills');
const SAMPLE_ROW_LIMIT = 5;
const PICK_TABLE_RETRIES = 1;
const PLAN_RETRIES = 3;

const ChatPrompts = {
  join:       require('../ChatPrompts/Join').join,
  transfomer: require('../ChatPrompts/Transfomer').transfomer,
  restApi:    require('../ChatPrompts/RestApi'),
};

// REST API data sources are materialised into local NeDB by running the
// AI-authored fetch function — the SAME executor the workflow runtime uses
// (workflowExecutionHelpers' API source path). Requiring the singleton here
// reuses the instance electron.js already wired up via apiFetch.initialize().
const { handleExecuteApiFetch } = require('../NodeExecution/ApiFetch');

// Local NoSQL transform output is persisted by saveToLocalNeDB (public/transfomers/NeDB.js)
// to a deterministic per-collection file: userData/local-collections/<collection>.db.
// Compute it here so the builder can record targetLocalPath even when the source is
// a remote DB (e.g. MongoDB) with no local path to inherit.
function localNeDBPath(collectionName) {
  if (!collectionName) return null;
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'local-collections', `${collectionName}.db`);
  } catch (err) {
    console.warn('[workflowBuilder] Could not resolve local NeDB path:', err.message);
    return null;
  }
}

// Default local LanceDB directory, matching getLanceDBPath (public/lib/lancedb.js)
// and the vector-db-executor skill's buildConfig. LanceDB addresses a directory,
// so vector transformer nodes record this folder (not a per-collection file).
function defaultLanceDBPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'data', 'lancedb');
  } catch (err) {
    console.warn('[workflowBuilder] Could not resolve default LanceDB path:', err.message);
    return null;
  }
}

// The shared local SQLite workspace, matching appSqliteDbPath in electron.js
// (userData/app-data.db) — where executeLocalSQLiteJoin writes its result.
// Recorded as targetLocalPath at build time so previews / downstream nodes can
// read the joined table before the workflow has been run once.
function defaultLocalSqlitePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'app-data.db');
  } catch (err) {
    console.warn('[workflowBuilder] Could not resolve local SQLite path:', err.message);
    return null;
  }
}

// Resolve a concrete absolute path for a local file export when the AI didn't
// supply one (the interactive output node opens a native save dialog; the
// headless builder has no dialog, so a deterministic default is needed or the
// export writes to a null path at run time). Defaults to the user's Downloads
// folder, falling back to userData, then /tmp.
function defaultOutputSavePath(format, baseName) {
  const extByFormat = {
    json: 'json', csv: 'csv', excel: 'xlsx', nedb: 'db',
    sqlite: 'db', parquet: 'parquet', avro: 'avro', lancedb: 'lance',
  };
  const ext = extByFormat[format] || 'json';
  const safeBase = String(baseName || 'output').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'output';
  const fileName = `${safeBase}.${ext}`;
  try {
    const { app } = require('electron');
    let dir;
    try { dir = app.getPath('downloads'); } catch (_e) { dir = app.getPath('userData'); }
    return path.join(dir, fileName);
  } catch (err) {
    console.warn('[workflowBuilder] Could not resolve default output path:', err.message);
    return path.join('/tmp', fileName);
  }
}

/**
 * Describe the host machine and Ternlux's on-disk layout so the assistant /
 * planner can reason about and reference real file paths (e.g. where a local
 * export lands, where local collections / LanceDB / the SQLite workspace live,
 * how to write an absolute path that is valid on THIS user's OS). Mirrors the
 * deterministic paths recorded at build time (see localNeDBPath /
 * defaultLanceDBPath / defaultLocalSqlitePath / defaultOutputSavePath above).
 *
 * Every Electron `app.getPath` lookup is guarded — in a non-Electron context
 * (tests, headless) the fields simply fall back to os.* or are omitted, so this
 * never throws and never blocks prompt assembly.
 */
function buildSystemContext() {
  // OS basics — always available via the `os` module.
  const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  const lines = [];
  lines.push(`Operating system : ${platformNames[process.platform] || process.platform} (${process.platform}, ${process.arch})`);
  lines.push(`Path separator   : "${path.sep}"  — build absolute paths with this separator; ${process.platform === 'win32' ? 'paths look like C:\\Users\\you\\...' : 'paths look like /Users/you/...'}`);

  // Electron-resolved locations. Guarded so non-Electron callers still get OS info.
  let userData = null;
  let home = null;
  let downloads = null;
  let documents = null;
  let temp = null;
  try {
    const { app } = require('electron');
    const tryGet = (name) => { try { return app.getPath(name); } catch (_e) { return null; } };
    userData  = tryGet('userData');
    home      = tryGet('home');
    downloads = tryGet('downloads');
    documents = tryGet('documents');
    temp      = tryGet('temp');
  } catch (_err) {
    // Not running under Electron — fall back to os.* where we can.
  }
  home      = home      || os.homedir();
  temp      = temp      || os.tmpdir();

  lines.push(`Home directory   : ${home}`);
  if (documents)  lines.push(`Documents folder : ${documents}`);
  if (downloads)  lines.push(`Downloads folder : ${downloads}  — default destination for file exports the user doesn't path explicitly`);
  lines.push(`Temp directory   : ${temp}`);

  if (userData) {
    lines.push('');
    lines.push(`Ternlux app data : ${userData}`);
    lines.push('  Deterministic locations Ternlux reads/writes inside that folder:');
    lines.push(`  - Local collections (NeDB)  : ${path.join(userData, 'local-collections')}${path.sep}<collection>.db`);
    lines.push(`  - Local LanceDB (vectors)   : ${path.join(userData, 'data', 'lancedb')}  (a directory, not a file)`);
    lines.push(`  - Shared SQLite workspace   : ${path.join(userData, 'app-data.db')}  (local joins / scratch tables)`);
  }

  return lines.join('\n');
}

// Extract column names from a CREATE TABLE DDL, best-effort. Splits the
// parenthesised body on top-level commas (so types like DECIMAL(10,2) survive)
// and skips table-level constraint clauses (PRIMARY KEY, FOREIGN KEY, …).
function parseDdlColumns(ddl) {
  if (!ddl || typeof ddl !== 'string') return [];
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  if (open === -1 || close === -1 || close <= open) return [];
  const body = ddl.slice(open + 1, close);
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const cols = [];
  for (const p of parts) {
    const tokens = p.trim().split(/\s+/);
    if (!tokens.length) continue;
    const name = tokens[0].replace(/^["'`[]+|["'`\]]+$/g, '');
    if (!name) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|KEY)$/i.test(name)) continue;
    cols.push({ name, type: tokens.slice(1).join(' ') || 'unknown' });
  }
  return cols;
}

// Best-effort column list for a join's OUTPUT table. The target DDL is the
// source of truth (it reflects the actual created columns, including any
// collision aliasing like transactions__id); fall back to the flattened
// selectedColumns map, else empty.
function joinOutputColumns(gen, joinSettings) {
  const fromDdl = parseDdlColumns(gen?.targetDdl);
  if (fromDdl.length) return fromDdl;
  const sel = joinSettings?.selectedColumns;
  if (sel && typeof sel === 'object') {
    const flat = [];
    for (const arr of Object.values(sel)) {
      if (Array.isArray(arr)) {
        for (const c of arr) if (c && c !== '*') flat.push({ name: c, type: 'unknown' });
      }
    }
    return flat;
  }
  return [];
}

/**
 * Builders throw this when they need a follow-up from the user mid-execute.
 * `executeBuild` catches it and re-throws with `stepIndex` attached. The
 * workflow:executeBuild IPC surfaces it to the renderer as a structured
 * response (needsClarification=true) so the user can answer and retry.
 */
class ClarificationNeeded extends Error {
  constructor(question, context = {}) {
    super(`Clarification needed: ${question}`);
    this.name = 'ClarificationNeeded';
    this.isClarificationNeeded = true;
    this.question = String(question || '').trim();
    this.context = context || {};
  }
}

/**
 * Thrown by a node builder when the analyser routes the node through a
 * skill AND the skill returns `ask_questions` / `answer_directly` — i.e.
 * the skill subagent needs to converse with the user before producing
 * execution params. executeBuild lets it bubble; the IPC handler
 * surfaces it as { needsSkillSubagent, skillId, nodeId, question, state,
 * action, context }. The renderer then routes the user's next replies
 * through `chat:skillStep` instead of the regular chat:step until the
 * skill returns `execute` (continue build) or `unrelateSkill` /
 * close-out (fall back to standard SQL/NoSQL flow).
 */
class SkillSubagentRequired extends Error {
  constructor({ skillId, nodeId, question, action, state, context, directAnswer }) {
    super(`Skill subagent ${skillId} requires user input`);
    this.name = 'SkillSubagentRequired';
    this.isSkillSubagentRequired = true;
    this.skillId = skillId;
    this.nodeId  = nodeId;
    this.question      = String(question || directAnswer || '').trim();
    this.directAnswer  = directAnswer || null;
    this.action  = action; // 'ask_questions' | 'answer_directly'
    this.state   = state || {};
    this.context = context || {};
  }
}

/**
 * Return the answer the user has already given to this question (if any).
 * Matching is case-insensitive on the question text. Clarifications come
 * from `plan.clarifications`, accumulated across Accept retries.
 */
/**
 * Render gathered clarifications as a chatHistory array that callAI / callJson
 * can pass through to the provider. Each entry becomes an assistant
 * "Clarifying question: …" message followed by the user's answer. The
 * caller's prompt body should NOT also dump the same Q&A inline — the
 * intent is that the planner / picker / sub-agent reads them out of the
 * conversation rather than out of the prompt.
 */
function clarificationsAsChatHistory(clarifications) {
  if (!Array.isArray(clarifications) || clarifications.length === 0) return [];
  const out = [];
  for (const c of clarifications) {
    if (!c || !c.question) continue;
    out.push({ sender: 'assistant', text: `Clarifying question: ${String(c.question).trim()}` });
    if (c.answer != null && String(c.answer).trim() !== '') {
      out.push({ sender: 'user', text: String(c.answer).trim() });
    }
  }
  return out;
}

function findClarificationAnswer(clarifications, question) {
  if (!Array.isArray(clarifications) || !question) return null;
  const q = String(question).trim().toLowerCase();
  const hit = clarifications.find((c) => String(c?.question || '').trim().toLowerCase() === q);
  return hit ? String(hit.answer || '').trim() : null;
}

/**
 * Per-node chat-history helpers. Each built node carries a `config.chat`
 * array matching the per-NodeChat shape so the editor's chat panel renders
 * the workflow-builder's reasoning AND lets the user continue chatting
 * with the AI after the build.
 *
 * Bot shape:
 *   { id, sender:'bot', text, timestamp,
 *     responseRequired, responseType, ref, placeholder, metadata }
 * User shape:
 *   { id, sender:'user', text, timestamp, ref, value, data }
 *
 * Refs match what each NodeChat's handleUserResponse switch expects so
 * a follow-up reply flows through the same code path as a manually-typed
 * one. `chatContinue` is the universal "free-form follow-up" ref used at
 * the tail of the rebuilt chat to keep the input enabled.
 */
function pushUserMsg(chat, text, opts = {}) {
  if (!Array.isArray(chat) || !text) return;
  chat.push({
    id: `user-${Date.now()}-${chat.length}`,
    sender: 'user',
    text: String(text),
    timestamp: new Date().toISOString(),
    ref: opts.ref || '',
    value: opts.value !== undefined ? opts.value : String(text),
    data: opts.data !== undefined ? opts.data : null,
  });
}

function pushBotMsg(chat, text, opts = {}) {
  if (!Array.isArray(chat) || !text) return;
  const responseRequired = opts.responseRequired === true;
  chat.push({
    id: `bot-${Date.now()}-${chat.length}`,
    sender: 'bot',
    text: String(text),
    timestamp: new Date().toISOString(),
    responseRequired,
    responseType: opts.responseType || 'text',
    ref: opts.ref || '',
    placeholder: opts.placeholder || (responseRequired ? 'Type your response…' : ''),
    metadata: opts.metadata !== undefined ? opts.metadata : null,
  });
}

/**
 * Per-stepType chat scaffolding. Defines the initial bot prompt the user
 * would have seen had they opened the NodeChat manually, and the ref used
 * on the user's first response so re-opening the node lands on the right
 * branch of handleUserResponse.
 */
const CHAT_SEED_BY_STEP = {
  start: {
    initialBot: "Let's configure the start trigger. How should this workflow run?",
    ref: 'triggerType',
    placeholder: 'Describe when this should run…',
  },
  dataSource: {
    initialBot: "Let's configure your data source. Which connection and table should we read from?",
    ref: 'connectionId',
    placeholder: 'Describe the data source…',
  },
  transformer: {
    initialBot: 'Describe how you want to transform this data:',
    ref: 'transformationRequest',
    placeholder: 'Describe the transformation…',
  },
  join: {
    initialBot: 'Describe how you want to join these sources:',
    ref: 'joinRequest',
    placeholder: 'Describe the join…',
  },
  output: {
    initialBot: 'Where should the result go?',
    ref: 'outputType',
    placeholder: 'Describe the output destination…',
  },
};

const CHAT_CONTINUE_PLACEHOLDER = 'Ask a follow-up question or request changes…';

/**
 * Seed a node's chat with the per-NodeChat initial bot prompt + the
 * planner's step prompt as the user's answer. Returns the seed config so
 * downstream code can reference the entry-point ref if needed.
 */
function seedChatForStep(chat, stepType, userPromptText) {
  const seed = CHAT_SEED_BY_STEP[stepType] || { ref: '', placeholder: '', initialBot: null };
  if (seed.initialBot) {
    pushBotMsg(chat, seed.initialBot, {
      responseRequired: true,
      ref: seed.ref,
      placeholder: seed.placeholder,
    });
  }
  pushUserMsg(chat, userPromptText, { ref: seed.ref });
  return seed;
}

/**
 * Tail the chat with a free-form follow-up prompt so the NodeChat's
 * `getCurrentQuestion` finds a pending bot message — that's what keeps
 * the input enabled in the editor and routes the user's reply through
 * the chatContinue branch of handleUserResponse.
 */
function pushChatContinue(chat, text = 'You can ask follow-up questions to refine this configuration, or proceed when ready.') {
  pushBotMsg(chat, text, {
    responseRequired: true,
    ref: 'chatContinue',
    placeholder: CHAT_CONTINUE_PLACEHOLDER,
  });
}

/**
 * Look up a connector plugin via helpers.pluginManager (the main-process
 * helper bundle injected by buildSkillHelpers in electron.js). Returns null
 * when the plugin isn't loaded — callers should fall back to safe defaults.
 */
function getConnectorPlugin(helpers, dbType) {
  if (!dbType || !helpers || !helpers.pluginManager) return null;
  try {
    if (helpers.pluginManager.hasConnector && !helpers.pluginManager.hasConnector(dbType)) return null;
    return helpers.pluginManager.getConnector(dbType) || null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Doc loading. We pull two parallel sets:
//   - public/docs/nodes/*.md         — describes each node TYPE (configuration
//                                      contract, what a node needs to run).
//   - public/docs/chat-prompts/*.md  — describes the per-node chat-prompt
//                                      modules (Join, RestApi, Transformer)
//                                      so the planner understands the
//                                      decision logic each builder will use.
// Both trees are fed into the planner so the AI can ask the right
// clarifying questions and write per-step prompts the builders can actually
// satisfy.
// ---------------------------------------------------------------------------

const cachedDocs = { nodes: null, chat: null, skills: null };

function loadMarkdownDir(dir) {
  const out = {};
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { entries = []; }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    try { out[name.replace(/\.md$/i, '')] = fs.readFileSync(path.join(dir, name), 'utf8'); }
    catch (_) { /* skip */ }
  }
  return out;
}

function loadNodeDocs() {
  if (!cachedDocs.nodes) cachedDocs.nodes = loadMarkdownDir(NODE_DOCS_ROOT);
  return cachedDocs.nodes;
}

function loadChatPromptDocs() {
  if (!cachedDocs.chat) cachedDocs.chat = loadMarkdownDir(CHAT_DOCS_ROOT);
  return cachedDocs.chat;
}

/**
 * Skill docs sit under public/docs/plugins/skills/*.md — one markdown
 * file per installed skill (javascript-executor, python-executor,
 * vector-db-executor, …). Keyed by skill id so we can hand the planner
 * just the docs for the skills it actually wants to consider.
 */
function loadSkillDocs() {
  if (!cachedDocs.skills) {
    const all = loadMarkdownDir(SKILL_DOCS_ROOT);
    // README.md is the section overview, not a skill — drop so the picker
    // can't pick it as a skill id.
    delete all.README;
    cachedDocs.skills = all;
  }
  return cachedDocs.skills;
}

function docsToPromptSection(docs) {
  return Object.entries(docs)
    .map(([k, body]) => `\n## ${k}.md\n\n${body}`)
    .join('\n');
}

function nodeDocsAsPromptSection() {
  return docsToPromptSection(loadNodeDocs());
}

function chatPromptDocsAsPromptSection() {
  return docsToPromptSection(loadChatPromptDocs());
}

/**
 * Ask the AI which skill docs (if any) are relevant for this user
 * request. Cheap small-context call — only the skill names + their
 * description blurbs + the user request go up — so we can decide
 * whether to spend tokens on a full skill markdown in the planner
 * system prompt.
 *
 * Returns an array of skill ids that the planner should be briefed on.
 * Empty array means "no skill docs needed for this request".
 */
async function pickRelevantSkillDocs({ helpers, userRequest, clarifications = [] }) {
  const skillDocs = loadSkillDocs();
  const installedIds = Object.keys(skillDocs);
  if (installedIds.length === 0) return [];

  // Build a 1-line catalogue from each skill doc (id + first non-blank
  // markdown line). Keeps the picker prompt tiny.
  const catalogue = installedIds.map((id) => {
    const body = skillDocs[id] || '';
    const firstLine = body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l && !l.startsWith('---')) || '(no description)';
    return `- ${id}: ${firstLine}`;
  }).join('\n');

  const prompt = `You decide which skill documentation should be loaded into the workflow planner's
context for this user request. A "skill" is an optional execution path that a
transformer or join can route through instead of plain SQL/NoSQL — e.g. a
JavaScript executor, a Python executor, a vector-DB executor.

User request:
"${String(userRequest || '').trim()}"

Prior clarifying questions and the user's answers (if any) appear in the chat
history — every assistant message starting with "Clarifying question:" is a
prior question followed by the user's reply. Take those into account.

Installed skills:
${catalogue}

Reply with a SINGLE JSON object — nothing else:
{ "skillIds": ["<id1>", "<id2>"], "reasoning": "<one short sentence>" }

Rules:
- Only include skills that are PLAUSIBLY useful for this specific request.
- If plain SQL/NoSQL clearly handles it, return an empty array.
- Use only ids from the "Installed skills" list above; do not invent ids.
- Be conservative — every extra skill costs prompt tokens at planning time.`;

  try {
    const chatHistory = clarificationsAsChatHistory(clarifications);
    const out = await callJson(helpers, prompt, { maxTokens: 200, chatHistory });
    const ids = Array.isArray(out?.skillIds) ? out.skillIds : [];
    return ids.filter((id) => installedIds.includes(id));
  } catch (_err) {
    return [];
  }
}

function skillDocsAsPromptSection(skillIds) {
  if (!Array.isArray(skillIds) || skillIds.length === 0) return '';
  const docs = loadSkillDocs();
  const sections = skillIds
    .map((id) => docs[id] ? `\n## ${id}.md\n\n${docs[id]}` : null)
    .filter(Boolean);
  if (!sections.length) return '';
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Shared workflow serializer. Used by both planBuild (modify mode) and the
// outer chat assistant when surfacing get_workflow results to the AI. Token
// budget rules:
//   - edges  → keep only { source, target }
//   - nodes  → drop everything except id/type/position + a slimmed `data`
//     - data.chat                    → removed entirely
//     - data.config.chat             → removed entirely
//     - data.config.sourceTableSchema.sampleData → kept to 1 row max
//     - data.config.targetTableSchema.sampleData → kept to 1 row max
// Everything else (config fields, schema columns, label, etc.) is preserved
// because the planner / chat agent needs that to write follow-ups and prompts.
// ---------------------------------------------------------------------------

function slimSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const sample = Array.isArray(schema.sampleData) ? schema.sampleData.slice(0, 1) : schema.sampleData;
  return { ...schema, sampleData: sample };
}

function slimNodeData(data) {
  if (!data || typeof data !== 'object') return data;
  const { chat: _omitChat, ...rest } = data;
  const config = rest.config && typeof rest.config === 'object' ? { ...rest.config } : rest.config;
  if (config && typeof config === 'object') {
    delete config.chat;
    if (config.sourceTableSchema) config.sourceTableSchema = slimSchema(config.sourceTableSchema);
    if (config.targetTableSchema) config.targetTableSchema = slimSchema(config.targetTableSchema);
  }
  return { ...rest, ...(config !== undefined ? { config } : {}) };
}

function slimWorkflowForPrompt(wf) {
  if (!wf || typeof wf !== 'object') return wf;
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  // Per-node we keep: id (so edge source/target resolves), type (canonical
  // node-type signal — join nodes don't always set data.config.nodeType),
  // and data (slimmed). Everything else on a node — position, dragging,
  // width/height, selection — is ignored to save tokens.
  return {
    id:    wf.id || wf._id || null,
    name:  wf.name || null,
    nodes: nodes.map((n) => ({
      id:   n.id,
      type: n.type,
      data: slimNodeData(n.data),
    })),
    edges: edges.map((e) => ({ source: e.source, target: e.target })),
  };
}

// ---------------------------------------------------------------------------
// JSON parsing. callAI's upstream `stripMarkdownCodeBlocks` removes outer
// ```json fences, but the model still occasionally pads with prose. Reuse the
// brace-balanced scan from chatAssistant.js for robustness.
// ---------------------------------------------------------------------------

function extractFirstJsonObject(s) {
  let depth = 0, start = -1, inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) return s.slice(start, i + 1); }
  }
  return null;
}

async function callJson(helpers, prompt, options = {}) {
  const raw = await helpers.callAI(prompt, { ...options });
  const body = extractFirstJsonObject(String(raw || '').trim()) || String(raw || '').trim();
  try { return JSON.parse(body); }
  catch (err) {
    console.log('body: ', body)
    const head = String(raw || '').slice(0, 250);
    throw new Error(`AI did not return valid JSON: ${err.message}. Head: ${head}`);
  }
}

// ---------------------------------------------------------------------------
// Connection picker — used by every node type that needs to reference a
// saved connection. AI sees the list, returns exactly one id. Validated.
// ---------------------------------------------------------------------------

function summarizeConnections(connections) {
  return connections.map((c) => ({
    id: c.id || c._id,
    name: c.name,
    dbType: c.dbType,
    dbCategory: c.dbCategory || null,
    connectionType: c.connectionType || null,
  }));
}

// ---------------------------------------------------------------------------
// Table picker — AI must NOT hallucinate; it picks from the live list.
// Retries on mismatch; on second mismatch falls back to first table + warning.
// ---------------------------------------------------------------------------

async function pickTable(intent, tables, helpers, warnings) {
  if (!tables.length) throw new Error('Connection has no tables/collections.');
  const list = tables.map((t) => {
    if (typeof t === 'string') return { name: t, schema: null };
    return { name: t.name || String(t), schema: t.schema || null, type: t.type || null };
  });
  const prompt = `Pick exactly one table/collection for the user's intent.

User intent: "${intent}"

Available tables (JSON):
${JSON.stringify(list, null, 2)}

Respond with ONLY this single raw JSON object — no markdown code fences, no prose before or after it:
{ "table": "<name verbatim>", "schema": <string or null>, "reason": "one line" }
The "table" value MUST match one of the names above EXACTLY.`;

  for (let attempt = 0; attempt <= PICK_TABLE_RETRIES; attempt++) {
    try {
      const out = await callJson(helpers, prompt);

      console.log('pickTable+out: ', out)

      const found = list.find((t) => t.name === out.table);
      if (found) return found;
    } catch (_) { /* retry */ }
  }
  warnings.push(`Could not match AI table choice; defaulting to "${list[0].name}".`);
  return list[0];
}

// ---------------------------------------------------------------------------
// Schema sample — populate `sourceTableSchema = { tableName, columns, sampleData }`
// the same way DataSourceNodeChat does, by calling getColumns + a small sample
// runQuery. The shape matches the sample workflow the user supplied.
// ---------------------------------------------------------------------------

/**
 * Build a preview SQL string for a table. Mirrors what TransformerNodeChat
 * does in the renderer: ask the connector plugin for the dialect-specific
 * preview query (Snowflake/BigQuery/MSSQL/etc all have their own syntax)
 * and use the plugin's quoteIdentifier for proper schema.table quoting.
 * Falls back to a plain double-quoted "schema"."table" + LIMIT when no
 * plugin is registered for the dbType (best-effort for older configs).
 */
function sqlPreviewQuery(table, schema, dbType, helpers, limit = SAMPLE_ROW_LIMIT) {
  const connector = getConnectorPlugin(helpers, dbType);
  const quoted = (typeof connector?.quoteIdentifier === 'function')
    ? connector.quoteIdentifier(table, schema || null)
    : (schema ? `"${schema}"."${table}"` : `"${table}"`);
  if (typeof connector?.getPreviewQuery === 'function') {
    return connector.getPreviewQuery(quoted, limit);
  }
  return `SELECT * FROM ${quoted} LIMIT ${limit}`;
}

function nosqlPreviewQuery(collection) {
  return JSON.stringify({ collection, filter: {}, limit: SAMPLE_ROW_LIMIT });
}

async function loadSchemaSample(connection, table, schema, helpers, warnings) {
  const isNoSQL = connection.dbType === 'mongodb' || connection.dbType === 'nedb';
  let columns = [];
  let sampleData = [];

  try { columns = await helpers.getColumns(connection, table, schema); }
  catch (err) { warnings.push(`getColumns(${table}) failed: ${err.message}`); }

  try {
    const query = isNoSQL
      ? { collection: table, filter: {}, limit: SAMPLE_ROW_LIMIT }
      : sqlPreviewQuery(table, schema, connection.dbType, helpers);
    sampleData = await helpers.runQuery(connection, query);
    if (!Array.isArray(sampleData)) sampleData = sampleData?.rows || sampleData?.data || [];
  } catch (err) { warnings.push(`sample query for ${table} failed: ${err.message}`); }

  // When getColumns returns nothing but we have sample rows, derive columns from row keys.
  if (!columns.length && sampleData.length) {
    const keys = new Set();
    for (const row of sampleData) { Object.keys(row || {}).forEach((k) => keys.add(k)); }
    columns = Array.from(keys).map((name) => ({ name, type: 'unknown' }));
  }

  return {
    tableName: table,
    columns: columns.map((c) => ({ name: c.name || String(c), type: c.type || 'unknown' })),
    sampleData: sampleData.slice(0, SAMPLE_ROW_LIMIT),
  };
}

// Build a `sourceTableSchema` for a REST API source AFTER its fetch function
// has materialised rows into local NeDB. Unlike loadSchemaSample, there is no
// connector getColumns to call — the API response shape is only knowable from
// the rows it returned — so columns are derived from the materialised rows
// (falling back to the single sampleRow handleExecuteApiFetch returns when the
// NeDB read comes back empty). _id is NeDB-internal and excluded.
async function loadApiSchemaSample(collection, localPath, sampleRow, helpers, warnings) {
  let sampleData = [];
  if (localPath) {
    try {
      sampleData = await helpers.runQuery('nedb', { filter: {}, limit: SAMPLE_ROW_LIMIT }, localPath);
      if (!Array.isArray(sampleData)) sampleData = sampleData?.rows || sampleData?.data || [];
    } catch (err) {
      warnings.push(`API sample read for "${collection}" failed: ${err.message}`);
    }
  }
  if (!sampleData.length && sampleRow && typeof sampleRow === 'object') {
    sampleData = [sampleRow];
  }

  const stripId = (row) => {
    if (!row || typeof row !== 'object') return row;
    const { _id, ...rest } = row;
    return rest;
  };
  const clean = sampleData.map(stripId);

  const keys = new Set();
  for (const row of clean) { Object.keys(row || {}).forEach((k) => keys.add(k)); }
  const columns = Array.from(keys).map((name) => ({ name, type: 'unknown' }));

  return {
    tableName: collection,
    columns,
    sampleData: clean.slice(0, SAMPLE_ROW_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Start node
// ---------------------------------------------------------------------------

async function buildStartConfig({ stepPrompt, helpers, chat }) {
  const prompt = `Pick the trigger configuration for a workflow Start node.

User intent for this start node: "${stepPrompt}"

Reference (from public/docs/nodes/start.md):
${loadNodeDocs().start || ''}

Return JSON, choosing exactly one triggerType:

For manual:
{ "triggerType": "manual", "description": "Manual trigger" }

For time (interval/daily/weekly/monthly):
{
  "triggerType": "time",
  "cronExpression": "<5-field cron>",
  "cronConfig": { "scheduleType": "interval"|"daily"|"weekly"|"monthly", ... },
  "description": "Every Monday at 9:30 am"
}

For file (file or directory watch):
{
  "triggerType": "file",
  "fileWatchConfig": {
    "path": "<absolute path>",
    "type": "file" | "directory",
    "events": ["add"|"change"|"unlink"|"addDir"|"changeDir"|"unlinkDir", ...],
    "pattern": null
  },
  "description": "Watch file: /abs/path"
}


Pick the most natural choice from the intent. If unclear, choose "manual".
Return ONLY the JSON object.`;

  const out = await callJson(helpers, prompt);
  console.log('buildStartConfig+out: ', out)
  const summary = out?.description
    ? `Configured start node (${out.triggerType || 'manual'}): ${out.description}`
    : `Configured start node with triggerType="${out?.triggerType || 'manual'}".`;
  pushBotMsg(chat, summary);
  return { nodeType: 'start', ...out };
}

// ---------------------------------------------------------------------------
// Data source — multi-stage flow that mirrors handleConnectionSelection +
// handleTableSelection in DataSourceNodeChat.js. AI picks the connection,
// branch-by-(connectionType, dbType) governs how the rest of the config is
// produced (database → live getTables; rest-api → fetch function; file → use
// connection.fileInfo; cloud → warn).
// ---------------------------------------------------------------------------

async function buildDataSourceConfig({ stepPrompt, helpers, warnings, connectionId, chat }) {
  // The planner declares step.connectionId at plan-build time and the
  // envelope validator guarantees it resolves to a real saved connection,
  // so the builder no longer has to ask the AI which one to pick.
  if (!connectionId) {
    throw new Error('dataSource step is missing connectionId — planner contract violated.');
  }
  const connections = helpers.connections || [];
  const conn = connections.find((c) => (c.id || c._id) === connectionId);
  if (!conn) {
    throw new Error(`dataSource connectionId "${connectionId}" not found among saved connections.`);
  }

  const config = {
    nodeType: 'datasource',
    sourceConnectionId: conn.id || conn._id,
    sourceConnectionName: conn.name,
    sourceConnectionType: conn.connectionType || 'file',
    sourceType: conn.fileType || conn.apiType || conn.dbType,
    sourceDbType: conn.dbType,
    sourceDbCategory: conn.dbCategory || null,
    sourceDbConfig: conn.dbConfig || {},
  };

  // Branch 1 — REST API. Generates an async fetch function via the existing
  // RestApi prompt. No table step; the runner materialises rows into NeDB.
  if (conn.dbType === 'rest-api') {
    const restPrompt = ChatPrompts.restApi.restApiAnalysisRequest({
      userRequest: stepPrompt,
      connectionAuthType: conn.dbConfig?.authType || 'none',
      connectionBaseUrl: conn.dbConfig?.baseUrl || '',
      connectionApiKeyName: conn.dbConfig?.apiKeyName || '',
      connectionBasicUser: conn.dbConfig?.basicUser || '',
    });
    const out = await callJson(helpers, restPrompt);
    console.log('buildDataSourceConfig+out: ', out)
    if (out.action !== 'create_plan' || !out.code) {
      warnings.push(`REST API source: AI returned action="${out.action}" — fetch function not produced. Reason: ${out.followUpQuestion || out.directAnswer || 'unknown'}`);
    }
    const apiCollection = sanitizeCollectionName(stepPrompt);
    Object.assign(config, {
      sourceConnectionType: 'api',
      sourceDbType: 'nedb',
      sourceDbCategory: 'API',
      sourceApiConnectionId: conn.id || conn._id,
      sourceApiConnectionName: conn.name,
      sourceConnectionId: 'local-nedb',
      sourceCollection: apiCollection,
      sourceDataset: apiCollection,
      sourceLocalPath: null,
      apiFetchPrompt: stepPrompt,
      apiFetchExplanation: out.explanation || '',
      apiFetchCode: out.code || '',
      apiConnectionPublicConfig: {
        baseUrl: conn.dbConfig?.baseUrl || '',
        authType: conn.dbConfig?.authType || 'none',
        apiKeyName: conn.dbConfig?.apiKeyName || '',
        basicUser: conn.dbConfig?.basicUser || '',
      },
    });

    pushBotMsg(chat, out.explanation
      ? `Configured REST API data source "${conn.name}": ${out.explanation}`
      : `Configured REST API data source "${conn.name}".`);

    // Run the fetch NOW so downstream nodes get a real schema. The API
    // response shape can't be known statically (no getTables/getColumns for a
    // REST source), so we execute the AI-authored function exactly the way the
    // runtime does, materialise the rows into local NeDB, and derive
    // sourceTableSchema + sourceLocalPath from the result. Without this,
    // transformer/join steps that read this source have no columns to plan
    // against. Failures are non-fatal: the node is still saved and re-fetches
    // at execution time, but downstream schema will be missing until then.
    if (out.action === 'create_plan' && out.code) {
      try {
        const fetchResult = await handleExecuteApiFetch({
          apiConnectionId: conn.id || conn._id,
          apiConnectionConfig: config.apiConnectionPublicConfig,
          apiFetchCode: out.code,
          nedbCollection: apiCollection,
          operationMode: 'new_table',
        });
        if (fetchResult?.success) {
          config.sourceLocalPath = fetchResult.localPath || null;
          config.sourceTableSchema = await loadApiSchemaSample(
            apiCollection, fetchResult.localPath, fetchResult.sampleRow, helpers, warnings,
          );
          config.apiFetchResult = {
            rowCount: fetchResult.rowCount || 0,
            localPath: fetchResult.localPath || null,
            collection: fetchResult.collection || apiCollection,
          };
          pushBotMsg(chat, `Fetched ${fetchResult.rowCount || 0} row${fetchResult.rowCount === 1 ? '' : 's'} from API "${conn.name}" into "${apiCollection}" (${config.sourceTableSchema.columns.length} columns detected).`);
        } else {
          warnings.push(`REST API fetch for "${conn.name}" failed: ${fetchResult?.error || 'unknown error'} — downstream nodes will have no schema until this source runs.`);
        }
      } catch (err) {
        warnings.push(`REST API fetch for "${conn.name}" threw: ${err.message} — downstream nodes will have no schema until this source runs.`);
      }
    }

    return config;
  }

  // Branch 2 — Cloud storage. The interactive UI uses a native picker; the
  // builder can't open one. Surface a warning and stop short of inventing a
  // path so the user can finish the node manually.
  if ((conn.dbCategory || '').toLowerCase() === 'cloudstorage') {
    warnings.push(`Cloud storage source "${conn.name}" needs an object path the AI cannot pick automatically — open the node in the editor to choose a file.`);
    pushBotMsg(chat, `Configured cloud-storage data source "${conn.name}" — please open the node in the editor to pick the object path.`);
    return config;
  }

  // Branch 3 — LanceDB file connection. Tables come directly from fileInfo.
  if (conn.dbType === 'lancedb' && (conn.connectionType || 'file') === 'file') {
    const tableList = (conn.fileInfo?.tables || []).map((t) => (typeof t === 'string' ? { name: t } : t));
    const picked = await pickTable(stepPrompt, tableList, helpers, warnings);
    Object.assign(config, {
      sourceConnectionType: 'file',
      sourceDataset: conn.name,
      sourceLocalPath: conn.fileInfo?.filePath || null,
      sourceSelectedTables: [picked.name],
      sourceIndexName: picked.name,
      sourceTableName: picked.name,
      sourceNamespace: '',
      sourceTableSchema: await loadSchemaSample(conn, picked.name, null, helpers, warnings),
    });
    pushBotMsg(chat, `Configured LanceDB data source "${conn.name}" → table "${picked.name}".`);
    return config;
  }

  // Branch 4 — Live database (incl. local SQLite/NeDB files). Real getTables call.
  const isDatabaseLike = conn.connectionType === 'database' || conn.dbType === 'sqlite' || conn.dbType === 'nedb';
  if (isDatabaseLike) {
    const tables = await helpers.getTables(conn);
    if (!tables.length) {
      warnings.push(`Connection "${conn.name}" returned no tables.`);
      pushBotMsg(chat, `Connection "${conn.name}" has no tables — please open the node in the editor.`);
      return config;
    }
    const picked = await pickTable(stepPrompt, tables, helpers, warnings);
    const isNoSQL = conn.dbType === 'mongodb' || conn.dbType === 'nedb';
    const isVector = conn.dbCategory === 'Vector' || conn.dbType === 'pinecone' || conn.dbType === 'lancedb';
    const schema = await loadSchemaSample(conn, picked.name, picked.schema, helpers, warnings);

    Object.assign(config, {
      sourceSelectedTables: [picked.name],
      sourceTable: picked.name,
      sourceTableSchema: schema,
    });

    if (isVector) {
      config.sourceIndexName = picked.name;
      config.sourceTableName = picked.name;
      config.sourceNamespace = picked.namespace || '';
      config.sourceSchema = config.sourceNamespace;
    } else if (isNoSQL) {
      config.sourceCollection = picked.name;
      config.sourceSql = nosqlPreviewQuery(picked.name);
      config.sourcePreviewSql = nosqlPreviewQuery(picked.name);
      config.sourceSqlExplanation = `Selecting all columns from ${picked.schema ? picked.schema + '.' : ''}${picked.name}`;
      config.sourceQueryDescription = `Preview data from ${picked.name}`;
    } else {
      config.sourceTableName = picked.name;
      config.sourceSchema = picked.schema || conn.dbConfig?.schema || null;
      config.sourceSql = sqlPreviewQuery(picked.name, config.sourceSchema, conn.dbType, helpers);
      config.sourcePreviewSql = config.sourceSql;
      config.sourceSqlExplanation = `Selecting all columns from ${config.sourceSchema ? config.sourceSchema + '.' : ''}${picked.name}`;
      config.sourceQueryDescription = `Preview data from ${picked.name}`;
    }

    // Local file paths
    if (conn.connectionType === 'file' && conn.fileInfo?.filePath) {
      config.sourceLocalPath = conn.fileInfo.filePath;
    }
    pushBotMsg(chat, `Configured data source "${conn.name}" (${conn.dbType}) → ${config.sourceSchema ? config.sourceSchema + '.' : ''}${picked.name}.`);
    return config;
  }

  // Branch 5 — Imported file connections (CSV / Excel / JSON / Parquet / Avro).
  // The file is already loaded under a known collection/table on import.
  if ((conn.connectionType || '') === 'file') {
    config.sourceDataset = conn.name;
    config.sourceLocalPath = conn.fileInfo?.filePath || null;
    const single = conn.fileInfo?.tables?.[0] || conn.fileInfo?.collection || conn.name;
    if (single) {
      const name = typeof single === 'string' ? single : (single.name || conn.name);
      config.sourceSelectedTables = [name];
      if (conn.dbType === 'sqlite') config.sourceTableName = name;
      else if (conn.dbType === 'nedb') config.sourceCollection = name;
      try { config.sourceTableSchema = await loadSchemaSample(conn, name, null, helpers, warnings); }
      catch (_) { /* schema is best-effort for imported files */ }
    }
    pushBotMsg(chat, `Configured imported-file data source "${conn.name}" (${conn.dbType}).`);
    return config;
  }

  warnings.push(`Connection "${conn.name}" (type=${conn.connectionType}, dbType=${conn.dbType}) is not handled by the workflow builder; open the node in the editor to finish configuration.`);
  pushBotMsg(chat, `Connection "${conn.name}" (${conn.dbType}) isn't auto-configurable — please open the node in the editor to finish setup.`);
  return config;
}

function sanitizeCollectionName(s) {
  const base = String(s || 'api_fetch').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'api_fetch';
}

// ---------------------------------------------------------------------------
// Transformer — uses CHAT_PROMPT_MODULES.transfomer to produce the SQL/NoSQL
// operation. Copies source* from the upstream node's target* (or source*) the
// way TransformerNodeChat.buildConfig does at :1623-1638.
// ---------------------------------------------------------------------------

function copySourceFromUpstream(upstreamNode) {
  const u = upstreamNode?.data?.config || {};
  return {
    sourceNodeId: upstreamNode?.id,
    sourceNodeLabel: upstreamNode?.data?.label,
    sourceConnectionId: u.targetConnectionId || u.sourceConnectionId,
    sourceConnectionName: u.targetConnectionName || u.sourceConnectionName,
    sourceConnectionType: u.targetConnectionType || u.sourceConnectionType,
    sourceDbType: u.targetDbType || u.sourceDbType,
    sourceDbConfig: u.targetDbConfig || u.sourceDbConfig,
    sourceType: u.targetDbType || u.sourceDbType,
    sourceLocalPath: u.targetLocalPath || u.sourceLocalPath,
    sourceTableName: u.targetTableName || u.sourceTableName,
    sourceCollection: u.targetCollection || u.sourceCollection,
    sourceSchema: u.targetSchema || u.sourceSchema,
    sourceTableSchema: u.targetTableSchema || u.sourceTableSchema,
    sourceDataset: u.targetDataset || u.sourceDataset,
    sourcePreviewSql: u.targetPreviewSql || u.sourcePreviewSql,
  };
}

/**
 * Dispatch to the connector plugin's getTransformPrompts() for non-local
 * SQL/NoSQL targets. Mirrors what TransformerNodeChat does via the
 * dbconn:generate-transform-prompt IPC — same arg shape, same prompt
 * source, so the per-dbType prompt definition lives in exactly one place
 * (plugins/connectors/<dbType>/index.js).
 *
 * Returns the rendered prompt string, or null if no plugin/prompt is
 * available for the given dbType+operationMode.
 */
function renderPluginTransformPrompt({
  helpers, dbType, operationMode, settings, sourceTableInfo, settingsContext,
  sourceConnection, sourceTableSchema, targetSchema, targetTableName,
  sourceSchema, sourceFullTableName,
}) {
  const connector = getConnectorPlugin(helpers, dbType);
  if (typeof connector?.getTransformPrompts !== 'function') return null;
  const prompts = connector.getTransformPrompts();
  const promptFn = operationMode === 'in_place' ? prompts.inPlace : prompts.newTable;
  if (typeof promptFn !== 'function') return null;

  // Replicate the schema/table arg normalisation from electron.js's
  // dbconn:generate-transform-prompt handler so the per-plugin prompt
  // function sees the same shape it does in the renderer flow.
  let sourceSchemaClean = operationMode === 'in_place' ? (sourceSchema || targetSchema) : targetSchema;
  if (!sourceSchemaClean) {
    sourceSchemaClean = (targetTableName && String(targetTableName).split('.').length > 1)
      ? String(targetTableName).split('.')[0]
      : null;
  }
  const fullName = operationMode === 'in_place'
    ? (sourceFullTableName || sourceTableSchema?.tableName || targetTableName)
    : (targetSchema ? `${targetSchema}.${targetTableName}` : targetTableName);

  return promptFn(
    settings,
    sourceTableInfo,
    settingsContext,
    sourceConnection || sourceTableSchema,
    sourceSchemaClean,
    fullName,
  );
}

/**
 * Run one round-trip with a skill: buildSkillPrompt → callAI →
 * processSkillResponse. Returns a normalised envelope:
 *   { action, question?, directAnswer?, executionParams?, state, explanation? }
 * where `action ∈ { execute, ask_questions, answer_directly, unrelateSkill }`.
 *
 * Both the per-node builders (transformer/join) and the renderer-driven
 * `chat:skillStep` IPC call this same helper so the skill contract is
 * uniform regardless of where the turn fires from.
 */
async function runSkillTurn(helpers, skillId, { userRequest, currentState = {}, context = {} }) {
  if (!helpers?.pluginManager?.buildSkillPrompt) {
    throw new Error('pluginManager.buildSkillPrompt unavailable; cannot run skill subagent.');
  }
  const operationType = context.operationType || 'sql';
  const params = {
    userRequest,
    currentState,
    helpers,
    operationType,
    // Splat the rest of the context so each skill's buildSkillPrompt
    // sees the same shape the NodeChat panel hands it (sourceConnection,
    // sourceTableSchema, sources, joinSettings, etc.).
    ...context,
  };

  // Backward-compat shim for vector-db-executor. The skills:buildPrompt
  // IPC injects these extras when the renderer calls it; the planner
  // path goes through this helper instead, so we mirror the same shape
  // here. Otherwise vector-db-executor sees apiKeys === undefined and
  // (correctly, given what it sees) reports "no embedding API keys"
  // even when keys are configured.
  if (skillId === 'vector-db-executor') {
    if (helpers.apiKeys) params.apiKeys = helpers.apiKeys;
    params.pluginManager = helpers.pluginManager;
    if (typeof helpers.getFullConfig === 'function') {
      params.getFullConfig = helpers.getFullConfig;
    }
    try {
      params.vectorConnectors = helpers.pluginManager.listConnectors()
        .filter((c) => c.dbCategory === 'Vector')
        .map((c) => ({ id: c.id, name: c.name }));
    } catch (_) { params.vectorConnectors = []; }
  }

  const built = await helpers.pluginManager.buildSkillPrompt(skillId, params);
  // Skills signal a hard-stop (e.g. missing API keys) by returning
  // `context.error === true` with the human-readable reason stuffed into
  // `prompt`. Detect that BEFORE we send the prompt to callAI — otherwise
  // we hand the error text to the model, which dutifully writes a
  // helpful "how to fix it" reply and we end up calling that an
  // ask_questions response. Throw instead so the builder aborts cleanly.
  if (built && built.context && built.context.error === true) {
    const detail = String(built.context.message || built.prompt || 'skill reported an unrecoverable error').trim();
    throw new Error(`Skill "${skillId}" cannot run: ${detail}`);
  }
  let result;
  if (built && built.prompt) {
    const aiResponse = await helpers.callAI(built.prompt, { });
    result = await helpers.pluginManager.processSkillResponse(
      skillId,
      aiResponse,
      operationType,
      currentState,
      helpers.connections || [],
      helpers,
    );
  } else {
    // Pre-resolved flow: skill orchestrated its own AI calls and handed
    // back the final result directly.
    result = built || {};
  }
  const action = result.action || 'execute';
  const executionParams = result.executionParams || result.skillParams || (action === 'execute' ? result : null);
  // Different skills use different field names for the user-facing text:
  //   vector-db-executor returns { action: 'ask_questions', questionsNeeded: {
  //     <field>: "<question text>" } } (and { action: 'answer_directly',
  //     message: ... } with no JSON envelope), other skills return
  //   `directAnswer` / `followUpQuestion`. Normalise so the renderer always
  //   sees populated `question` for ask_questions and `directAnswer` for
  //   answer_directly — otherwise the chat falls back to the generic
  //   "Skill … needs more input." and the real question is lost.
  //
  // questionsNeeded is a { field: questionText } map; values are usually the
  // question string but can be `true` (skill wants the field but gave no
  // prompt), in which case fall back to naming the field.
  const questionFromNeeded = (qn) => {
    if (!qn || typeof qn !== 'object') return null;
    const parts = Object.entries(qn).map(([field, val]) =>
      (typeof val === 'string' && val.trim()) ? val.trim() : `Please provide: ${field}`);
    return parts.length ? parts.join('\n\n') : null;
  };
  const question = result.followUpQuestion || result.question
    || (action === 'ask_questions'
          ? (result.message || questionFromNeeded(result.questionsNeeded))
          : null)
    || null;
  const directAnswer = result.directAnswer
    || (action === 'answer_directly' ? result.message : null)
    || null;
  return {
    action,
    question,
    directAnswer,
    executionParams: executionParams && typeof executionParams === 'object' ? executionParams : null,
    state:           { ...currentState, ...(result.state || {}), ...(executionParams || {}) },
    explanation:     result.explanation || null,
  };
}

/**
 * Skill-result builder for transformer steps. Called by executeBuild
 * when the dispatcher finds `plan.skillResults[stepIndex]` for this
 * node — i.e. the skill subagent has already converged on execution
 * params and we just need to stitch them into the node config. Does
 * NOT call the analyser, the main processor, or the skill itself.
 */
async function applySkillResultTransformer({ stepPrompt, upstreamNode, helpers, nodeId, skillResult, chat }) {
  if (!upstreamNode) throw new Error('Transformer needs an upstream source node.');
  if (!skillResult || !skillResult.executionParams) {
    throw new Error('applySkillResultTransformer requires skillResult.executionParams.');
  }
  const base = { nodeType: 'transformer', ...copySourceFromUpstream(upstreamNode) };
  const dbType  = base.sourceDbType;
  const isNoSQL = dbType === 'mongodb' || dbType === 'nedb';
  const ep = skillResult.executionParams;
  const operationMode    = skillResult.operationMode || ep.operationMode || 'new_table';
  const storageLocation  = skillResult.storageLocation || ep.storageLocation || (base.sourceConnectionType === 'file' ? 'local' : 'database');
  const targetTableName  = skillResult.targetTableName || ep.targetTable || ep.targetTableName || `transformer_${(nodeId || Date.now()).toString().replace(/-/g, '_')}`;
  const transformationSettings = { userRequest: stepPrompt, operationMode, storageLocation, tableName: targetTableName };

  // Vector-skill destination override (mirrors the live skill path in
  // buildTransformerConfig). Without this, the assembler defaults the
  // target to the source connection (e.g. Mongo) and the executor reads
  // the wrong dbType at run time.
  const isVectorSkill = !!(ep.vectorDbType) || skillResult.skillId === 'vector-db-executor';
  let targetConn = null;
  if (isVectorSkill) {
    const vdb = ep.vectorDbType || 'lancedb';
    if (vdb === 'lancedb') {
      targetConn = {
        id: ep.targetConnectionId || 'local-lancedb',
        name: ep.targetConnectionName || 'Local LanceDB',
        type: 'file',
        dbType: 'lancedb',
        config: {},
      };
    } else {
      const conn = (helpers.connections || []).find((c) => (c.id || c._id) === ep.targetConnectionId);
      if (conn) {
        targetConn = {
          id: conn.id || conn._id,
          name: conn.name,
          type: conn.connectionType || 'database',
          dbType: conn.dbType,
          config: conn.dbConfig || {},
        };
      }
    }
  }

  // Non-vector skills that write to a local NeDB collection (javascript-executor
  // with outputType "nedb") must target NeDB — not the source's dbType. Mirrors
  // the live skill path in buildTransformerConfig so a skill that converges via
  // the subagent round-trip lands the same config (local-nedb target + recorded
  // targetLocalPath) as one that resolves inline. Without it, targetConn stays
  // null, the assembler defaults the target to the Mongo source, and the NeDB
  // output is left with no locatable path → "No data found in source table".
  const skillOutputType = String(ep.outputType || '').toLowerCase();
  const isNeDBSkill = !isVectorSkill && skillOutputType === 'nedb';
  if (isNeDBSkill && !targetConn) {
    targetConn = {
      id: ep.targetConnectionId || 'local-nedb',
      name: ep.targetConnectionName || 'Local NeDB',
      type: 'file',
      dbType: 'nedb',
      config: {},
    };
  }
  const skillIsNoSQL = isNeDBSkill ? true : isNoSQL;

  const skillGen = {
    explanation: skillResult.explanation || ep.explanation || `Built via ${skillResult.skillId}.`,
    ddl: ep.ddl || '',
    sql: ep.sql || '',
    insertSql: ep.insertSql || null,
    previewSql: ep.previewSql || null,
    operationType: ep.operationType || (isVectorSkill ? null : (isNeDBSkill ? 'transform' : (isNoSQL ? 'aggregation' : null))),
    nosqlOperation: ep.nosqlOperation || null,
    transformFunction: ep.transformFunction || null,
  };
  return assembleTransformerConfig({
    base, dbType, isNoSQL: skillIsNoSQL, helpers,
    operationMode, storageLocation, targetTableName, targetConn,
    transformationSettings, stepPrompt, chat,
    gen: skillGen,
    skillInfo: {
      skillId:          skillResult.skillId,
      skillExplanation: skillResult.skillExplanation || null,
      executionParams:  ep,
      isVectorSkill,
    },
  });
}

async function buildTransformerConfig({ stepPrompt, upstreamNode, helpers, nodeId, warnings, clarifications = [], chat, bypassSkills = false }) {
  if (!upstreamNode) throw new Error('Transformer needs an upstream source node.');
  const base = { nodeType: 'transformer', ...copySourceFromUpstream(upstreamNode) };

  // Hard prerequisites: the upstream MUST resolve to a real connection.
  // If it doesn't, ask the user rather than emitting a partial config —
  // a half-built transformer can't be saved meaningfully.
  if (!base.sourceConnectionId) {
    const q = `The transformer upstream "${base.sourceNodeLabel || base.sourceNodeId || 'unknown'}" has no resolved connection. Which saved connection should the transformer read from?`;
    const answer = findClarificationAnswer(clarifications, q);
    if (!answer) throw new ClarificationNeeded(q, { nodeId, kind: 'transformer.upstream_connection' });
    pushBotMsg(chat, q);
    pushUserMsg(chat, answer);
    const conn = (helpers.connections || []).find((c) => c.name === answer || (c.id || c._id) === answer);
    if (!conn) {
      const q2 = `I couldn't find a saved connection matching "${answer}". Please give me the exact connection name from your list.`;
      throw new ClarificationNeeded(q2, { nodeId, kind: 'transformer.upstream_connection' });
    }
    base.sourceConnectionId = conn.id || conn._id;
    base.sourceConnectionName = conn.name;
    base.sourceConnectionType = conn.connectionType || 'database';
    base.sourceDbType = conn.dbType;
    base.sourceDbConfig = conn.dbConfig || {};
  }

  // Without a source schema we can't write a sensible transformation prompt —
  // ask the user which table / collection feeds the transformer.
  if (!base.sourceTableSchema || !Array.isArray(base.sourceTableSchema.columns) || base.sourceTableSchema.columns.length === 0) {
    const q = `I don't have schema info for the transformer's source on "${base.sourceConnectionName}". Which table or collection should it transform?`;
    const answer = findClarificationAnswer(clarifications, q);
    if (!answer) throw new ClarificationNeeded(q, { nodeId, kind: 'transformer.source_table' });
    pushBotMsg(chat, q);
    pushUserMsg(chat, answer);
    const conn = (helpers.connections || []).find((c) => (c.id || c._id) === base.sourceConnectionId);
    if (conn) {
      base.sourceTableSchema = await loadSchemaSample(conn, answer, base.sourceSchema || null, helpers, warnings);
      base.sourceTableName = answer;
    }
  }

  const dbType = base.sourceDbType;
  const isNoSQL = dbType === 'mongodb' || dbType === 'nedb';
  const sourceSchemaInfo = describeTableSchema(base.sourceTableSchema);

  // Fetch installed transformer skills so the analyser can route through
  // one of them instead of plain SQL/NoSQL. Mirrors TransformerNodeChat's
  // loadAvailableSkills, called with the same operationType context the
  // chat panel uses (sql vs nosql). `bypassSkills` is honoured for the
  // re-run after the user closes the skill subagent — we want the second
  // pass to take the standard SQL/NoSQL path without the analyser
  // re-selecting the same skill.
  const availableSkills = (() => {
    if (bypassSkills) return [];
    try {
      if (helpers?.pluginManager?.getSkillDescriptions) {
        return helpers.pluginManager.getSkillDescriptions('transformer', {
          operationType: isNoSQL ? 'nosql' : 'sql',
          sourceSchema: base.sourceTableSchema,
        }) || [];
      }
    } catch (_err) {}
    return [];
  })();

  // Stage 1 — decide operationMode + storageLocation + custom table name.
  const analysisPrompt = ChatPrompts.transfomer.transformationRequest(
    stepPrompt,
    sourceSchemaInfo,
    dbType,
    base.sourceConnectionType === 'file',
    availableSkills,
  );
  const analysis = await callJson(helpers, analysisPrompt);

  console.log('buildTransformerConfig+analysis: ', analysis)

  const operationMode = analysis?.inferredSettings?.operationMode || 'new_table';
  const storageLocation = analysis?.inferredSettings?.storageLocation
    || (base.sourceConnectionType === 'file' ? 'local' : 'database');
  const targetTableName = analysis?.tableName || `transformer_${(nodeId || Date.now()).toString().replace(/-/g, '_')}`;
  const transformationSettings = { userRequest: stepPrompt, operationMode, storageLocation, tableName: targetTableName };

  // If the analyser routed this transformer through a skill, run the
  // skill once. Four actions are possible:
  //   execute        — got executable params, assemble the node now.
  //   unrelateSkill  — skill says "not my territory"; fall through to the
  //                    standard SQL/NoSQL path below.
  //   ask_questions  — skill needs more user input; throw
  //                    SkillSubagentRequired so the renderer can drive
  //                    the skill conversation. Subsequent rounds come
  //                    back via plan.skillResults (applySkillResult…
  //                    builder) once the skill finally returns `execute`.
  //   answer_directly — same: surface the answer and wait for the next
  //                    user message via the skill subagent.
  if (analysis?.usesSkill && analysis?.skillId && helpers?.pluginManager?.buildSkillPrompt) {
    const sourceConnection = (helpers.connections || []).find((c) => (c.id || c._id) === base.sourceConnectionId)
      || { id: base.sourceConnectionId, name: base.sourceConnectionName, dbType, connectionType: base.sourceConnectionType };
    const context = {
      kind: 'transformer',
      sourceTableSchema: base.sourceTableSchema,
      sourceConnection,
      dbCategory: dbType,
      operationType: isNoSQL ? 'nosql' : 'sql',
      operationMode,
      storageLocation,
      tableName: targetTableName,
      isSourceLocal: base.sourceConnectionType === 'file',
    };
    const result = await runSkillTurn(helpers, analysis.skillId, {
      userRequest: stepPrompt,
      currentState: analysis?.skillParams || {},
      context,
    });

    if (result.action === 'execute') {
      const ep = result.executionParams || {};
      // Vector skills (vector-db-executor) deliver an entirely different
      // shape than SQL/NoSQL skills — `vectorDbType`, `embeddingProvider`,
      // `columnToEmbed`, `targetLocalPath`, etc. — and write to a vector
      // destination that isn't the source connection. Detect that and
      // override targetConn so the executor reads the correct lancedb /
      // pinecone target instead of falling back to the Mongo source.
      const isVectorSkill = !!(ep.vectorDbType) || analysis.skillId === 'vector-db-executor';
      let targetConn = null;
      let resolvedTargetTableName = ep.targetTable || ep.targetTableName || targetTableName;
      if (isVectorSkill) {
        const vdb = ep.vectorDbType || 'lancedb';
        if (vdb === 'lancedb') {
          targetConn = {
            id: ep.targetConnectionId || 'local-lancedb',
            name: ep.targetConnectionName || 'Local LanceDB',
            type: 'file',
            dbType: 'lancedb',
            config: {},
          };
        } else {
          // Cloud vector DB — skill resolved the connection id for us.
          const conn = (helpers.connections || []).find((c) => (c.id || c._id) === ep.targetConnectionId);
          if (conn) {
            targetConn = {
              id: conn.id || conn._id,
              name: conn.name,
              type: conn.connectionType || 'database',
              dbType: conn.dbType,
              config: conn.dbConfig || {},
            };
          }
        }
      }
      // Non-vector skills that write to a local NeDB collection (e.g.
      // javascript-executor with outputType "nedb") must target NeDB — NOT the
      // source's dbType. Without this, assembleTransformerConfig derives the
      // target from the SQL/SQLite source and emits a SQL preview against a
      // table that only ever exists in NeDB → "no such table" at preview time.
      const skillOutputType = String(ep.outputType || '').toLowerCase();
      const isNeDBSkill = !isVectorSkill && skillOutputType === 'nedb';
      if (isNeDBSkill && !targetConn) {
        targetConn = {
          id: ep.targetConnectionId || 'local-nedb',
          name: ep.targetConnectionName || 'Local NeDB',
          type: 'file',
          dbType: 'nedb',
          config: {},
        };
      }
      // Treat NeDB-output skills as NoSQL so assembleTransformerConfig takes the
      // collection branch (targetCollection + NeDB preview + localNeDBPath)
      // instead of the SQL branch.
      const skillIsNoSQL = isNeDBSkill ? true : isNoSQL;

      // For vector skills don't synthesise a Mongo aggregation operationType
      // (there is no nosqlOperation pipeline to run). The executor's
      // usesSkill branch short-circuits this anyway, but we don't want
      // to write misleading values onto the config. NeDB-output skills need a
      // truthy operationType so the NoSQL config branch is entered (the value
      // itself is cosmetic — execution dispatches via the skill, not a pipeline).
      const skillGen = {
        explanation: result.explanation || ep.explanation || `Built via ${analysis.skillId}.`,
        ddl: ep.ddl || '',
        sql: ep.sql || '',
        insertSql: ep.insertSql || null,
        previewSql: ep.previewSql || null,
        operationType: ep.operationType || (isVectorSkill ? null : (isNeDBSkill ? 'transform' : (isNoSQL ? 'aggregation' : null))),
        nosqlOperation: ep.nosqlOperation || null,
        transformFunction: ep.transformFunction || null,
      };
      return assembleTransformerConfig({
        base, dbType, isNoSQL: skillIsNoSQL, helpers,
        operationMode, storageLocation,
        targetTableName: resolvedTargetTableName,
        targetConn,
        transformationSettings, stepPrompt, chat,
        gen: skillGen,
        skillInfo: {
          skillId:          analysis.skillId,
          skillExplanation: analysis.skillExplanation || null,
          executionParams:  ep,
          isVectorSkill,
        },
      });
    }
    if (result.action === 'ask_questions' || result.action === 'answer_directly') {
      throw new SkillSubagentRequired({
        skillId:     analysis.skillId,
        nodeId,
        question:    result.question,
        directAnswer: result.directAnswer,
        action:      result.action,
        state:       result.state,
        context,
      });
    }
    // unrelateSkill — fall through to the standard SQL/NoSQL flow.
  }

  // Stage 2 — generate the actual SQL / NoSQL operation. Local file targets
  // (NeDB / SQLite) use the ChatPrompts templates because there's no plugin
  // file for them; everything else (Mongo / Postgres / MySQL / Snowflake /
  // MSSQL / BigQuery / …) goes through the plugin's getTransformPrompts so
  // the per-dialect prompt lives in exactly one place.
  const settingsContext = `Operation mode: ${operationMode}\nStorage location: ${storageLocation}\nTarget name: ${targetTableName}`;
  const usesLocalTemplate =
    (dbType === 'nedb') ||
    (dbType === 'sqlite') ||
    (base.sourceConnectionType === 'file');

  let gen;
  if (usesLocalTemplate) {
    const template = dbType === 'nedb' || isNoSQL
      ? (operationMode === 'in_place'
          ? ChatPrompts.transfomer.nedbTransformationInPlace
          : ChatPrompts.transfomer.nedbTransformationNewTable)
      : (operationMode === 'in_place'
          ? ChatPrompts.transfomer.sqliteTransformationInPlace
          : ChatPrompts.transfomer.sqliteTransformationNewTable);
    gen = await callJson(
      helpers,
      template(
        { userRequest: stepPrompt },
        sourceSchemaInfo,
        settingsContext,
        base.sourceTableSchema || { tableName: base.sourceCollection || base.sourceTableName },
        targetTableName,
      ),
    );
    console.log('buildTransformerConfig+gen: ', gen)
  } else {
    const targetSchema = storageLocation === 'local'
      ? null
      : (base.sourceSchema || base.sourceDbConfig?.schema || null);
    const sourceConnectionForPrompt = {
      dbType,
      name: base.sourceConnectionName,
      connectionType: base.sourceConnectionType,
      dbConfig: base.sourceDbConfig,
    };
    const sourceFullTableName = base.sourceSchema
      ? `${base.sourceSchema}.${base.sourceTableName || base.sourceTableSchema?.tableName || ''}`
      : (base.sourceTableName || base.sourceTableSchema?.tableName || '');
    const pluginPrompt = renderPluginTransformPrompt({
      helpers, dbType, operationMode,
      settings: transformationSettings,
      sourceTableInfo: sourceSchemaInfo,
      settingsContext,
      sourceConnection: sourceConnectionForPrompt,
      sourceTableSchema: base.sourceTableSchema,
      targetSchema,
      targetTableName,
      sourceSchema: base.sourceSchema,
      sourceFullTableName,
    });
    if (!pluginPrompt) {
      throw new Error(`No transform prompt available for dbType="${dbType}". Plugin must export getTransformPrompts().`);
    }
    gen = await callJson(helpers, pluginPrompt);

    console.log('buildTransformerConfig+gen: ', gen)
  }

  return assembleTransformerConfig({
    base, dbType, isNoSQL, helpers,
    operationMode, storageLocation, targetTableName, targetConn: null,
    transformationSettings, stepPrompt, chat, gen, skillInfo: null,
  });
}

// Final assembly of the transformer node config, shared by the standard
// SQL/NoSQL generation path AND the skill-routed path so both wind up with
// an identical config shape downstream. `gen` is the operation envelope
// (sql/ddl/nosqlOperation/transformFunction); `skillInfo` is set when the
// transformer was built by a skill.
function assembleTransformerConfig({
  base, dbType, isNoSQL, helpers,
  operationMode, storageLocation, targetTableName, targetConn,
  transformationSettings, stepPrompt, chat, gen, skillInfo,
}) {
  if (!targetConn) {
    const isInPlace = operationMode === 'in_place';
    const isLocal = storageLocation === 'local';
    if (isInPlace) targetConn = { id: base.sourceConnectionId, name: base.sourceConnectionName, type: base.sourceConnectionType, dbType, config: base.sourceDbConfig };
    else if (isLocal) {
      const localDb = isNoSQL ? 'nedb' : 'sqlite';
      targetConn = { id: `local-${localDb}`, name: localDb === 'nedb' ? 'Local NeDB' : 'Local SQLite', type: 'file', dbType: localDb, config: {} };
    } else targetConn = { id: base.sourceConnectionId, name: base.sourceConnectionName, type: base.sourceConnectionType, dbType, config: base.sourceDbConfig };
  }

  const config = {
    ...base,
    transformationRequest: stepPrompt,
    transformationSettings,
    targetSqlExplanation: gen?.explanation || '',
    targetConnectionId: targetConn.id,
    targetConnectionName: targetConn.name,
    targetConnectionType: targetConn.type,
    targetDbType: targetConn.dbType,
    targetDbConfig: targetConn.config,
  };

  if (skillInfo) {
    config.skillId   = skillInfo.skillId;
    // The executor (workflowExecutionHelpers.js) gates skill dispatch on
    // `config.usesSkill && config.skillId` — without this flag it falls
    // back to the standard SQL/NoSQL transform path and crashes on the
    // empty nosqlOperation / sql fields.
    config.usesSkill = true;
    if (skillInfo.skillExplanation) config.skillExplanation = skillInfo.skillExplanation;

    // Carry the skill's raw execution params through so the runtime
    // executeSkill call sees them. The executor spreads
    // `...config.skillParams` last (highest precedence), then reads
    // specific top-level fields by name — so we ALSO hoist the most
    // commonly referenced ones to top-level.
    const ep = skillInfo.executionParams || {};
    if (ep && typeof ep === 'object') {
      config.skillParams = ep;
      if (ep.vectorDbType)             config.targetDbType    = ep.vectorDbType;
      if (ep.embeddingProvider)        config.embeddingProvider = ep.embeddingProvider;
      if (ep.embeddingModel)           config.embeddingModel    = ep.embeddingModel;
      if (ep.embeddingApiKey)          config.embeddingApiKey   = ep.embeddingApiKey;
      if (ep.columnToEmbed)            config.columnToEmbed     = ep.columnToEmbed;
      if (ep.targetLocalPath)          config.targetLocalPath   = ep.targetLocalPath;
      if (ep.namespace)                config.namespace         = ep.namespace;
      if (ep.indexName)                config.indexName         = ep.indexName;
      if (ep.useEmbeddingSearch != null) config.useEmbeddingSearch = ep.useEmbeddingSearch;
      if (ep.searchQuery)              config.searchQuery       = ep.searchQuery;
      if (ep.filter != null)           config.filter            = ep.filter;
      if (ep.transformFunction)        config.transformFunction = ep.transformFunction;
      if (ep.initialState)             config.initialState      = ep.initialState;
      if (ep.pineconeConfig)           config.pineconeConfig    = ep.pineconeConfig;
      if (ep.lancedbConfig)            config.lancedbConfig     = ep.lancedbConfig;
      if (ep.operation || ep.vectorDbType) {
        config.skillExecution = {
          ...(config.skillExecution || {}),
          ...(ep.operation     ? { operation:     ep.operation     } : {}),
          ...(ep.vectorDbType  ? { vectorDbType:  ep.vectorDbType  } : {}),
        };
      }
    }
  }

  if (isNoSQL && gen?.operationType) {
    config.operationType = gen.operationType;
    config.nosqlOperation = gen.nosqlOperation;
    config.transformFunction = gen.transformFunction || null;
    config.targetCollection = operationMode === 'in_place'
      ? (base.sourceCollection || base.sourceTableName)
      : targetTableName;
    config.targetPreviewSql = nosqlPreviewQuery(config.targetCollection);
    // Record targetLocalPath whenever the *resolved target* is NeDB — not just
    // when the user asked for local storage or the source is NeDB. A NeDB-output
    // skill (e.g. javascript-executor with outputType "nedb") can force a
    // `local-nedb` target even when storageLocation is "database" and the source
    // is a remote DB like MongoDB; config.targetDbType (== targetConn.dbType) is
    // already 'nedb' here. Without consulting it, the data lands in a local NeDB
    // file the config has no pointer to, and downstream nodes/previews that
    // inherit sourceLocalPath from this target get nothing → "No data found in
    // source table".
    if (storageLocation === 'local' || dbType === 'nedb' || config.targetDbType === 'nedb') {
      // "Modify locally" (in-place) keeps the data in the source's own file, so
      // inherit its path. A new local collection is written to a fresh
      // per-collection NeDB file by saveToLocalNeDB (or the NeDB-output skill,
      // which honors this explicit path); record that deterministic path so
      // downstream nodes and previews can locate it (the source may be a
      // remote DB like MongoDB with no local path to inherit).
      config.targetLocalPath = operationMode === 'in_place'
        ? (base.sourceLocalPath || null)
        : localNeDBPath(config.targetCollection);
    }
  } else {
    config.targetDdl = gen?.ddl || '';
    config.targetSql = gen?.sql || '';
    config.targetInsertSql = gen?.insertSql || null;
    config.targetSchema = storageLocation === 'local' ? null : (base.sourceSchema || base.sourceDbConfig?.schema || null);
    config.targetTableName = operationMode === 'in_place'
      ? (base.sourceTableName || base.sourceTableSchema?.tableName)
      : targetTableName;
    config.targetPreviewSql = gen?.previewSql
      || sqlPreviewQuery(config.targetTableName, config.targetSchema, targetConn.dbType, helpers);
    // Local SQL storage materializes the result table in the shared SQLite
    // workspace (userData/app-data.db, == appSqliteDbPath). Prefer a path
    // inherited from the source; otherwise fall back to the default workspace so
    // downstream nodes / previews can still locate the table even when the source
    // is a remote DB (e.g. MSSQL) with no local path to inherit.
    if (storageLocation === 'local') config.targetLocalPath = base.sourceLocalPath || defaultLocalSqlitePath() || null;
  }

  // Vector targets (LanceDB) address a *directory*, not a per-collection NeDB
  // file. Inheriting the source NeDB path here makes LanceDB try to create a
  // table inside a file at run time ("Not a directory"). Honor an explicit path
  // from the skill's execution params; otherwise use the same default LanceDB
  // directory the skill resolves to, and mirror it into targetDbConfig so the
  // node matches a manually-built vector node (dbPath + tableName).
  if (skillInfo?.isVectorSkill && targetConn?.dbType === 'lancedb') {
    const ep = skillInfo.executionParams || {};
    const lancedbPath = ep.targetLocalPath || ep.dbPath || ep.lancedbPath || defaultLanceDBPath();
    config.targetLocalPath = lancedbPath;
    config.targetDbConfig = {
      ...(config.targetDbConfig || {}),
      ...(lancedbPath ? { dbPath: lancedbPath } : {}),
      tableName: config.targetTableName || config.targetCollection || targetTableName,
    };
  }

  config.targetTableSchema = config.targetTableSchema || {
    tableName: config.targetCollection || config.targetTableName,
    columns: (base.sourceTableSchema?.columns || []).map((c) => ({ name: c.name, type: c.type || 'unknown' })),
    sampleData: [],
  };

  const opSummary = isNoSQL
    ? `Operation: ${gen?.operationType || 'aggregation'}`
    : `Mode: ${operationMode === 'in_place' ? 'In-place' : 'New table'}`;
  const explanationText = gen?.explanation
    || `Built ${operationMode === 'in_place' ? 'in-place' : 'new-table'} transformer "${targetTableName}" on ${targetConn.name} (${targetConn.dbType}).`;
  const transformerMetadata = isNoSQL
    ? { operationType: gen?.operationType || null, nosqlOperation: gen?.nosqlOperation || null, transformFunction: gen?.transformFunction || null }
    : { ddl: gen?.ddl || null, sql: gen?.sql || null, insertSql: gen?.insertSql || null, previewSql: gen?.previewSql || null };
  const skillBanner = skillInfo ? ` via skill "${skillInfo.skillId}"` : '';
  pushBotMsg(
    chat,
    `✓ ${isNoSQL ? 'NoSQL' : 'SQL'} Transformation generated${skillBanner}!\n\n${explanationText}\n\n${opSummary}\nSettings:\n• Mode: ${operationMode === 'in_place' ? 'In-Place' : 'New Table'}\n• Storage Location: ${storageLocation === 'local' ? 'Local file' : 'Database'}`,
    { metadata: transformerMetadata },
  );

  return config;
}

function describeTableSchema(schema) {
  if (!schema) return '(schema unavailable)';
  const cols = (schema.columns || []).map((c) => `${c.name}: ${c.type || 'unknown'}`).join(', ');
  const sample = JSON.stringify((schema.sampleData || []).slice(0, 3), null, 2);
  return `Table: ${schema.tableName}\nColumns: ${cols}\nSample rows: ${sample}`;
}

// ---------------------------------------------------------------------------
// Join — multi-source. Two-pass: joinAnalysisRequest decides relationships,
// then generateJoinQuery produces the join SQL / JS function.
// ---------------------------------------------------------------------------

// Vector DB types — kept identical to JoinNodeChat.js (VECTOR_DB_TYPES) so the
// interactive and headless join builders detect vector sources / destinations
// the same way.
const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

// Resolve one upstream node into the join's source descriptor. A join reads an
// upstream's OUTPUT, and where that lives depends on the node TYPE:
//   - dataSource  → the table/collection it READ          (source* fields)
//   - transformer / join → the table/collection it WROTE  (target* fields)
// An in-place transformer has no target (it mutated its source in place), so we
// fall back to source* for it. Using target* blindly for a dataSource would
// pick up nothing; using source* blindly for a transformer would point the join
// at the transformer's INPUT table instead of the embedded/derived output — the
// bug that left a vector self-join reading the wrong (or no) table.
function resolveJoinSource(n) {
  const cfg = n?.data?.config || {};
  const isDataSourceNode = n?.type === 'dataSource' || cfg.nodeType === 'datasource';
  const pick = (sourceVal, targetVal) => (isDataSourceNode ? sourceVal : (targetVal || sourceVal));
  return {
    sourceNodeId: n.id,
    sourceNodeLabel: n?.data?.label,
    sourceNodeType: n?.type,
    sourceConnectionId: cfg.targetConnectionId || cfg.sourceConnectionId,
    sourceConnectionName: cfg.targetConnectionName || cfg.sourceConnectionName,
    sourceConnectionType: cfg.targetConnectionType || cfg.sourceConnectionType,
    sourceDbType: cfg.targetDbType || cfg.sourceDbType,
    sourceTableSchema: pick(cfg.sourceTableSchema, cfg.targetTableSchema),
    sourceTableName:   pick(cfg.sourceTableName,   cfg.targetTableName),
    sourceCollection:  pick(cfg.sourceCollection,  cfg.targetCollection),
    sourceLocalPath: cfg.targetLocalPath || cfg.sourceLocalPath,
  };
}

async function buildJoinConfig({ stepPrompt, upstreamNodes, helpers, nodeId, warnings, clarifications = [], chat, connectionId = null, bypassSkills = false }) {
  if (!upstreamNodes || upstreamNodes.length < 2) throw new Error('Join needs at least 2 upstream source nodes.');

  const sources = upstreamNodes.map((n) => resolveJoinSource(n));

  // Sources missing schema info → ask before running the analyser. Join keys
  // are derived from columns, so analysing without them yields hallucinated
  // join conditions.
  const schemaless = sources.filter((s) => !s.sourceTableSchema || !Array.isArray(s.sourceTableSchema.columns) || s.sourceTableSchema.columns.length === 0);
  if (schemaless.length) {
    const names = schemaless.map((s) => s.sourceNodeLabel || s.sourceNodeId).join(', ');
    const q = `I don't have column information for the following join source(s): ${names}. Can you tell me the key column(s) each source contributes to the join (e.g. "orders.user_id = users.id")?`;
    const answer = findClarificationAnswer(clarifications, q);
    if (!answer) throw new ClarificationNeeded(q, { nodeId, kind: 'join.source_keys' });
    pushBotMsg(chat, q);
    pushUserMsg(chat, answer);
    // The answer becomes part of the step prompt so the analyser sees it.
    stepPrompt = `${stepPrompt}\n\nUser-provided join keys: ${answer}`;
  }

  // Fold any prior builder Q&A into the prompt so the analyser sees the user's
  // answers. executeBuild restarts the whole build from scratch each time a
  // clarification is answered, so without this the re-run's analyser wouldn't
  // know what was already asked/answered and would re-ask the same question.
  // (JoinNodeChat passes the chat history to the analyser for the same reason.)
  for (const c of clarifications) {
    if (c && c.question && c.answer) {
      stepPrompt = `${stepPrompt}\n\nEarlier you asked: "${String(c.question).trim()}"\nThe user answered: "${String(c.answer).trim()}"`;
    }
  }

  const sourcesInfo = sources.map((s, i) => `Source ${i + 1} (${s.sourceNodeLabel || s.sourceNodeId}):\n${describeTableSchema(s.sourceTableSchema)}`).join('\n\n');
  const destinationCandidates = (helpers.connections || []).map((c) => `- ${c.id || c._id}: ${c.name} (${c.dbType}, ${c.connectionType || 'file'})`).join('\n') || '(none)';

  // Fetch installed join skills (minus vector-db-executor, which is the
  // single-source variant — JoinNodeChat hides it for the same reason).
  // bypassSkills disables the skill route for the re-run after a user
  // closes the skill subagent.
  const hasVectorSource = sources.some((s) => {
    const srcConn = (helpers.connections || []).find((c) => (c.id || c._id) === s.sourceConnectionId);
    return srcConn?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(s.sourceDbType);
  });
  const availableJoinSkills = (() => {
    if (bypassSkills) return [];
    try {
      if (helpers?.pluginManager?.getSkillDescriptions) {
        const operationType = sources.some((s) => s.sourceDbType === 'mongodb' || s.sourceDbType === 'nedb') ? 'nosql' : 'sql';
        return (helpers.pluginManager.getSkillDescriptions('join', {
          operationType,
          sourceSchemas: sources.map((s) => s.sourceTableSchema),
        }) || []).filter((s) => s.id !== 'vector-db-executor');
      }
    } catch (_err) {}
    return [];
  })();

  const analysisPrompt = ChatPrompts.join.joinAnalysisRequest(
    stepPrompt,
    sourcesInfo,
    destinationCandidates,
    'new_table',
    availableJoinSkills,
    {
      hasVectorSource,
      hasVectorDestination: false,
    },
  );
  const analysis = await callJson(helpers, analysisPrompt);
  console.log('buildJoinConfig+analysis: ', analysis)

  // Mirror JoinNodeChat.analyzeJoinRequest exactly. Vector source/destination
  // joins are handled INLINE by generateJoinQuery, not by the vector-db-executor
  // skill — its buildSkillPrompt is built for single-source transformer flows and
  // produces a garbled prompt when fed multi-source join params. Route those
  // cases through the standard generate path instead.
  if (analysis?.usesSkill && analysis?.skillId === 'vector-db-executor') {
    analysis.usesSkill = false;
    analysis.skillId = null;
    if (analysis.action !== 'ask_questions' && analysis.action !== 'answer_directly') {
      analysis.action = 'generate_join';
    }
  }

  const inferred = analysis?.inferredSettings || {};
  // The analyser is the single authority for whether this join needs
  // embedding/similarity-search code (Scenario B). Persist its verdict so the
  // generation prompt below gates the vector path — same as JoinNodeChat.
  inferred.vectorRequired = analysis?.vectorRequired === true;

  // Honor the analyser's OWN decision instead of forcing a relational
  // "join keys" question. A vector similarity self-join has no join-key
  // columns, so the old `inferred.joinColumns` gate always misfired on it and
  // asked an irrelevant question while discarding the analyser's real
  // followUpQuestion (e.g. which embedding model to use). JoinNodeChat branches
  // purely on analysis.action; the headless builder now does the same.
  if (analysis?.action === 'ask_questions' || analysis?.action === 'answer_directly') {
    const q = String(
      analysis.followUpQuestion
      || analysis.directAnswer
      || 'Can you provide more details about how you want to join these sources?',
    ).trim();
    const answer = findClarificationAnswer(clarifications, q);
    // First time we hit this question → pause the build and ask the user.
    // On the re-run the answer is already folded into stepPrompt above, so the
    // analyser should return generate_join; if it stubbornly re-asks the same
    // question we already have the answer and simply fall through to generation.
    if (!answer) throw new ClarificationNeeded(q, { nodeId, kind: 'join.analysis' });
    pushBotMsg(chat, q);
    pushUserMsg(chat, answer);
  }

  // Planner-declared destination wins — skip the clarification round-trip
  // entirely when the top-level planner already picked a connection id or
  // a local-* token. The analyser may have guessed a different value;
  // overwriting is fine because the planner is authoritative.
  if (connectionId) {
    inferred.destinationSelection = connectionId;
  }

  // Ask for the destination only when neither the planner nor the analyser
  // picked one (legacy plans without connectionId on join).
  if (!inferred.destinationSelection) {
    const q = `Where should the join result be written? Reply with a saved connection name, "local-sqlite", "local-nedb", or "local-lancedb" (a local vector table).`;
    const answer = findClarificationAnswer(clarifications, q);
    if (!answer) throw new ClarificationNeeded(q, { nodeId, kind: 'join.destination' });
    pushBotMsg(chat, q);
    pushUserMsg(chat, answer);
    inferred.destinationSelection = answer.trim();
  }

  // Resolve the destination connection (AI may return id, name, or local-* token).
  // Mirror JoinNodeChat: a local-* destination has NO saved connection — it lands
  // in the local SQLite/NeDB workspace — so targetConn is null and the
  // destination's dbType / id come from the token (exactly like JoinNodeChat's
  // local placeholder, and applySkillResultJoin below). resolveTargetConnection
  // returns a fallback SOURCE connection for local tokens, which would wrongly
  // mark every source as "already in the destination", so skip it for local.
  const isLocalStorage = String(inferred.destinationSelection || '').startsWith('local-');
  const targetConn = isLocalStorage
    ? null
    : resolveTargetConnection(inferred.destinationSelection, helpers.connections, sources[0]);
  // The next four derivations are kept 1:1 with JoinNodeChat.js (generateJoin).
  const targetDbType = targetConn?.dbType
    || (isLocalStorage ? inferred.destinationSelection.replace('local-', '') : 'sqlite');
  const isNoSQL = targetDbType === 'mongodb' || targetDbType === 'nedb';
  const isVectorDestination = targetConn?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(targetDbType);
  const destinationConnectionId = targetConn?.id || targetConn?._id || inferred.destinationSelection;
  const targetTableName = inferred.targetTableName || `join_${(nodeId || Date.now()).toString().replace(/-/g, '_')}`;

  const joinSettings = {
    userRequest: stepPrompt,
    operationMode: inferred.operationMode || 'new_table',
    destinationSelection: inferred.destinationSelection || (targetConn?.id || targetConn?._id) || 'local-sqlite',
    targetTableName,
    joinType: inferred.joinType || 'INNER',
    joinColumns: inferred.joinColumns || [],
    selectedColumns: inferred.selectedColumns || {},
  };

  // Skill-routed join: same four-action contract as the transformer
  // skill branch above. `execute` builds the node now; `unrelateSkill`
  // falls through to the standard generateJoinQuery path;
  // `ask_questions` / `answer_directly` throw SkillSubagentRequired so
  // the renderer can drive the skill conversation.
  let gen = null;
  if (analysis?.usesSkill && analysis?.skillId && helpers?.pluginManager?.buildSkillPrompt) {
    const context = {
      kind: 'join',
      sources,
      joinSettings,
      targetConnection: targetConn,
      operationType: isNoSQL ? 'nosql' : 'sql',
      isInsideJoinFlow: true,
    };
    const result = await runSkillTurn(helpers, analysis.skillId, {
      userRequest: stepPrompt,
      currentState: analysis?.skillParams || {},
      context,
    });

    if (result.action === 'execute') {
      const ep = result.executionParams || {};
      gen = {
        explanation:       result.explanation || ep.explanation || `Built via ${analysis.skillId}.`,
        joinColumns:       ep.joinColumns || joinSettings.joinColumns,
        sourcesConfig:     ep.sourcesConfig || [],
        joinSql:           ep.joinSql || null,
        targetDdl:         ep.targetDdl || '',
        javascriptFunction: ep.javascriptFunction || null,
        transformFunction:  ep.transformFunction || null,
        previewSql:        ep.previewSql || null,
        vectorDestination: ep.vectorDestination || null,
        _skillId:          analysis.skillId,
        _skillExplanation: analysis.skillExplanation || null,
      };
    } else if (result.action === 'ask_questions' || result.action === 'answer_directly') {
      throw new SkillSubagentRequired({
        skillId:     analysis.skillId,
        nodeId,
        question:    result.question,
        directAnswer: result.directAnswer,
        action:      result.action,
        state:       result.state,
        context,
      });
    }
    // unrelateSkill — gen stays null, fall through to generateJoinQuery.
  }

  // Standard SQL/JS join generation when no skill was selected.
  if (!gen) {
    // generateJoinQuery expects the richer per-source shape that the interactive
    // JoinNodeChat builds (tableName / columns / dbType / isInDestinationDb /
    // isSourceVector / requiredFields). Our `sources` array uses the saved-config
    // shape, so derive the prompt shape here — mirroring JoinNodeChat's
    // sourcesInfo exactly — otherwise the prompt template dereferences undefined
    // fields (e.g. src.requiredFields.length). isVectorDestination / isNoSQL /
    // destinationConnectionId are computed once above, same as JoinNodeChat.
    const sourcesForPrompt = sources.map((s) => {
      const sourceDbType = s.sourceDbType;
      const srcConn = (helpers.connections || []).find((c) => (c.id || c._id) === s.sourceConnectionId);
      const isSourceNoSQL = sourceDbType === 'mongodb' || sourceDbType === 'nedb';
      const isSourceVector = srcConn?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(sourceDbType);
      const isInDestinationDb = s.sourceConnectionId === destinationConnectionId;

      // Determine what fields are needed for this source (mirrors JoinNodeChat).
      let requiredFields = [];
      if (isVectorDestination) {
        if (isSourceVector) requiredFields = ['vectorFetchOperation'];
        else if (isSourceNoSQL) requiredFields = ['nosqlOperation'];
        else requiredFields = ['sql'];
      } else if (isNoSQL) {
        if (isSourceVector) requiredFields = ['vectorFetchOperation'];
        else if (isSourceNoSQL) requiredFields = ['nosqlOperation'];
        else requiredFields = ['sql'];
      } else {
        if (isSourceVector) requiredFields = ['tempTableName', 'ddl', 'vectorFetchOperation', 'insertSql'];
        else if (isSourceNoSQL) requiredFields = ['tempTableName', 'ddl', 'nosqlOperation', 'insertSql'];
        else if (isInDestinationDb) requiredFields = [];
        else requiredFields = ['tempTableName', 'ddl', 'sql', 'insertSql'];
      }

      return {
        sourceNodeId: s.sourceNodeId,
        sourceNodeLabel: s.sourceNodeLabel,
        tableName: s.sourceTableName || s.sourceCollection || s.sourceTableSchema?.tableName || null,
        columns: s.sourceTableSchema?.columns || [],
        sampleData: s.sourceTableSchema?.sampleData || [],
        connectionId: s.sourceConnectionId,
        dbType: sourceDbType,
        connectionType: s.sourceConnectionType,
        localPath: s.sourceLocalPath || null,
        isInDestinationDb,
        isSourceVector,
        requiredFields,
      };
    });

    // hasLocalConnection mirrors JoinNodeChat: any source with a local path, or a
    // destination whose dbType is a local file format (nedb / sqlite / lancedb).
    const LOCAL_DB_TYPES_FOR_PROMPT = new Set(['nedb', 'sqlite', 'lancedb']);
    const genPrompt = ChatPrompts.join.generateJoinQuery(
      targetDbType,
      sourcesForPrompt,
      joinSettings,
      {
        tableName: targetTableName,
        isVectorDestination,
        vectorRequired: !!analysis?.vectorRequired,
        hasLocalConnection: sourcesForPrompt.some((s) => s.localPath) || LOCAL_DB_TYPES_FOR_PROMPT.has(targetDbType),
      },
    );
    gen = await callJson(helpers, genPrompt);
  }
  console.log('buildJoinConfig+gen: ', gen)

  // Enrich each sourcesConfig entry with its resolved source connection AND
  // table name (see enrichJoinSourcesConfig). Without it the executor can't
  // open the source — a vector source in particular throws "no tableName".
  if (gen && Array.isArray(gen.sourcesConfig)) {
    gen.sourcesConfig = enrichJoinSourcesConfig(gen.sourcesConfig, sources, helpers);
  }

  return assembleJoinConfig({
    sources, stepPrompt, joinSettings, gen, warnings, chat,
    targetConn, isNoSQL, isLocalStorage, targetTableName, helpers,
  });
}

// Attach the resolved source connection AND the source table name to every
// sourcesConfig entry. The executor (NodeExecution.pullJoinSourceRows) opens a
// source via sourceConfig.connection, and for a VECTOR source it needs the
// table name — which it reads from sourceTableSchema.tableName / tableName /
// connection.dbConfig.tableName. A LanceDB source wired through a local-* token
// has no saved connection (conn is undefined) and the AI's generated
// sourcesConfig only carries a vectorFetchOperation, so without this the loader
// throws "no tableName/indexName found on sourceConfig or connection.dbConfig".
// Mirrors the per-source shape the interactive JoinNodeChat persists.
function enrichJoinSourcesConfig(sourcesConfig, sources, helpers) {
  if (!Array.isArray(sourcesConfig)) return sourcesConfig;
  return sourcesConfig.map((sc) => {
    if (!sc) return sc;
    const src = sources.find((s) => s.sourceNodeId === sc.sourceNodeId);
    if (!src) return sc;
    const conn = (helpers.connections || []).find((c) => (c.id || c._id) === src.sourceConnectionId);
    const tableName = sc.tableName
      || src.sourceTableName
      || src.sourceCollection
      || src.sourceTableSchema?.tableName
      || null;
    return {
      ...sc,
      tableName,
      sourceTableSchema: sc.sourceTableSchema || src.sourceTableSchema || (tableName ? { tableName } : null),
      connection: {
        id: src.sourceConnectionId,
        dbType: src.sourceDbType,
        // Fold the table name into dbConfig too — for a local-lancedb source
        // there is no saved connection, so the executor's
        // connection.dbConfig.tableName fallback would otherwise be empty.
        dbConfig: { ...(conn?.dbConfig || {}), ...(tableName ? { tableName } : {}) },
        fileInfo: conn?.fileInfo,
        localPath: conn?.localPath || src.sourceLocalPath || null,
      },
    };
  });
}

// Final assembly of the join node config, shared by the standard
// generateJoinQuery path AND the skill-result builder so both wind up
// with an identical config shape. `gen` is the operation envelope
// (joinSql / transformFunction / etc.).
function assembleJoinConfig({
  sources, stepPrompt, joinSettings, gen, warnings, chat,
  targetConn, isNoSQL, isLocalStorage, targetTableName, helpers,
}) {
  // Resolve which local file format a local-* destination writes to. The token
  // itself names the format (local-sqlite | local-nedb | local-lancedb), so a
  // local VECTOR destination (LanceDB) is preserved instead of collapsing to
  // SQLite. Mirrors JoinNodeChat's destination resolution (which derives the
  // dbType from the destinationSelection token rather than the NoSQL flag).
  const localDbType = isLocalStorage
    ? (String(joinSettings.destinationSelection || '').replace(/^local-/, '') || (isNoSQL ? 'nedb' : 'sqlite'))
    : null;
  const localDestName = localDbType === 'nedb' ? 'Local NeDB'
    : localDbType === 'lancedb' ? 'Local LanceDB'
    : 'Local SQLite';
  const isVectorLocal = localDbType === 'lancedb';

  const config = {
    nodeType: 'join',
    sources,
    joinRequest: stepPrompt,
    joinSettings,
    joinColumns: gen?.joinColumns || joinSettings.joinColumns,
    sourcesConfig: gen?.sourcesConfig || [],
    joinSql: gen?.joinSql || null,
    targetDdl: gen?.targetDdl || '',
    transformFunction: gen?.javascriptFunction || gen?.transformFunction || null,
    targetConnectionId: isLocalStorage ? `local-${localDbType}` : (targetConn?.id || targetConn?._id),
    targetConnectionName: isLocalStorage ? localDestName : targetConn?.name,
    targetConnectionType: isLocalStorage ? 'file' : (targetConn?.connectionType || 'database'),
    targetDbType: isLocalStorage ? localDbType : targetConn?.dbType,
    targetDbConfig: isLocalStorage ? {} : (targetConn?.dbConfig || {}),
  };

  // Record the local file the join writes to (matches JoinNodeChat's
  // config.targetLocalPath, which it sets from the execution result). The
  // headless builder doesn't run the join, so derive the deterministic path:
  // local SQLite → the shared userData/app-data.db workspace; local NeDB →
  // userData/local-collections/<collection>.db. Without this, previewing the
  // joined table (and downstream nodes that inherit sourceLocalPath) have no
  // path to open.
  if (isLocalStorage) {
    config.targetLocalPath =
      localDbType === 'nedb' ? localNeDBPath(targetTableName)
      : localDbType === 'lancedb' ? defaultLanceDBPath()
      : defaultLocalSqlitePath();
  }

  // Publish the joined table's schema so downstream nodes (output / transformer)
  // can read it — getOutputSchema and copySourceFromUpstream both expect a
  // join to expose config.targetTableSchema, mirroring what the transformer
  // builder records. Without it, an Output node reading from the join has no
  // tableName/columns and fails at execution.
  config.targetTableSchema = {
    tableName: targetTableName,
    columns: joinOutputColumns(gen, joinSettings),
  };

  if (gen?.vectorDestination) config.vectorDestination = gen.vectorDestination;
  // Local LanceDB destination: ensure a vectorDestination block exists so the
  // executor embeds the chosen column and upserts vectors into the local table —
  // the join produces rows, then the vector write happens on top, exactly like a
  // saved vector connection. Stamp the resolved local directory + dbType so the
  // executor opens the right LanceDB folder.
  if (isVectorLocal) {
    const vd = gen?.vectorDestination || {};
    config.vectorDestination = {
      ...vd,
      vectorDbType: 'lancedb',
      targetTable: vd.targetTable || targetTableName,
      // The executor (handleExecuteJoin vector branch) reads `targetLocalPath`.
      targetLocalPath: config.targetLocalPath,
    };
  }
  if (gen?._skillId) {
    config.skillId = gen._skillId;
    if (gen._skillExplanation) config.skillExplanation = gen._skillExplanation;
  }

  if (isNoSQL) {
    config.targetCollection = targetTableName;
    config.targetPreviewSql = nosqlPreviewQuery(targetTableName);
  } else {
    config.targetTableName = targetTableName;
    config.targetSql = gen?.joinSql || null;
    config.targetPreviewSql = gen?.previewSql
      || sqlPreviewQuery(targetTableName, null, config.targetDbType, helpers);
    config.targetSqlExplanation = gen?.explanation || '';
  }

  if (!gen?.joinSql && !gen?.javascriptFunction && !gen?.transformFunction) {
    if (warnings && Array.isArray(warnings)) {
      warnings.push('Join: AI did not return joinSql or javascriptFunction — open the join node in the editor to finish it.');
    }
  }

  const destLabel = isLocalStorage
    ? localDestName
    : (targetConn?.name || 'destination');
  const joinExplanation = gen?.explanation
    || `Built ${joinSettings.joinType} join "${targetTableName}" on ${sources.length} sources → ${destLabel}.`;
  const skillBanner = gen?._skillId ? ` via skill "${gen._skillId}"` : '';
  pushBotMsg(
    chat,
    `✓ Join generated${skillBanner}!\n\n${joinExplanation}\n\nSources: ${sources.length}\nDestination: ${destLabel}\nTarget table: ${targetTableName}\nJoin type: ${joinSettings.joinType}`,
    {
      metadata: {
        joinSettings,
        joinColumns: gen?.joinColumns || joinSettings.joinColumns || [],
        sourcesConfig: gen?.sourcesConfig || [],
        joinSql: gen?.joinSql || null,
        targetDdl: gen?.targetDdl || null,
        transformFunction: gen?.javascriptFunction || gen?.transformFunction || null,
        vectorDestination: gen?.vectorDestination || null,
      },
    },
  );

  return config;
}

/**
 * Skill-result builder for join steps. Mirrors applySkillResultTransformer.
 * Called by executeBuild when `plan.skillResults[stepIndex]` is present —
 * uses the pre-computed executionParams directly and skips the analyser
 * + generateJoinQuery entirely.
 */
async function applySkillResultJoin({ stepPrompt, upstreamNodes, helpers, nodeId, skillResult, chat }) {
  if (!upstreamNodes || upstreamNodes.length < 2) throw new Error('Join needs at least 2 upstream source nodes.');
  if (!skillResult || !skillResult.executionParams) {
    throw new Error('applySkillResultJoin requires skillResult.executionParams.');
  }
  const ep = skillResult.executionParams;
  const sources = upstreamNodes.map((n) => resolveJoinSource(n));

  const destinationSelection = ep.destinationSelection || skillResult.destinationSelection || (sources[0]?.sourceConnectionId);
  const isLocalStorage = String(destinationSelection || '').startsWith('local-');
  const targetTableName = ep.targetTableName || skillResult.targetTableName || `join_${(nodeId || Date.now()).toString().replace(/-/g, '_')}`;
  const targetConn = isLocalStorage ? null : resolveTargetConnection(destinationSelection, helpers.connections, sources[0]);
  const isNoSQL = isLocalStorage
    ? (destinationSelection === 'local-nedb')
    : (targetConn?.dbType === 'mongodb' || targetConn?.dbType === 'nedb');

  const joinSettings = {
    userRequest: stepPrompt,
    operationMode: ep.operationMode || 'new_table',
    destinationSelection: destinationSelection || (targetConn?.id || targetConn?._id) || 'local-sqlite',
    targetTableName,
    joinType: ep.joinType || 'INNER',
    joinColumns: ep.joinColumns || [],
    selectedColumns: ep.selectedColumns || {},
  };

  const gen = {
    explanation:       skillResult.explanation || ep.explanation || `Built via ${skillResult.skillId}.`,
    joinColumns:       ep.joinColumns || joinSettings.joinColumns,
    sourcesConfig:     ep.sourcesConfig || [],
    joinSql:           ep.joinSql || null,
    targetDdl:         ep.targetDdl || '',
    javascriptFunction: ep.javascriptFunction || null,
    transformFunction:  ep.transformFunction || null,
    previewSql:        ep.previewSql || null,
    vectorDestination: ep.vectorDestination || null,
    _skillId:          skillResult.skillId,
    _skillExplanation: skillResult.skillExplanation || null,
  };

  // Same enrichment as the standard path so a vector source carries its table
  // name into execution (see enrichJoinSourcesConfig).
  gen.sourcesConfig = enrichJoinSourcesConfig(gen.sourcesConfig, sources, helpers);

  return assembleJoinConfig({
    sources, stepPrompt, joinSettings, gen,
    warnings: [], chat,
    targetConn, isNoSQL, isLocalStorage, targetTableName, helpers,
  });
}

function resolveTargetConnection(ref, connections, fallbackSource) {
  if (!ref || String(ref).startsWith('local-')) {
    // Local destination — caller handles via isLocalStorage flag.
    const fb = connections.find((c) => (c.id || c._id) === fallbackSource?.sourceConnectionId);
    return fb || connections[0] || null;
  }
  return connections.find((c) => (c.id || c._id) === ref) || connections.find((c) => c.name === ref) || null;
}

// ---------------------------------------------------------------------------
// Output — pure config of where rows go.
// ---------------------------------------------------------------------------

async function buildOutputConfig({ stepPrompt, upstreamNode, helpers, warnings, chat }) {
  if (!upstreamNode) throw new Error('Output needs an upstream source node.');
  const source = copySourceFromUpstream(upstreamNode);
  // The output executor dereferences sourceTableSchema.tableName when loading
  // the source rows. Some upstreams (e.g. a join's target) may not expose a
  // full schema object, so synthesise one from the resolved table/collection
  // name so the output never runs into "Cannot read 'tableName' of undefined".
  const resolvedSourceTable = source.sourceTableName
    || source.sourceCollection
    || source.sourceTableSchema?.tableName;
  const sourceTableSchema = source.sourceTableSchema
    || (resolvedSourceTable ? { tableName: resolvedSourceTable, columns: [] } : null);
  const config = {
    nodeType: 'output',
    sourceNodeId: source.sourceNodeId,
    sourceNodeLabel: source.sourceNodeLabel,
    sourceConnectionId: source.sourceConnectionId,
    sourceConnectionName: source.sourceConnectionName,
    sourceConnectionType: source.sourceConnectionType,
    sourceDbType: source.sourceDbType,
    sourceDbConfig: source.sourceDbConfig,
    sourceTableSchema,
    sourceTableName: source.sourceTableName || sourceTableSchema?.tableName,
    sourceCollection: source.sourceCollection || sourceTableSchema?.tableName,
    sourceLocalPath: source.sourceLocalPath,
  };

  const connectionList = summarizeConnections(helpers.connections || []);
  const prompt = `Pick output settings for a workflow Output node.

User intent: "${stepPrompt}"

Source schema: ${describeTableSchema(source.sourceTableSchema)}

Available connections for "connection" output:
${JSON.stringify(connectionList, null, 2)}

Return JSON: { "outputSettings": { ... } }

For a database connection output:
{ "outputSettings": { "outputType": "connection", "connectionId": "<id-from-list>", "tableName": "<table>", "format": null, "savePath": null } }

For a local file output:
{ "outputSettings": { "outputType": "local", "format": "json"|"csv"|"excel"|"nedb"|"sqlite"|"parquet"|"avro", "savePath": "<absolute path>", "connectionId": null, "tableName": null } }
- savePath: a real absolute path the user gave. If the user did NOT give a
  concrete path (e.g. they said "use the save dialog" or didn't mention one),
  set savePath to null — the builder fills in a sensible default. Never invent
  a placeholder like "/ABSOLUTE/PATH/...".

Return ONLY the JSON object.`;
  const out = await callJson(helpers, prompt);
  console.log('buildOutputConfig: ', out)
  config.outputSettings = out.outputSettings || { outputType: null, format: null, savePath: null, connectionId: null, tableName: null };

  if (config.outputSettings.outputType === 'connection') {
    const exists = (helpers.connections || []).some((c) => (c.id || c._id) === config.outputSettings.connectionId);
    if (!exists) warnings.push(`Output: AI picked unknown connectionId "${config.outputSettings.connectionId}".`);
  }

  // A local export with no concrete savePath would write to a null path at run
  // time (there's no native save dialog in the headless build). Default it to a
  // deterministic path derived from the source table name + format.
  if (config.outputSettings.outputType === 'local' && !config.outputSettings.savePath) {
    config.outputSettings.savePath = defaultOutputSavePath(
      config.outputSettings.format,
      config.sourceTableName || sourceTableSchema?.tableName,
    );
    warnings.push(`Output: no save path was provided; defaulted to "${config.outputSettings.savePath}". Change it in the editor if you want a different location.`);
  }

  const os = config.outputSettings;
  const outputSummary = os.outputType === 'connection'
    ? `Configured output → connection "${os.connectionId}" / table "${os.tableName || '(none)'}".`
    : os.outputType === 'local'
      ? `Configured local output → ${os.format} at "${os.savePath || '(no path)'}".`
      : 'Configured output node (settings incomplete — open the node in the editor).';
  pushBotMsg(chat, outputSummary, { metadata: { outputSettings: os } });

  return config;
}

// ---------------------------------------------------------------------------
// Step + edge derivation.
//
// The plan now describes the FULL target step list (not deltas). executeBuild
// walks it; every step ends up as a node, and edges are derived from each
// step's resolved upstream node ids. The type-based rules below also let
// `start` and `dataSource` skip explicit sources — those connections are
// inferred from the step list.
// ---------------------------------------------------------------------------

function edgeId(source, target) { return `edge-${source}-${target}`; }

// The full conversational history that produced this node. Returned as a
// slim [{ sender, text }] array — same shape the AI providers' chatHistory
// option expects, so it can be forwarded straight to callAI without any
// transformation. Internal fields (id, timestamp, ref, value, data) are
// stripped to keep the payload small.
//
// Used in two places:
//   1. summarizeWorkflowAsSteps — embeds the chat as the 'prompt' field on
//      each currentSteps entry so the planner sees the full Q/A trail
//      that produced every existing node.
//   2. executeBuild — passed as ctx.chatHistory to builders when an
//      existing node is being modified or cascade-rebuilt, so the
//      per-builder AI calls run with the node's prior conversation as
//      context.
//
// Fallback: for nodes without stored chat (legacy / hand-edited), we
// synthesize a single user-message entry from the most relevant config
// slot so the planner has SOMETHING to anchor to.
function extractBuilderPromptFromNode(node) {
  const cfg = node?.data?.config || {};
  const chat = Array.isArray(cfg.chat) ? cfg.chat : [];
  const slim = chat
    .filter((m) => m && m.text)
    .map((m) => ({
      sender: m.sender === 'user' ? 'user' : 'bot',
      text: String(m.text),
    }));
  if (slim.length) return slim;
  const fallback = String(
    cfg.builderPrompt
    || cfg.transformationRequest
    || cfg.joinDescription
    || cfg.outputDescription
    || cfg.description
    || node?.data?.label
    || ''
  ).trim();
  return fallback ? [{ sender: 'user', text: fallback }] : [];
}

// First user message from the node's chat. Used by executeBuild as the
// stepPrompt when cascade-rebuilding a string-form keep — the builder
// needs a single instruction string to seed its prompt templates while
// the full chat array rides along on ctx.chatHistory for AI context.
function firstUserPromptFromNode(node) {
  const cfg = node?.data?.config || {};
  const chat = Array.isArray(cfg.chat) ? cfg.chat : [];
  const firstUser = chat.find((m) => m && m.sender === 'user' && m.text);
  if (firstUser) return String(firstUser.text);
  return String(cfg.builderPrompt || node?.data?.label || '').trim();
}

// DFS-style topological ordering — ported from src/utils/workflowUtils.js so
// the planner prompt and executeBuild can derive an execution order when
// workflow.executionSteps is empty (which it usually is for AI-built and
// hand-edited workflows).
function topoOrderNodeIds(nodes, edges, startNodeId) {
  const order = [];
  const seen = new Set();
  const allIds = new Set(nodes.map((n) => n.id));
  const dfs = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      const incoming = edges.filter((x) => x.target === e.target);
      if (incoming.every((x) => seen.has(x.source))) dfs(e.target);
    }
  };
  if (startNodeId && allIds.has(startNodeId)) dfs(startNodeId);
  // Disconnected nodes — outputs go last so the editor's invariants hold.
  const leftovers = [...allIds].filter((id) => !seen.has(id));
  const tailOutputs = [];
  for (const id of leftovers) {
    const n = nodes.find((x) => x.id === id);
    if (n && n.type === 'output') tailOutputs.push(id);
    else order.push(id);
  }
  order.push(...tailOutputs);
  return order;
}

// Build the per-prompt "current steps" representation the planner sees in
// modify mode. Prefers a saved executionSteps array, falls back to a topo
// derivation so we never feed the AI an empty list when the user hasn't
// opened the steps editor. Each entry is shaped so the AI can copy ids,
// sources, and prompts verbatim when a step should stay unchanged.
function summarizeWorkflowAsSteps(wf) {
  if (!wf || typeof wf !== 'object') return [];
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  if (!nodes.length) return [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const sourcesByTarget = new Map();
  for (const e of edges) {
    if (!sourcesByTarget.has(e.target)) sourcesByTarget.set(e.target, []);
    sourcesByTarget.get(e.target).push(e.source);
  }
  let orderedIds;
  const saved = Array.isArray(wf.executionSteps) ? wf.executionSteps : [];
  if (saved.length && saved.every((s) => nodesById.has(s.nodeId))) {
    orderedIds = saved.map((s) => s.nodeId);
    for (const id of nodes.map((n) => n.id)) if (!orderedIds.includes(id)) orderedIds.push(id);
  } else {
    const start = nodes.find((n) => n.type === 'start');
    orderedIds = topoOrderNodeIds(nodes, edges, start?.id || nodes[0]?.id);
  }
  return orderedIds.map((id) => {
    const n = nodesById.get(id);
    const cfg = n?.data?.config || {};
    return {
      existingNodeId: id,
      stepType: n?.type,
      label: n?.data?.label || labelFor(n?.type),
      sources: (sourcesByTarget.get(id) || []).slice(),
      ...(n?.type === 'dataSource' && cfg.connectionId ? { connectionId: cfg.connectionId } : {}),
      prompt: extractBuilderPromptFromNode(n),
    };
  });
}

// Walk the final step list and emit edges. Drives ALL edges off the resolved
// `sources` field — including the start→dataSource auto-wiring (start gets
// an outgoing edge to every dataSource step that didn't list a source itself).
function computeEdgesFromFinalSteps(finalSteps) {
  const edges = [];
  const pushed = new Set();
  const push = (src, tgt) => {
    if (!src || !tgt || src === tgt) return;
    const key = `${src}->${tgt}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    edges.push({ id: edgeId(src, tgt), source: src, target: tgt, type: 'default' });
  };
  const startStep = finalSteps.find((s) => s.stepType === 'start');
  for (const step of finalSteps) {
    const t = step.stepType;
    if (t === 'start') continue;
    if (t === 'dataSource') {
      // Auto-attach to start if the planner left sources empty.
      if (Array.isArray(step.resolvedSources) && step.resolvedSources.length) {
        for (const s of step.resolvedSources) push(s, step.nodeId);
      } else if (startStep) {
        push(startStep.nodeId, step.nodeId);
      }
      continue;
    }
    for (const s of step.resolvedSources || []) push(s, step.nodeId);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// planBuild — top-level planner. AI produces an ordered list of steps.
// ---------------------------------------------------------------------------

/**
 * Static planner brief — the rules, node-type contract, and output envelope.
 * Lives in the systemPrompt slot so it stays cached across retries and
 * doesn't get re-read by the model when we feed back validation errors.
 */
function buildPlannerSystemPrompt({ skillDocs = '', systemContext = '' }) {
  return `You are the Ternlux Workflow Planner. Plan a build of nodes for a React Flow workflow,
OR ask one short clarifying question if you do not yet have enough information.

# Node model — what each node type does and how they connect

A workflow is a directed graph: edges carry data from one node's output handle
to the next node's input handle. Each build step in your plan becomes one node,
and a step's 'sources' are the upstream nodes feeding it. The normal data flow
is:  start → dataSource → (transformer | join)* → (output?).

The five node types (the only stepTypes you may emit) and how they relate:

- start — the root, exactly one, always step 0. It does NOT touch data; it only
  decides WHEN the workflow runs (manual / schedule / file-watch). Every
  dataSource auto-attaches to it, so dataSource steps OMIT 'sources'.

- dataSource — the ONLY node that brings external data in. One connection →
  one materialised table/collection that downstream nodes read. Need data from
  N inputs? Emit N dataSource nodes. What it can read depends on the
  connection's category:
    • Relational / document DB (Postgres, MySQL, MSSQL, Snowflake, BigQuery,
      Mongo, NeDB, SQLite) → a named table/collection; downstream reads live.
    • Vector DB (Pinecone, LanceDB) → an index/table (+ namespace for
      Pinecone); rows come back flattened (id + metadata).
    • REST API → an AI-generated fetch function pulls rows into a local
      collection (auth is injected at run time — never mention credentials).
    • Imported local file (CSV/Excel/JSON/Parquet/Avro/SQLite/NeDB/LanceDB) →
      re-imported fresh each run into the local workspace.
    • Cloud storage (GCS/S3/Dropbox/Drive) → can't be configured by chat;
      at run time it lands locally as SQLite (tabular) or NeDB (JSON). No
      vector-file import. See the picker-based rule below.
    • Spreadsheet service (Google Sheets) → can't be configured by chat (same
      rule below); lands locally as SQLite.

- transformer — takes exactly ONE upstream (a dataSource, transformer, or
  join) and reshapes it (filter, map, aggregate, rename, cast, derive, or
  in-place update/delete) across SQL, document, or local sources. It is a
  TERMINAL WRITE: the reshaped result is persisted to a table/collection (or a
  local SQLite/NeDB file) as part of running — there is NO separate save step.
  Its only vector ops are: vectorise/embed a column into a vector table, and
  in-place maintenance of a vector source (update/delete/tag its own records).
  Matching rows to OTHER rows by similarity is NOT a transformer — that's a
  join (see below).

- join — takes TWO OR MORE upstreams and merges them. Also a TERMINAL WRITE:
  the joined rows are written to its destination as it runs. The sources may
  live in entirely different systems (e.g. a relational table joined with a
  document collection) — that's fine. A vector source can be read as a normal
  table, OR similarity search can drive the join ("for each row, find the
  top-K most similar"). ALL similarity matching / "find similar" / enrichment-
  with-matches is a join — including a vector table searched against itself
  (a self-join: list that source twice in 'sources').

- output — ONLY for delivering the final result somewhere the upstream
  transformer/join CANNOT write itself: a file export (json/csv/excel/parquet/
  avro/nedb/sqlite/lancedb), or a DIFFERENT connection/table than the one the
  upstream already wrote to. If the pipeline already ends at the transformer/
  join's own target, NO output node is needed.

Key relational rules that follow from the above:
- Because transformer and join already persist their own result, do NOT chain
  an output node that re-writes the same data to the same place — that is a
  planner bug.
- 'sources' wires the graph: every transformer/join/output points at the
  upstream node(s) it consumes (by step index in this plan, or by an existing
  node id in modify-mode).

The "Per-node-type requirements" section below is the authoritative FIELD
contract — it says exactly what each step's 'prompt' must convey. The per-node
builders own all the generation details (SQL vs NoSQL vs JS, dialect quoting,
REST fetch code, vector embedding) and sample live tables themselves, so you
never restate those here.

# Output-type expectations — match the DESTINATION type to what actually runs

Each node/skill produces its result through a specific execution path, and some
destination TYPES cannot run some KINDS of logic. Pick the destination that fits
the work; a mismatch does not error loudly — the builder silently degrades (e.g.
emits NULL columns, or writes to a place the next node can't read). Rules:

- dataSource → no destination choice; it only materialises rows. Remote SQL/doc
  DBs read live; a vector source returns flattened id+metadata rows; API /
  imported-file / picker sources land locally as SQLite (tabular) or NeDB
  (document).

- transformer → writes exactly ONE reshaped table, and the destination type is
  constrained by HOW it computes:
    • Plain reshape (filter / map / aggregate / rename / cast / derive, or a
      MongoDB aggregation pipeline) → stays in the SAME engine: write back to
      the source DB (storageLocation='database'), or to a local SQLite (tabular)
      / NeDB (document) file (storageLocation='local'). A Mongo→Mongo aggregate
      is fully expressible here — do NOT route it through a skill.
    • Per-row Node.js / crypto / SHA-256 / arbitrary JS logic → routed to the
      javascript-executor skill, whose output is LOCAL-ONLY: nedb or lancedb. It
      CANNOT write back to a SQL or Mongo server. So if you require a hash/JS
      step AND the result must live in Mongo/SQL, that's two steps, or accept a
      local (nedb) result. Never plan a JS-transform step that "writes back to
      MongoDB".
    • Embed / vectorise a column → routed to the vector-db-executor skill;
      output is a VECTOR table (local-lancedb, or a saved vector connection).

- join → writes merged rows to 'connectionId'; the destination TYPE must match
  the join KIND:
    • Plain keyed / equality join (Scenario A, incl. reading a vector source as
      a normal id+metadata table) → ANY destination: a saved connection,
      local-sqlite, local-nedb, or local-lancedb.
    • Similarity / embedding join (Scenario B: "for each row find the most
      similar…", per-row embed + vector search) → the match runs as a JS
      function in Node, and the executor ONLY runs that function for a NoSQL or
      VECTOR destination. Scenario B MUST use local-nedb, local-lancedb, or a
      saved NoSQL/vector connection — NEVER local-sqlite or a SQL connection. A
      SQL destination forces a static-SQL join that cannot embed or search, so
      the similarity columns come back NULL. If the user wants the FINAL match
      result in SQLite / CSV, still write the join to local-nedb, then add an
      Output node to export that file/format.

- output → delivery only; it never computes. A file export (csv / json / excel /
  parquet / avro / nedb / sqlite / lancedb) or a DIFFERENT connection/table than
  the upstream already wrote to.

Rule of thumb: choose the destination from the KIND of execution, not just the
data — "similarity / find-similar / semantic match" ⇒ nedb / lancedb / vector
destination; "hash / per-row JS in a transformer" ⇒ nedb / lancedb; a plain SQL
or Mongo reshape ⇒ that same engine or local-sqlite / local-nedb.
${skillDocs ? `\n# Skills (optional execution paths a transformer/join may route through instead of plain SQL/NoSQL — only the ones relevant to this request are loaded)\n${skillDocs}\n` : ''}
${systemContext ? `# System & file-path context
This is the user's actual machine and Ternlux's on-disk layout. When a step
involves a local file (an output node's absolute savePath, a local SQLite/NeDB/
LanceDB target, or a path the user names), resolve it against THIS layout:
interpret relative paths from the home directory, write absolute paths with the
right separator for this OS, and default file exports to the Downloads folder
when the user gives no path. These are the deterministic locations recorded as
targetLocalPath / savePath at build time, so the paths you put in step prompts
match what actually gets written.

${systemContext}\n` : ''}

# How this planner is used

Your output is consumed in two phases:

  1. Clarification phase: if the user request is missing information you'd
     need to write concrete per-step prompts, return a "ask_questions"
     envelope with ONE short follow-up. The chat assistant relays the
     question and the user answers. Prior Q&A pairs from earlier rounds
     of this same plan request live in the CHAT HISTORY — every assistant
     message that begins with "Clarifying question:" is one of your prior
     questions, immediately followed by the user's answer. Treat that
     history as authoritative; do NOT re-ask anything already answered
     there, and do NOT expect a separate "clarifications" block in the
     user message. Repeat the ask_questions cycle until you have enough.

  2. Planning phase: when (and only when) you have enough, return a
     "plan" envelope. The plan is a flat list of build steps; each step's
     'prompt' is fed verbatim to a per-node builder that re-invokes its own
     AI to generate the concrete operation and samples live tables itself,
     so you do NOT need to repeat schema details — but the user-facing
     decisions (which connection, which table, which join keys, which
     output destination, in_place vs new_table, etc.) MUST be in the
     prompt or the builder will fall back to defaults.

Never invent secrets / tokens / auth headers in a prompt — connections
own those server-side. Never invent connection ids — refer to connections
by their 'name'. Never invent column names — if you don't know them, ask.

# Picker-based connections can't be CONFIGURED by chat (cloud storage & Google Sheets)

Cloud-storage (GCS / Amazon S3 / Dropbox / Google Drive) and spreadsheet-service
(Google Sheets) connections need a native picker to choose the exact bucket /
object / sheet, which only exists in the editor. The AI cannot set that path. So:
- Don't try to CONFIGURE a cloud-storage / Google-Sheets data source, or a
  cloud-storage output, through chat. If the pipeline doesn't actually need one,
  simply leave it out.
- If the pipeline genuinely needs one as a SOURCE or DESTINATION, return
  action="ask_questions" and tell the user to add and configure that node
  manually in the editor first (briefly note which node), then come back to chat.
- Transformers and joins are ALWAYS fine through chat. Once such a SOURCE exists,
  at RUN TIME it pulls its data into a LOCAL store — SQLite for tabular/SQL data
  (CSV, Excel, Parquet, Avro, spreadsheets) or NeDB for document/NoSQL data
  (JSON) — and downstream transformer / join steps operate on that local copy.
  In modify-mode, plan those downstream steps as normal (reference the
  picker-based node by its existing id); just don't rebuild or reconfigure the
  picker-based node itself.
- Cloud storage CANNOT import vector files — there is no LanceDB-from-a-bucket
  path right now, so don't plan one.

# Per-node-type requirements (what each step's 'prompt' MUST convey)

## start  (triggerType ∈ {manual, time, file})
- "manual": no schedule. Default when the user is silent about timing.
- "time": describe cadence in plain English ("every Monday at 9:30 am",
  "every 15 minutes"). Builder produces a 5-field cron expression.
- "file": absolute path + type ∈ {file, directory} + ≥1 event from
  {add, change, unlink, addDir, changeDir, unlinkDir}.

## dataSource  (no 'sources' — auto-attached to start)
- REQUIRED field 'connectionId': set this to the EXACT id of one of the
  saved connections shown in the user message's connections list. The
  builder reads this id directly — it does NOT re-pick the connection
  from the prompt text. If you don't know which connection the user
  means, return action="ask_questions" instead of guessing.
- The connection's TYPE governs what else the step prompt must say:
  - Database connection (Postgres / MySQL / MSSQL / Snowflake / BigQuery /
    MongoDB / NeDB / SQLite / etc.): name or describe the table /
    collection to read. Builder runs getTables and picks from the live
    list.
  - REST API connection: describe the endpoint, query params, and any
    pagination / cursor behaviour. Auth is injected from the saved
    connection — DO NOT mention tokens, API keys, usernames, or
    passwords. The builder generates the async JS fetch function itself.
  - Cloud storage (GCS / S3 / Dropbox / Google Drive) OR spreadsheet
    service (Google Sheets): the AI can't configure these — see the
    "Picker-based connections" rule above. Don't build the source through
    chat; ask the user to add and configure that node in the editor, then
    chat builds the transformer / join steps that read from its
    locally-materialised (SQLite / NeDB) data.
  - Vector DB (Pinecone / LanceDB): name the index/table; namespace
    for Pinecone if relevant.
  - Imported file connection (CSV / Excel / JSON / Parquet / Avro /
    local SQLite / NeDB / LanceDB): the file is pre-loaded under a
    known table; just name the connection.

## transformer  ('sources' length 1)
- IMPORTANT: a transformer ALREADY WRITES its result to a target table
  (in the same connection when storageLocation='database', or to a
  local SQLite/NeDB file when storageLocation='local'). Treat the
  transformer as both compute AND persistence — do NOT add an output
  step to write the same data to the same destination again.
- Describe the transformation concretely — name source columns and the
  output shape (filter, map, aggregate, rename, cast, derive…). Don't
  invent columns.
- operationMode: "new_table" (reversible, default) | "in_place"
  (mutates the upstream table, irreversible).
- storageLocation (only meaningful when operationMode='new_table' and
  the source is REMOTE): "database" (write back to source connection)
  | "local" (write to local SQLite/NeDB on disk). Constraint:
  storageLocation='local' forces operationMode='new_table'.
- Optional custom target table/collection name.
- Vector / embedding TRANSFORMER ops are limited to exactly two cases —
  the builder routes both to the vector skill automatically:
    1. Embed/vectorise a column of THIS one source and store the vectors
       into a vector table (regular data → vector store).
    2. In-place maintenance of a vector source: update / delete / tag its
       own records, optionally selected by a similarity or metadata search.
  CRITICAL — these do NOT cover matching rows to OTHER rows. If the request
  is "for each row, find the N most similar rows and combine / enrich /
  attach the matches" (top-K similar, "find similar", recommendations,
  semantic join), that is a JOIN (Scenario B), NOT a transformer — even
  when the same vector table is searched against itself. Emit a join step
  for it; never a transformer.

## join  ('sources' length ≥ 2)
- USE A JOIN FOR ALL SIMILARITY MATCHING. Any "for each row, find the N
  most similar rows and combine / enrich / attach them" request (top-K
  similar, "find similar", recommendations, semantic / vector join) is a
  JOIN — never a transformer, even when it is vector-based.
- A join's 'sources' MUST list at least TWO DISTINCT upstream nodes. NEVER
  list the same node twice (no "sources": [3, 3]) — the same node cannot be
  attached to a join twice. For a vector similarity search where the data is
  "searched against itself", pick TWO DIFFERENT nodes:
    * LEFT (driving / probe rows): the node that produces the rows you want to
      enrich — usually the upstream dataSource, or the transformer that emitted
      those rows.
    * RIGHT (vector table searched): the node holding the vector table you
      search for neighbours — usually the embedding transformer's output (a
      local-lancedb table) or a saved vector connection.
  Example — "embed items into LanceDB, then for each item find the top-5
  similar items": LEFT = the items dataSource, RIGHT = the LanceDB-embedding
  transformer's output → "sources": [<itemsIdx>, <lancedbIdx>], two distinct
  indices. If a second real source is involved (e.g. join the similarity hits
  back to the original table), list both — but they must still be distinct.
- IMPORTANT: a join IS a terminal write step for its own result. It
  ALREADY OUTPUTS the joined rows to its destination — a saved connection,
  "local-sqlite", "local-nedb", or "local-lancedb" — as part of running
  the join. It does
  NOT need, and MUST NOT be followed by, an Output node to persist that
  result. Same rule as transformer: do NOT chain an output step after a
  join. If the user just wants the joined data "saved", "written", or
  "stored" somewhere, point the join's own 'connectionId' at that
  destination — do not add an Output node.
  - The ONLY time an Output node may follow a join is when the user
    explicitly wants the SAME joined data ALSO delivered to a genuinely
    DIFFERENT destination the join itself cannot write to: a file export
    in a format the join can't produce (csv / json / excel / parquet /
    avro), or a DIFFERENT database connection/table than the join wrote
    to. A plain database/local-sqlite/local-nedb/local-lancedb table the
    join already targets is NOT such a case — the join writes those
    directly (local-lancedb embeds + upserts the rows as vectors). A
    cloud-storage destination IS such a case but is MANUAL-ONLY (see the
    rule above) — don't emit it; tell the user to add the cloud-storage
    output node in the editor.
- REQUIRED field 'connectionId': the destination the join writes to.
  Set it to ONE of:
  - The EXACT id of a saved connection from the connections list
    (the join result is written to that connection), OR
  - The literal token "local-sqlite" — write to a local SQLite file, OR
  - The literal token "local-nedb" — write to a local NeDB file, OR
  - The literal token "local-lancedb" — write to a local LanceDB vector
    table on disk (the join's rows are embedded and upserted as vectors).
  PICK THE TOKEN BY THE *KIND* OF DESTINATION THE USER ASKED FOR:
  - The user wants the result stored as a LOCAL VECTOR table — embeddings,
    a "lancedb table", something similarity-searchable, "vectorize and
    store locally" — and named no saved vector connection → "local-lancedb".
    Do NOT downgrade a requested local vector table to "local-sqlite";
    that silently drops the embeddings. (A SAVED vector connection such as
    Pinecone is referenced by its connection id, not a local-* token.)
  - The user wants a relational / scratch table, or didn't mention
    vectors → "local-sqlite". EXCEPTION: a SIMILARITY / embedding join
    (Scenario B — "for each row find the most similar", per-row vector
    search) must NEVER use "local-sqlite" even though its output looks
    tabular; a SQL destination can't run the per-row search and the match
    columns come back NULL. Use "local-nedb" for it (then an Output node if
    the user wants a CSV/SQLite file of the result).
  - The user wants a local document / NoSQL collection → "local-nedb".
  This is the join's counterpart to 'connectionId' on dataSource —
  the builder reads it directly and does NOT re-pick the destination
  from the prompt text. If you don't know where the user wants the
  join written, return action="ask_questions" instead of guessing.
- For EVERY source pair being joined, state:
  - the join key columns ("orders.user_id = users.id") — never inferred
    from column-name similarity;
  - the join type for that pair: INNER | LEFT | RIGHT | FULL (default
    INNER when the user is silent).
- selectedColumns: which columns to keep in the output, per source.
- targetTableName: REQUIRED (joins always create / write a target).
- If a source is a vector store, state which applies:
  (A) read the vector store as a normal table and join on a plain key, or
  (B) similarity search drives the join — "for each row find the top-K most
  similar" (optionally constrained by a metadata field like category, and
  excluding self-matches). The user's "search the LanceDB for similar items
  per category" is case B. State the embed column, the vector source to
  search, top-K, and any metadata constraint.
- Destination shape governs builder output automatically — your job is
  only to be unambiguous about destination + intent.

## output  ('sources' length 1)
- An output step is ONLY needed when the data must land somewhere the
  upstream transformer/join CANNOT write to itself. The transformer and
  join builders already persist their result to a table or local file —
  adding a redundant output that writes the same data to the same
  destination is a planner bug.
- EMIT an output step when ALL of these are true:
  1. The user wants the result delivered somewhere OTHER than the
     transformer/join's own target — a different saved connection/table,
     or a local file export (csv/json/excel/parquet/avro/nedb/sqlite/
     lancedb). EXCEPTION: a cloud-storage destination is MANUAL-ONLY —
     do not emit an output step for it; per the rule above, ask the user
     to add and configure the cloud-storage output node in the editor
     instead.
  2. The destination is not already the upstream's targetConnection
     and targetTableName/targetCollection.
- OMIT the output step when:
  - The pipeline ends at the transformer or join's target itself
    (e.g. "transform Mongo collection A into Mongo collection B" — the
    transformer already wrote B; no output needed).
  - The user only described a transformation/aggregation and didn't
    ask for a separate destination.
- When you DO emit one:
  - outputType: "connection" or "local".
  - outputType='connection': name a connection/table that differs from
    the upstream's target (a different dbType, connection, or table).
    Cloud-storage destinations are MANUAL-ONLY (see the rule above) —
    never emit one here. For vector DBs, name the index (+ namespace for
    Pinecone). For BigQuery / Snowflake, use the qualified table name
    (dataset.table / schema.table).
  - outputType='local': format ∈ {json, csv, excel, nedb, sqlite,
    lancedb, parquet, avro} + absolute savePath. Use this when the
    user wants a file export distinct from any database table the
    transformer/join already produced.

# When to ask a clarifying question (return action="ask_questions")

Ask BEFORE planning if ANY of these are unknown:
- Which saved connection the dataSource should read from, when more
  than one connection is plausible from the request.
- For modify-mode: which existing node the user means to change /
  replace, when the request is ambiguous.
- Which table / collection to read, when the user said something
  generic ("our events", "the orders") and multiple connections /
  tables could match.
- For joins: the join keys, the join type, or which sources are
  being joined. Never assume; ask.
- For transformers: when the user said "transform the data" without
  saying what the transformation is.
- For outputs: where the result should go (a connection? a local file?
  which format?).
- The trigger / schedule, when the user didn't say when it should run
  AND "manual" is not an obviously safe default for their phrasing.

Ask exactly ONE short, specific question per turn (the user sees it
verbatim in the chat). Build on previous clarifications — don't
re-ask anything that's already in the clarifications list.

# Output envelope

Return ONE of these two JSON shapes. ONLY the JSON object, no prose,
no fences.

## Shape A — ask a clarifying question

{
  "action": "ask_questions",
  "followUpQuestion": "<one short, specific question, < 200 chars>",
  "reasoning": "<one sentence — why this is needed before planning>"
}

## Shape B — emit the plan

{
  "action": "plan",
  "name": "<workflow name, REQUIRED when mode='new'; omit for 'modify'>",
  "description": "<one short sentence describing what the workflow does end-to-end — REQUIRED when mode='new', omit for 'modify'>",
  "mode": "new" | "modify",
  "steps": [
    "<existingNodeId>",
    {
      "existingNodeId": "<id of an existing node, ONLY when modifying it>",
      "stepType": "start" | "dataSource" | "transformer" | "join" | "output",
      "label": "<short human label shown in the plan UI>",
      "sources": [<stepIndex or existing nodeId>, ...],
      "connectionId": "<REQUIRED for stepType='dataSource' (the source connection — exact id from the connections list) AND for stepType='join' (the destination — exact connection id from the list, OR the literal 'local-sqlite' / 'local-nedb' / 'local-lancedb'); omit for other stepTypes>",
      "prompt": "<the EXACT instruction sent to the per-node builder; concrete, no placeholders>"
    }
  ],
  "deletedNodes": ["<existing node id>", ...]
}

Steps-array rules:
- Each entry is ONE of:
  - A STRING — the id of an existing node to keep UNCHANGED. Use this
    for every node you do not intend to modify. Never re-emit the
    node's full spec — just the id.
  - An OBJECT with 'existingNodeId' — modify that existing node with
    the new spec.
  - An OBJECT without 'existingNodeId' — add a new node.

Structural rules for shape B (object-form steps only):
- OMIT 'sources' for start.
- OMIT 'sources' for dataSource (auto-attached to start).
- REQUIRED length-1 for transformer / output.
- REQUIRED length-≥2 for join.
- 'sources' values are step indices in THIS plan (0-based) referring
  to earlier entries, OR node id strings (an id of a kept/modified
  existing node, or a string-form keep entry above this one).

Mode rules:
- mode='new':
  - step 0 MUST be the 'start' object and at least one 'dataSource'
    object MUST appear.
  - String-form keep entries MUST NOT appear (there are no existing
    nodes).
  - 'existingNodeId' MUST NOT appear on any step.
  - 'deletedNodes' MUST be omitted or [].

- mode='modify': the plan is the COMPLETE target step list, not a
  patch. You will be given the current workflow as an ordered
  'currentSteps' array in the user message — each entry is
  { existingNodeId, stepType, label, sources, prompt }. Rules:
  - For every step you want to KEEP unchanged, write its
    existingNodeId as a STRING entry in steps[]. Do not duplicate
    its fields.
  - For every step you want to MODIFY, emit an OBJECT entry whose
    'existingNodeId' matches the currentSteps entry, with a new
    'prompt' (and/or 'sources', and/or 'connectionId').
  - For every NEW step, emit an OBJECT entry WITHOUT 'existingNodeId'.
  - For every existing node you want to REMOVE, list its id in the
    top-level 'deletedNodes' array AND OMIT it from steps[].
  - INVARIANT: every node id in currentSteps MUST appear EXACTLY
    ONCE across (string-form steps) + (steps[].existingNodeId) +
    'deletedNodes'. Never zero, never two. The executor rejects any
    plan that violates this.
  - Do NOT introduce a NEW 'start' step unless the user explicitly
    asks to change the trigger; the existing start must be kept as
    a string entry or removed via 'deletedNodes'.

Prompt-writing rules:
- Each 'prompt' is sent to the per-node builder. Be specific: name the
  connection, the table/collection, the transformation logic, the
  join keys, the output destination — no placeholders, no \`<...>\`
  tokens.
- The user sees the prompt before confirming, so keep it readable —
  one short paragraph per step is enough.
- Never include credentials, tokens, API keys, or passwords.`;
}

/**
 * Dynamic per-call planner message — the request, mode, workflow snapshot,
 * clarifications, and available connections. Kept small so retries with
 * appended error feedback stay cheap.
 */
function buildPlannerUserMessage({ userRequest, mode, wfSummary, currentSteps, connections, lastError }) {
  const errSection = lastError
    ? `\n# Your previous response was rejected with this error\n${lastError}\n\nReturn a CORRECTED single JSON envelope that addresses this error. Do not repeat the same mistake.\n`
    : '';
  // Modify mode: the planner sees the workflow as an ordered step list
  // (existingNodeId + spec snapshot per step) and a slimmed node dump for
  // resolving columns/connections. Every id in currentSteps MUST be
  // accounted for in the returned plan (kept, modified, or deleted).
  const stepsSection = (mode === 'modify' && Array.isArray(currentSteps))
    ? `Current workflow steps (in execution order — every existingNodeId below MUST appear in your plan as either a string-keep entry, a modify object, or in deletedNodes):\n${JSON.stringify(currentSteps, null, 2)}\n\n`
    : '';
  const wfSection = (mode === 'modify' && wfSummary)
    ? `Current workflow (slimmed nodes for column / connection lookup):\n${JSON.stringify(wfSummary, null, 2)}\n`
    : '';
  return `User request:
"${userRequest}"

Mode: ${mode}
${stepsSection}${wfSection}
Available connections (the only connections you may reference; pick by NAME — the
builder resolves names to ids at execution time):
${JSON.stringify(connections, null, 2)}
${errSection}
Return ONE single JSON envelope (Shape A or Shape B from the system brief).`;
}

/**
 * Validate the model's plan envelope. Throws a plain Error with a clear
 * description of what's wrong — the planBuild loop catches it and feeds
 * it back to the AI for self-correction instead of bubbling to the user.
 */
function validatePlanEnvelope(out, { mode, wfSummary, connections }) {
  if (out.action === 'ask_questions') {
    if (!out.followUpQuestion || !String(out.followUpQuestion).trim()) {
      throw new Error('action="ask_questions" requires a non-empty followUpQuestion field.');
    }
    return; // ask_questions branch is otherwise unstructured
  }
  if (out.action && out.action !== 'plan') {
    throw new Error(`Unknown action "${out.action}". Use "ask_questions" or "plan".`);
  }
  if (!Array.isArray(out.steps) || out.steps.length === 0) {
    throw new Error('Plan has no steps[]. Provide an ordered list of build steps.');
  }

  const existingById = new Map();
  if (wfSummary && Array.isArray(wfSummary.nodes)) {
    for (const n of wfSummary.nodes) existingById.set(n.id, n);
  }

  // ── Normalize step entries — string-form keeps and object-form steps.
  // Each entry resolves to { kind, existingNodeId?, stepType, sources[], rawIndex }
  // so the rest of validation can speak a single shape.
  const PRODUCER_TYPES = new Set(['dataSource', 'transformer', 'join']);
  const sourceArityOk = (stepType, len) => {
    if (stepType === 'start' || stepType === 'dataSource') return len === 0;
    if (stepType === 'transformer' || stepType === 'output' || stepType === 'branch') return len === 1;
    if (stepType === 'join') return len >= 2;
    return false;
  };
  const parentTypeOk = (childType, parentType) => {
    if (!parentType) return false;
    if (childType === 'transformer' || childType === 'output' || childType === 'branch' || childType === 'join') {
      return PRODUCER_TYPES.has(parentType);
    }
    return false;
  };

  const norm = out.steps.map((s, i) => {
    if (typeof s === 'string') {
      if (mode === 'new') {
        throw new Error(`Step ${i}: string-form keep entries are only valid in mode="modify".`);
      }
      const existing = existingById.get(s);
      if (!existing) {
        throw new Error(`Step ${i}: string-form keep entry "${s}" does not match any existing node id.`);
      }
      return {
        kind: 'keep',
        existingNodeId: s,
        stepType: existing.type,
        sources: null,           // inherit from existing edges at apply time
        connectionId: existing?.data?.config?.connectionId || null,
      };
    }
    if (!s || typeof s !== 'object') {
      throw new Error(`Step ${i}: must be either a node id string (keep) or a step object.`);
    }
    return {
      kind: s.existingNodeId ? 'modify' : 'add',
      existingNodeId: s.existingNodeId || null,
      stepType: s.stepType,
      sources: Array.isArray(s.sources) ? s.sources : [],
      connectionId: s.connectionId || null,
      prompt: s.prompt,
    };
  });

  if (mode === 'new') {
    if (norm[0]?.stepType !== 'start') {
      throw new Error('For mode="new", step 0 must be of stepType "start".');
    }
    if (!norm.some((s) => s.stepType === 'dataSource')) {
      throw new Error('For mode="new", at least one "dataSource" step is required.');
    }
    if (!out.description || !String(out.description).trim()) {
      throw new Error('For mode="new", "description" is required — provide a one-sentence summary of what the workflow does.');
    }
    if (norm.some((s) => s.kind !== 'add')) {
      throw new Error('For mode="new", every step must be a brand-new object (no existingNodeId, no string-form keeps).');
    }
    if (Array.isArray(out.deletedNodes) && out.deletedNodes.length) {
      throw new Error('For mode="new", "deletedNodes" must be omitted or empty.');
    }
  }

  // ── Modify-mode coverage / deletion sanity. Every existing node id MUST
  // appear EXACTLY ONCE across kept/modified steps + deletedNodes.
  if (mode === 'modify') {
    const deleted = Array.isArray(out.deletedNodes) ? out.deletedNodes.slice() : [];
    for (const id of deleted) {
      if (typeof id !== 'string') {
        throw new Error(`deletedNodes contains a non-string entry: ${JSON.stringify(id)}`);
      }
      if (!existingById.has(id)) {
        throw new Error(`deletedNodes references "${id}", which is not in the current workflow.`);
      }
    }
    const seen = new Map(); // id → "step N" | "deletedNodes[i]"
    norm.forEach((s, i) => {
      if (s.existingNodeId) {
        if (seen.has(s.existingNodeId)) {
          throw new Error(`Existing node id "${s.existingNodeId}" appears twice — first in ${seen.get(s.existingNodeId)}, again in step ${i}. Each existing node must appear EXACTLY ONCE in steps[] or deletedNodes.`);
        }
        if (!existingById.has(s.existingNodeId)) {
          throw new Error(`Step ${i}: existingNodeId "${s.existingNodeId}" does not match any existing node.`);
        }
        seen.set(s.existingNodeId, `step ${i}`);
      }
    });
    deleted.forEach((id, i) => {
      if (seen.has(id)) {
        throw new Error(`Existing node id "${id}" appears in deletedNodes[${i}] but also in ${seen.get(id)}. Pick ONE — keep/modify it OR delete it.`);
      }
      seen.set(id, `deletedNodes[${i}]`);
    });
    for (const id of existingById.keys()) {
      if (!seen.has(id)) {
        const existing = existingById.get(id);
        throw new Error(`Existing node "${id}" (${existing?.type}) is missing from the plan. Every existing node MUST appear EXACTLY ONCE — either as a string-form keep in steps[], as an object step with existingNodeId="${id}", or in deletedNodes.`);
      }
    }
  }

  // ── Per-step structural / source-shape checks for object-form steps.
  const connectionIds = new Set((connections || []).map((c) => c.id || c._id).filter(Boolean));

  norm.forEach((s, i) => {
    if (s.kind === 'keep') return; // string-form keeps inherit everything

    if (!s.stepType) {
      throw new Error(`Step ${i}: missing stepType.`);
    }
    if (s.stepType === 'dataSource') {
      if (!s.connectionId) {
        throw new Error(`Step ${i} (dataSource) must declare a "connectionId" — the exact id of a saved connection from the connections list.`);
      }
      if (connectionIds.size && !connectionIds.has(s.connectionId)) {
        throw new Error(`Step ${i} (dataSource) connectionId "${s.connectionId}" is not in the saved connections list. Pick one of: ${Array.from(connectionIds).join(', ')}.`);
      }
    }

    if (s.stepType === 'join') {
      if (!s.connectionId) {
        throw new Error(`Step ${i} (join) must declare a "connectionId" — the destination where the join result is written. Use a saved connection id, or the literal "local-sqlite" / "local-nedb" / "local-lancedb".`);
      }
      const isLocal = s.connectionId === 'local-sqlite' || s.connectionId === 'local-nedb' || s.connectionId === 'local-lancedb';
      if (!isLocal && connectionIds.size && !connectionIds.has(s.connectionId)) {
        throw new Error(`Step ${i} (join) connectionId "${s.connectionId}" is not a saved connection nor "local-sqlite" / "local-nedb" / "local-lancedb". Pick one of: ${Array.from(connectionIds).join(', ')}, local-sqlite, local-nedb, local-lancedb.`);
      }
    }

    const refs = s.sources || [];
    if (!sourceArityOk(s.stepType, refs.length)) {
      if (s.stepType === 'transformer' || s.stepType === 'output') {
        throw new Error(`Step ${i} (${s.stepType}) must declare exactly one source.`);
      }
      if (s.stepType === 'join') {
        throw new Error(`Step ${i} (join) must declare at least two sources.`);
      }
      if (s.stepType === 'start' || s.stepType === 'dataSource') {
        throw new Error(`Step ${i} (${s.stepType}) must NOT declare sources.`);
      }
    }

    // A join needs at least TWO DISTINCT upstream nodes — the same node cannot
    // be attached twice (graph edges are keyed by source→target, so a duplicate
    // collapses to a single edge and the join silently loses a side). A vector
    // similarity "self-join" must instead use two different nodes: the driving
    // rows (left) and the vector table searched (right).
    if (s.stepType === 'join') {
      const seenRefs = new Set();
      for (const ref of refs) {
        const key = typeof ref === 'number' ? `idx:${ref}` : `id:${ref}`;
        if (seenRefs.has(key)) {
          throw new Error(`Step ${i} (join) lists the same source (${JSON.stringify(ref)}) more than once. A join needs at least TWO DISTINCT upstream nodes — the same node cannot be attached twice. For a vector similarity search, use the driving-rows source (left) and the vector table (right) as two different nodes.`);
        }
        seenRefs.add(key);
      }
      if (seenRefs.size < 2) {
        throw new Error(`Step ${i} (join) must reference at least TWO DISTINCT sources.`);
      }
    }

    for (const ref of refs) {
      if (typeof ref === 'number') {
        if (ref < 0 || ref >= i || !Number.isInteger(ref)) {
          throw new Error(`Step ${i} (${s.stepType}) source index ${ref} does not point to an earlier step in the plan.`);
        }
        const parent = norm[ref];
        if (!parent) throw new Error(`Step ${i} (${s.stepType}) source step ${ref} does not exist.`);
        if (!parentTypeOk(s.stepType, parent.stepType)) {
          throw new Error(`Step ${i} (${s.stepType}) cannot have step ${ref} (${parent.stepType}) as a parent.`);
        }
      } else if (typeof ref === 'string') {
        const existing = existingById.get(ref);
        if (!existing) {
          throw new Error(`Step ${i} (${s.stepType}) references existing node id "${ref}" that is not in the workflow.`);
        }
        if (!parentTypeOk(s.stepType, existing.type)) {
          throw new Error(`Step ${i} (${s.stepType}) cannot have existing node "${ref}" (${existing.type}) as a parent.`);
        }
      } else {
        throw new Error(`Step ${i} (${s.stepType}) has a source of unsupported type: ${JSON.stringify(ref)}`);
      }
    }
  });
}

async function planBuild({ userRequest, workflow, helpers, clarifications = [] }) {
  const connections = summarizeConnections(helpers.connections || []);
  const wfSummary = workflow ? slimWorkflowForPrompt(workflow) : null;
  const currentSteps = workflow ? summarizeWorkflowAsSteps(workflow) : null;
  // The caller (propose_plan) decides whether this is a modify by passing a
  // workflow or not — a workflow being open in the editor does NOT by itself
  // force a modify. So mode is simply: workflow present → modify, else new.
  const mode = wfSummary ? 'modify' : 'new';

  // The planner brief no longer embeds the full node / chat-prompt reference
  // docs — its built-in "Node model" + "Per-node-type requirements" sections
  // carry the planning logic, and the per-node builders own the generation
  // details. Skills ARE still injected (they're small and steer routing), so
  // we keep the tiny picker pass that selects only the relevant ones. Empty
  // array → no skill section is appended.
  const relevantSkillIds = await pickRelevantSkillDocs({ helpers, userRequest, clarifications });
  const skillDocs = skillDocsAsPromptSection(relevantSkillIds);

  const systemPrompt = buildPlannerSystemPrompt({ skillDocs, systemContext: buildSystemContext() });
  const chatHistory  = clarificationsAsChatHistory(clarifications);

  let lastError = null;
  for (let attempt = 0; attempt < PLAN_RETRIES; attempt++) {
    const userMessage = buildPlannerUserMessage({
      userRequest, mode, wfSummary, currentSteps, connections, lastError,
    });

    let out;
    let attemptError = null;
    try {
      out = await callJson(helpers, userMessage, { systemPrompt, chatHistory });
      console.log('::planBuild:: ', out)
    } catch (err) {
      attemptError = err.message;
    }

    if (!attemptError) {
      try {
        validatePlanEnvelope(out, { mode, wfSummary, connections });
      } catch (err) {
        attemptError = err.message;
      }
    }

    if (attemptError) {
      // If the AI repeats the exact same error after a self-correction
      // attempt, it isn't going to fix itself with another retry — break
      // out now and surface the error as chat text instead of looping.
      if (lastError && attemptError === lastError) {
        lastError = attemptError;
        break;
      }
      lastError = attemptError;
      continue;
    }

    if (out.action === 'ask_questions') {
      return {
        action: 'ask_questions',
        followUpQuestion: String(out.followUpQuestion).trim(),
        reasoning: out.reasoning || '',
        mode,
      };
    }

    if (mode === 'new' && !out.name) out.name = 'New Workflow';
    out.action = 'plan';
    out.mode = mode;
    return out;
  }

  // All retries exhausted (or we broke out early because the AI repeated
  // itself). Return an error envelope instead of throwing — propose_plan
  // surfaces it as plain chat text so the user can see what went wrong.
  return {
    action: 'error',
    message: lastError || 'Workflow planner could not produce a valid plan.',
    mode,
  };
}

// ---------------------------------------------------------------------------
// executeBuild — runs every step, writes the workflow once.
// ---------------------------------------------------------------------------

const NODE_TYPE_BY_STEP = {
  start: 'start',
  dataSource: 'dataSource',
  transformer: 'transformer',
  join: 'join',
  output: 'output',
};

const STARTING_POSITION = { x: 100, y: 200 };
const X_SPACING = 320;
const Y_SPACING = 120;

function defaultPositionFor(index, type) {
  return {
    x: STARTING_POSITION.x + index * X_SPACING,
    y: STARTING_POSITION.y + (type === 'join' ? -40 : 0),
  };
}

function newNodeId(stepType, idx) {
  if (stepType === 'start') return 'start-node';
  return `${stepType}-${Date.now()}-${idx}`;
}

function labelFor(stepType) {
  switch (stepType) {
    case 'start':       return 'Start';
    case 'dataSource':  return 'Data Source';
    case 'transformer': return 'Transformer';
    case 'join':        return 'Join';
    case 'output':      return 'Output';
    default:            return 'Node';
  }
}

function builderFor(stepType) {
  switch (stepType) {
    case 'start':       return buildStartConfig;
    case 'dataSource':  return buildDataSourceConfig;
    case 'transformer': return buildTransformerConfig;
    case 'join':        return buildJoinConfig;
    case 'output':      return buildOutputConfig;
    default:            throw new Error(`Unknown step type: ${stepType}`);
  }
}

// Existing edges grouped for fast lookup: upstream ids that point AT a given
// node, used both to compare against AI-declared sources (detect modification)
// and to inherit sources for string-form keep entries the planner left bare.
function sourcesByTarget(edges) {
  const map = new Map();
  for (const e of edges || []) {
    if (!map.has(e.target)) map.set(e.target, []);
    map.get(e.target).push(e.source);
  }
  return map;
}

// The schema a node outputs (what downstream nodes will see as input).
// dataSource publishes the source table; transformer/join publish their
// target table. start/output have no meaningful downstream schema.
function getOutputSchema(node) {
  if (!node) return null;
  const cfg = node.data?.config || {};
  switch (node.type) {
    case 'dataSource':  return cfg.sourceTableSchema || null;
    case 'transformer': return cfg.targetTableSchema || cfg.sourceTableSchema || null;
    case 'join':        return cfg.targetTableSchema || null;
    default:            return null;
  }
}

// The input schemas an existing node was BUILT against, keyed by upstream
// node id. We compare these to each upstream's CURRENT output schema to
// decide whether the existing node still matches its inputs — if it
// doesn't, the node needs to be rebuilt even though the AI marked it keep.
function getCachedInputSchemas(node) {
  const result = new Map();
  if (!node) return result;
  const cfg = node.data?.config || {};
  if (cfg.sourceNodeId && cfg.sourceTableSchema) {
    result.set(cfg.sourceNodeId, cfg.sourceTableSchema);
  }
  if (Array.isArray(cfg.sources)) {
    for (const s of cfg.sources) {
      if (s?.sourceNodeId && s?.sourceTableSchema) {
        result.set(s.sourceNodeId, s.sourceTableSchema);
      }
    }
  }
  return result;
}

// Schema equality: same column names + types (order-insensitive). Used to
// gate "do we actually need to rebuild this downstream node?" so a string-
// form keep that the AI emitted doesn't force a rebuild when nothing about
// its inputs has actually moved.
function schemasEqual(a, b) {
  if (a == null && b == null) return true;
  if (!a || !b) return false;
  const colsA = Array.isArray(a.columns) ? a.columns : [];
  const colsB = Array.isArray(b.columns) ? b.columns : [];
  if (colsA.length !== colsB.length) return false;
  const keyOf = (c) => `${String(c?.name || c?.column_name || '').toLowerCase()}::${String(c?.type || c?.data_type || '').toLowerCase()}`;
  const setA = new Set(colsA.map(keyOf));
  for (const c of colsB) if (!setA.has(keyOf(c))) return false;
  return true;
}

// Resolve a source reference (number = in-plan step index, string = node id)
// against the entries we've already walked. For string ids we accept either
// a built entry's existingNodeId, an added entry's new node id, or — if not
// yet walked — fall back to the original existing nodes map so referencing
// an upstream that hasn't been visited yet still works.
function resolveSourceRef(ref, builtByIdx, existingNodesById) {
  if (typeof ref === 'number') {
    const b = builtByIdx[ref];
    return b ? b.node.id : null;
  }
  if (typeof ref === 'string') {
    for (const b of Object.values(builtByIdx)) {
      if (b && b.node && b.node.id === ref) return ref;
    }
    if (existingNodesById.has(ref)) return ref;
  }
  return null;
}

/**
 * Register the live CRON job / file watcher for every start node in a built
 * workflow — the headless counterpart to StartNodeChat.handleSave.
 *
 * The trigger system lives in the main process (public/triggers/*) and needs
 * `executeWorkflowFromTrigger` bound in, so the actual register/unregister
 * calls are surfaced on `helpers.startTriggers` by the host (electron.js).
 * When that capability is absent (tests, headless tooling) we skip silently —
 * the config is still persisted, so registerAllWorkflowTriggers picks it up on
 * the next app start.
 *
 * For each start node we unregister any prior CRON + file watcher for the same
 * (workflowId, nodeId) BEFORE registering the new one. That mirrors handleSave's
 * unregister-before-register dance and is what makes a trigger-TYPE switch on
 * modify (time→file, or either→manual) actually clear the stale trigger instead
 * of leaving it running.
 */
async function registerStartTriggers({ nodes, workflowId, helpers, warnings }) {
  const api = helpers && helpers.startTriggers;
  if (!api) return;

  const startNodes = (nodes || []).filter((n) => n && n.type === 'start');
  for (const node of startNodes) {
    const config = node.data?.config || {};
    const nodeId = node.id;
    try {
      // Clear any previous trigger for this node first (no-op when none exists).
      if (typeof api.unregisterCron === 'function')      await api.unregisterCron({ nodeId, workflowId });
      if (typeof api.unregisterFileWatch === 'function') await api.unregisterFileWatch({ nodeId, workflowId });

      if (config.triggerType === 'time' && config.cronExpression) {
        const result = await api.registerCron({
          nodeId,
          workflowId,
          cronExpression: config.cronExpression,
          description: config.description || 'Scheduled trigger',
        });
        if (result && result.success === false) {
          warnings.push(`Start node ${nodeId}: failed to register schedule — ${result.message}`);
        }
      } else if (config.triggerType === 'file' && config.fileWatchConfig) {
        const { path: watchPath, events, pattern } = config.fileWatchConfig;
        if (!watchPath || !Array.isArray(events) || events.length === 0) {
          warnings.push(`Start node ${nodeId}: file trigger missing path or events — not registered.`);
          continue;
        }
        const result = await api.registerFileWatch({
          nodeId,
          workflowId,
          path: watchPath,
          events,
          pattern: pattern || null,
        });
        if (result && result.success === false) {
          warnings.push(`Start node ${nodeId}: failed to register file watcher — ${result.message}`);
        }
      }
      // 'manual' (or no triggerType): nothing to register — the unregister
      // above already cleared any prior trigger for this node.
    } catch (err) {
      warnings.push(`Start node ${nodeId}: trigger registration error — ${err.message}`);
    }
  }
}

async function executeBuild({ plan, workflow, helpers, getDb, onProgress }) {
  const warnings = [];
  // Progress dispatch — the IPC layer forwards these to the renderer so the
  // chat can stream a live "build log" of each step. Never let a listener
  // error break the build.
  const emit = (evt) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(evt); } catch (_) { /* progress is best-effort */ }
  };
  emit({ phase: 'start', mode: plan.mode || 'new', totalSteps: Array.isArray(plan.steps) ? plan.steps.length : 0 });
  const existingNodes = Array.isArray(workflow?.nodes) ? workflow.nodes.slice() : [];
  const existingEdges = Array.isArray(workflow?.edges) ? workflow.edges.slice() : [];
  const existingNodesById = new Map(existingNodes.map((n) => [n.id, n]));
  const existingSourcesByTarget = sourcesByTarget(existingEdges);

  const deletedSet = new Set(Array.isArray(plan.deletedNodes) ? plan.deletedNodes : []);

  // Coverage sanity at apply time too: validatePlanEnvelope already enforces
  // this, but a second check here catches plans the planner produced before
  // an upgrade — we'd rather fail clearly than silently lose nodes.
  if (plan.mode === 'modify') {
    const accounted = new Set(deletedSet);
    for (const s of plan.steps) {
      if (typeof s === 'string') accounted.add(s);
      else if (s && s.existingNodeId) accounted.add(s.existingNodeId);
    }
    const missing = [];
    for (const id of existingNodesById.keys()) if (!accounted.has(id)) missing.push(id);
    if (missing.length) {
      const err = new Error(`Plan is missing existing nodes: ${missing.join(', ')}. Every existing node must appear in steps[] or deletedNodes.`);
      err.isPlanCoverageError = true;
      throw err;
    }
  }

  // builtByIdx[i] = { node, stepType, resolvedSources, action, ... }
  //
  // The walk is the only place where the keep/rebuild/add decision is made.
  // For each step we know:
  //   - what kind of entry the AI emitted (string-keep, modify, add)
  //   - the CURRENT output schema of every upstream (from the running map
  //     we update at the end of each step)
  // From those two we derive the action:
  //   - explicit modify (object with existingNodeId) → REBUILD with chat + existing config + new prompt
  //   - explicit add (object without existingNodeId)  → BUILD with prompt only
  //   - string-form keep:
  //       upstream schema unchanged → KEEP verbatim, no builder run
  //       upstream schema changed   → REBUILD with chat + existing config (no new prompt; use prior chat)
  //
  // This collapses every action into "build / rebuild / keep" without a
  // global dirty flag — each step decides on its own based on actual schema
  // movement, so a deletion or modify that doesn't shift a downstream's
  // schema doesn't force the downstream to rebuild for no reason.
  const builtByIdx = [];

  // ── Resumable build cache.
  //
  // A builder can pause the whole build by throwing ClarificationNeeded /
  // SkillSubagentRequired. The renderer then asks the user, appends the answer
  // to plan.clarifications, and calls executeBuild AGAIN. Without caching, that
  // restart re-runs (and re-pays the AI cost for) every node from step 0 — so a
  // 5-node plan where three nodes each ask a question rebuilds the whole thing
  // three times.
  //
  // To make the restart resumable, every step that COMPLETES (builds without
  // asking) is recorded in `builtStepsOut`, keyed by step index, and surfaced
  // back to the renderer on the pause (err.builtSteps). The renderer stores it
  // on plan.builtSteps and passes it to the next executeBuild call. On that
  // next pass we reuse the cached node verbatim and skip the builder — so the
  // build resumes at the first not-yet-finished step (the one that asked).
  //
  // A step is cached ONLY after it finishes without asking, so a multi-question
  // step keeps rebuilding (seeing the full clarification trail each pass) until
  // it stops asking, then gets cached. Cached nodes keep their ids, so source
  // references from later steps stay valid across passes.
  const cachedSteps = (plan.builtSteps && typeof plan.builtSteps === 'object') ? plan.builtSteps : {};
  const builtStepsOut = {};

  // Current output schema by node id, updated as the walk progresses.
  // Pre-seed from existing nodes; deletions clear to null (downstream
  // referencing a deleted node has its input snapped to null = changed).
  const currentOutputSchema = new Map();
  for (const n of existingNodes) currentOutputSchema.set(n.id, getOutputSchema(n));
  for (const id of deletedSet) currentOutputSchema.set(id, null);

  for (let i = 0; i < plan.steps.length; i++) {
    // ── Resume: a step finished on a PRIOR pass → reuse it, skip the builder.
    const cached = cachedSteps[i];
    if (cached && cached.node && cached.node.id) {
      const cnode = cached.node;
      builtByIdx.push({
        node: cnode,
        stepType: cnode.type,
        resolvedSources: Array.isArray(cached.resolvedSources) ? cached.resolvedSources : [],
        action: cached.action || 'add',
        prompt: cached.prompt || '',
        stepIndex: i,
        label: cached.label || cnode.data?.label || labelFor(cnode.type),
      });
      currentOutputSchema.set(cnode.id, getOutputSchema(cnode));
      builtStepsOut[i] = cached;   // carry forward so the next pause keeps it
      emit({ phase: 'step', status: 'done', stepIndex: i, stepType: cnode.type, label: cached.label, action: 'cached' });
      continue;
    }

    const raw = plan.steps[i];
    const isShorthand = typeof raw === 'string';

    // ── Normalize step entry into a uniform shape.
    let existingNodeId = null;
    let stepType;
    let sourcesRaw;
    let stepPrompt;
    let connectionId = null;
    let label;

    if (isShorthand) {
      existingNodeId = raw;
      const ex = existingNodesById.get(existingNodeId);
      if (!ex) throw new Error(`Step ${i}: string-form keep entry "${raw}" not in workflow.`);
      stepType = ex.type;
      // Inherit sources from existing edges.
      sourcesRaw = (existingSourcesByTarget.get(existingNodeId) || []).slice();
      // String-form keeps don't carry a prompt — fall back to the first user
      // message stored in the node's chat for cascade-rebuilds.
      stepPrompt = firstUserPromptFromNode(ex);
      connectionId = ex?.data?.config?.connectionId || null;
      label = ex?.data?.label || labelFor(stepType);
    } else {
      if (!raw || typeof raw !== 'object') throw new Error(`Step ${i}: must be a step object or existing node id string.`);
      stepType = raw.stepType;
      existingNodeId = raw.existingNodeId || null;
      sourcesRaw = Array.isArray(raw.sources) ? raw.sources : [];
      stepPrompt = raw.prompt || raw.label || '';
      connectionId = raw.connectionId || null;
      label = raw.label || labelFor(stepType);
    }

    const nodeType = NODE_TYPE_BY_STEP[stepType];
    if (!nodeType) throw new Error(`Step ${i}: unknown stepType "${stepType}"`);

    const resolvedSources = sourcesRaw
      .map((r) => resolveSourceRef(r, builtByIdx, existingNodesById))
      .filter(Boolean);

    const existing = existingNodeId ? existingNodesById.get(existingNodeId) : null;
    if (!existing && existingNodeId) {
      throw new Error(`Step ${i}: existingNodeId "${existingNodeId}" not in workflow.`);
    }

    // ── Decide action.
    //   modify / add are explicit from the entry shape.
    //   keep needs the schema-change gate: if any upstream's current output
    //   schema differs from what THIS node was built against, the existing
    //   config is stale and must be rebuilt.
    let action;
    if (!isShorthand && existing) {
      action = 'modify';
    } else if (!isShorthand) {
      action = 'add';
    } else {
      const cachedInputs = getCachedInputSchemas(existing);
      let upstreamChanged = false;
      for (const srcId of resolvedSources) {
        const nowSchema = currentOutputSchema.get(srcId);
        const wasSchema = cachedInputs.get(srcId);
        if (!schemasEqual(nowSchema, wasSchema)) { upstreamChanged = true; break; }
      }
      action = upstreamChanged ? 'cascade-rebuild' : 'keep';
    }

    emit({ phase: 'step', status: 'running', stepIndex: i, stepType, label, action });

    // ── KEEP: reuse the existing node verbatim. No builder run.
    if (action === 'keep') {
      emit({ phase: 'step', status: 'done', stepIndex: i, stepType, label, action: 'keep' });
      const keepEntry = {
        node: existing,
        stepType: nodeType,
        resolvedSources,
        action: 'keep',
        prompt: stepPrompt,
        stepIndex: i,
        label: existing.data?.label || label,
      };
      builtByIdx.push(keepEntry);
      builtStepsOut[i] = { node: existing, resolvedSources, action: 'keep', prompt: stepPrompt, label: keepEntry.label };
      currentOutputSchema.set(existing.id, getOutputSchema(existing));
      continue;
    }

    // Reuse the existing id on modify/cascade-rebuild so downstream
    // references stay valid; ADD gets a fresh id.
    const nodeId = (action === 'add' || !existingNodeId) ? newNodeId(stepType, i) : existingNodeId;

    const upstreamNodes = resolvedSources.map((id) => {
      for (const b of builtByIdx) if (b.node.id === id) return b.node;
      return existingNodesById.get(id) || null;
    }).filter(Boolean);

    const stepClarifications = Array.isArray(plan.clarifications)
      ? plan.clarifications.filter((c) => c && (c.stepIndex == null || c.stepIndex === i))
      : [];

    // ── Seed the builder's chat. For rebuilds we INHERIT the existing
    // node's chat (Q/A trail + final response) so the builder doesn't have
    // to re-derive everything from a single prompt. For ADD we seed fresh
    // with the planner's prompt.
    //
    // A new clarification answer (the user replied to a builder question
    // since the last run) gets pushed in below via the builder itself —
    // builders call pushUserMsg(chat, answer) when they consume a
    // clarification, so this chat carries the full Q/A history forward.
    const stepChat = [];
    if (existing) {
      const priorChat = Array.isArray(existing.data?.config?.chat) ? existing.data.config.chat : [];
      for (const m of priorChat) if (m && m.text) stepChat.push({ ...m });
      // For an explicit modify with a new prompt, record the new ask in
      // chat so the conversation reflects the change the user requested.
      if (action === 'modify' && stepPrompt && stepPrompt !== firstUserPromptFromNode(existing)) {
        pushUserMsg(stepChat, stepPrompt, { ref: 'modifyRequest' });
      }
    } else {
      seedChatForStep(stepChat, stepType, stepPrompt || label || '');
    }

    let config;
    try {
      const ctx = {
        stepPrompt: stepPrompt || label || '',
        helpers,
        warnings,
        nodeId,
        upstreamNode: upstreamNodes[0] || null,
        upstreamNodes,
        clarifications: stepClarifications,
        connectionId: connectionId || null,
        chat: stepChat,
        chatHistory: existing ? extractBuilderPromptFromNode(existing) : [],
        existingConfig: existing?.data?.config || null,
        action,
        bypassSkills: !!(plan.skipSkills && (plan.skipSkills[i] || plan.skipSkills[nodeId])),
      };
      // Skill-result switch: if the renderer's skill subagent already
      // converged on execution params for this step, route through the
      // skill-result builder INSTEAD of the main processor. The main
      // builder (buildTransformerConfig / buildJoinConfig) is untouched.
      const skillResult = plan.skillResults && (plan.skillResults[i] || plan.skillResults[nodeId]);
      if (skillResult && skillResult.executionParams) {
        ctx.skillResult = skillResult;
        if (stepType === 'transformer') {
          config = await applySkillResultTransformer(ctx);
        } else if (stepType === 'join') {
          config = await applySkillResultJoin(ctx);
        } else {
          throw new Error(`Skill-result builder not available for step type "${stepType}".`);
        }
      } else {
        const fn = builderFor(stepType);
        config = await fn(ctx);
      }
    } catch (err) {
      if (err && (err.isClarificationNeeded || err.isSkillSubagentRequired)) {
        err.stepIndex = i;
        err.stepType = stepType;
        // Hand back everything built so far (steps 0..i-1) so the renderer can
        // resume here instead of rebuilding the whole plan after the answer.
        err.builtSteps = builtStepsOut;
        throw err;
      }
      throw new Error(`Step ${i} (${stepType}): ${err.message}`);
    }

    pushBotMsg(stepChat, `Configuration saved!\n\n**${labelFor(stepType)} step:** ${stepPrompt || label || ''}`);
    pushChatContinue(stepChat);

    config.chat = stepChat;
    // Stash the most recent planner prompt — used as the cascade-rebuild
    // fallback when this node has no user-message in its chat (legacy).
    config.builderPrompt = stepPrompt || '';

    // Preserve position on rebuild so the editor doesn't jump nodes around.
    const position = (action !== 'add' && existing?.position)
      ? existing.position
      : defaultPositionFor(i, nodeType);

    const node = {
      id: nodeId,
      type: nodeType,
      position,
      data: { label: label || labelFor(stepType), config },
      ...(nodeType === 'start' ? { deletable: false, draggable: true } : {}),
    };

    builtByIdx.push({
      node,
      stepType: nodeType,
      resolvedSources,
      action,
      prompt: stepPrompt,
      stepIndex: i,
      label: node.data.label,
    });

    // This step finished without asking → cache it so a later pause doesn't
    // rebuild it.
    builtStepsOut[i] = { node, resolvedSources, action, prompt: stepPrompt, label: node.data.label };

    // Update the running output-schema map so subsequent steps can
    // detect whether they need a cascade-rebuild.
    currentOutputSchema.set(node.id, getOutputSchema(node));

    emit({ phase: 'step', status: 'done', stepIndex: i, stepType, label, action });
  }

  // ── Position de-collision pass.
  //
  // Kept nodes carry their saved position forward; newly-built nodes start
  // at defaultPositionFor(stepIndex). The two choices happen independently,
  // so a new node inserted at step i can land on top of a kept node that
  // USED to be at step i (its saved x is still i*X_SPACING). Walk in step
  // order: whenever a node's position collides with one we've already
  // placed, recompute it from defaultPositionFor(i) and, if THAT slot is
  // taken too, keep walking right by X_SPACING until we find a gap. The
  // node is cloned before mutating position so we don't write through to
  // the shared `existing` reference of a string-form keep.
  const placedKeys = new Set();
  const keyOf = (pos) => `${Math.round((pos?.x || 0) / 5)}:${Math.round((pos?.y || 0) / 5)}`;
  for (let i = 0; i < builtByIdx.length; i++) {
    const b = builtByIdx[i];
    let pos = b.node.position || defaultPositionFor(i, b.stepType);
    let k = keyOf(pos);
    if (placedKeys.has(k)) {
      pos = defaultPositionFor(i, b.stepType);
      k = keyOf(pos);
      while (placedKeys.has(k)) {
        pos = { x: pos.x + X_SPACING, y: pos.y };
        k = keyOf(pos);
      }
      b.node = { ...b.node, position: pos };
    }
    placedKeys.add(k);
  }

  // ── Compose the final node + edge sets from the walk.
  const finalNodes = builtByIdx.map((b) => b.node);
  const finalNodeIds = new Set(finalNodes.map((n) => n.id));

  // Edges are derived entirely from the walked steps' resolved sources —
  // no leftovers from `existingEdges`. The final-pass filter is just a
  // belt-and-braces drop for refs that didn't resolve to a built node.
  const derivedEdges = computeEdgesFromFinalSteps(
    builtByIdx.map((b) => ({
      nodeId: b.node.id,
      stepType: b.stepType,
      resolvedSources: b.resolvedSources,
    })),
  );
  const finalEdges = derivedEdges.filter((e) => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));

  // ── executionSteps for the workflow doc — same shape WorkflowStepsEditor
  // saves so the editor can round-trip without surprises.
  const finalExecutionSteps = builtByIdx.map((b, idx) => ({
    id: `step-${b.node.id}`,
    nodeId: b.node.id,
    nodeType: b.stepType,
    nodeLabel: b.label || b.node.data?.label || labelFor(b.stepType),
    customName: '',
    description: b.prompt || '',
    order: idx,
    config: b.node.data?.config || {},
  }));

  // ── Persist.
  const wfDb = getDb('workflows');
  let workflowId;
  if (plan.mode === 'modify' && workflow) {
    workflowId = workflow.id || workflow._id;
    await wfDb.updateAsync(
      { $or: [{ id: workflowId }, { _id: workflowId }] },
      { $set: {
        nodes: finalNodes,
        edges: finalEdges,
        executionSteps: finalExecutionSteps,
        updatedAt: new Date().toISOString(),
      } },
    );
  } else {
    workflowId = `wf-${Date.now()}`;
    const doc = {
      id: workflowId,
      name: plan.name || 'New Workflow',
      description: String(plan.description || '').trim(),
      nodes: finalNodes,
      edges: finalEdges,
      executionSteps: finalExecutionSteps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await wfDb.insertAsync(doc);
  }

  // ── Register start-node triggers with the live trigger system.
  //
  // StartNodeChat.handleSave registers a CRON job / file watcher the moment a
  // time/file start node is saved (via window.electronAPI.startTriggers.*).
  // The headless builder persists the SAME config but never registered the
  // trigger, so a built schedule/watcher only came alive after an app restart
  // (registerAllWorkflowTriggers). Do it here too, mirroring handleSave, so a
  // freshly-built workflow starts firing immediately.
  await registerStartTriggers({ nodes: finalNodes, workflowId, helpers, warnings });

  emit({
    phase: 'done',
    workflowId,
    workflowName: plan.name || workflow?.name || 'New Workflow',
    nodeCount: finalNodes.length,
    edgeCount: finalEdges.length,
  });

  return {
    workflowId,
    workflowName: plan.name || workflow?.name || 'New Workflow',
    workflowDescription: plan.mode === 'modify'
      ? (workflow?.description || '')
      : String(plan.description || '').trim(),
    nodes: finalNodes,
    edges: finalEdges,
    executionSteps: finalExecutionSteps,
    warnings,
  };
}

module.exports = {
  planBuild,
  executeBuild,
  computeEdgesFromFinalSteps,
  summarizeWorkflowAsSteps,
  loadNodeDocs,
  loadChatPromptDocs,
  loadSkillDocs,
  nodeDocsAsPromptSection,
  chatPromptDocsAsPromptSection,
  skillDocsAsPromptSection,
  pickRelevantSkillDocs,
  slimWorkflowForPrompt,
  buildSystemContext,
  runSkillTurn,
  SkillSubagentRequired,
};
