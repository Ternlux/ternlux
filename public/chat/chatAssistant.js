/**
 * Dagflux Chat Assistant — single-step agent.
 *
 * The renderer drives the loop: each call to `runStep` performs ONE AI turn,
 * executes whatever tools the model asked for (the model may request several
 * tools in a single turn), and returns the result. The renderer renders the
 * step into the chat, then either issues another `chat:step` or — if the user
 * pressed cancel — stops. There is no long-lived loop in the main process,
 * which means cancellation is just "don't send the next step request".
 *
 * Wired into electron.js via `chat:step`. The handler hands us
 * `buildSkillHelpers()` (runQuery / getTables / getColumns / connections /
 * callAI) and `getDb` (workflows / connections / executions / chatSessions
 * NeDB stores).
 */

const fs = require('fs');
const path = require('path');

const DOCS_ROOT = path.join(__dirname, '..', 'docs');
const MAX_FIELD_CHARS = 10000;
const MAX_QUERY_ROWS = 50;
const MAX_ACTIONS_PER_STEP = 5;

function safeReadFile(absPath) {
  try { return fs.readFileSync(absPath, 'utf8'); }
  catch (err) { return null; }
}

function listDocFiles() {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(r);
    }
  };
  walk(DOCS_ROOT, '');
  return out.sort();
}

function readDoc(relPath) {
  // Defensive path: must stay inside DOCS_ROOT.
  const norm = path.normalize(relPath || '').replace(/^[\\/]+/, '');
  const abs = path.join(DOCS_ROOT, norm);
  if (!abs.startsWith(DOCS_ROOT)) {
    throw new Error(`Doc path escapes /docs: ${relPath}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Doc not found: ${relPath}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

function trimText(value, max = MAX_FIELD_CHARS) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function summarizeWorkflow(wf) {
  if (!wf) return null;
  const id = wf.id || wf._id;
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  return {
    id,
    name: wf.name,
    description: wf.description || null,
    type: wf.type || null,
    nodeCount: nodes.length,
    nodeTypes: nodes.map((n) => n.type || n?.data?.type).filter(Boolean),
    lastExecuted: wf.lastExecuted || null,
    updatedAt: wf.updatedAt || null,
  };
}

function summarizeConnection(c) {
  if (!c) return null;
  const id = c.id || c._id;
  return {
    id,
    name: c.name,
    dbType: c.dbType,
    dbCategory: c.dbCategory || null,
    connectionType: c.connectionType || null,
  };
}

function summarizeExecution(e) {
  if (!e) return null;
  const id = e.executionId || e.id || e._id;
  return {
    id,
    workflowId: e.workflowId || null,
    workflowName: e.workflowName || null,
    status: e.status || null,
    trigger: e.trigger?.type || null,
    startedAt: e.startedAt || e.createdAt || null,
    durationMs: e.durationMs ?? null,
  };
}

/**
 * Build the system prompt. Embeds the high-level README plus an index of the
 * remaining docs so the model knows what it can pull on demand. Tool catalogue
 * is the contract — every tool listed here MUST be implemented in runTool.
 */
function buildSystemPrompt({ docIndex, readme, contextSummary, snapshot, maxActions }) {
  return `You are the Dagflux Assistant — an in-app helper that answers questions about the user's
data workflows, saved connections, and execution history, and can run queries against
those connections to fetch live data.

You operate as a tool-using agent, ONE TURN AT A TIME. On every turn you reply with a
SINGLE JSON object — nothing before it, nothing after it. The renderer parses your reply,
runs the tools you asked for, then sends you the next turn with the results appended.
Do NOT pretend to be the renderer; do NOT include a follow-up turn in your reply.

Schemas (pick exactly ONE per turn):

A) Run one or more tools to gather information:
{
  "thought": "<one short sentence — the user sees this>",
  "actions": [
    { "tool": "<tool_name>", "args": { ... } },
    ...                                            // up to ${maxActions} per turn
  ]
}

B) Finish and answer the user:
{
  "thought": "<one short sentence — the user sees this>",
  "finalAnswer": "<answer in markdown>"
}

When you batch actions, only batch tools whose results don't depend on each other
(e.g. "list_workflows" + "list_connections" together). If action B depends on the
result of action A, run A this turn and B next turn.

# Tool catalogue

- list_docs                  → { sections: [...] }            // already loaded below
- read_doc { path }          → markdown contents              // path is relative to /docs
- list_workflows             → [{ id, name, type, nodeCount, ... }]
- get_workflow { id }        → full workflow doc (nodes + edges)
- list_connections           → [{ id, name, dbType, dbCategory, connectionType }]
- get_connection { id }      → connection metadata (no secrets)
- list_executions { limit?, workflowId? } → recent execution summaries
- get_execution { id }       → full execution doc with logs
- get_tables { connection }  → list tables/collections in a saved connection
- get_columns { connection, table, schema? } → list columns
- run_query { connection, query, limit? }   → rows from the connection
       • For SQL connectors, query is a SQL string.
       • For MongoDB / NeDB, query is a JSON object the connector understands.
       • Capped at ${MAX_QUERY_ROWS} rows per call. Add LIMIT in your SQL too.

${contextSummary ? '# Context the user is currently looking at' : ''}
${contextSummary ? contextSummary : ''}

# Snapshot of the workspace (truncated; use list_* / get_* tools for more)

${trimText(snapshot, 4000)}

# Doc index (use read_doc to fetch any of these)

${docIndex.map((p) => `- ${p}`).join('\n')}

# Top-level overview (public/docs/README.md)

${readme}

# Rules
- Output ONLY the single JSON object. No prose, no backticks, no second turn.
- If a tool errors, read the error, then either retry with corrected args or
  switch tools next turn. Do not repeat the same failing call.
- Never claim to have done something you did not actually do via a tool.
- If the user asks to *edit* a workflow, describe the change you would make
  and ask them to confirm — you do not have a write tool yet.
- Keep "thought" short (≤ 20 words) — it is shown live to the user.
- Keep final answers concise; lead with the headline number/finding.`;
}

async function runTool(name, args, ctx) {
  const { helpers, getDb, docIndex } = ctx;
  args = args || {};

  switch (name) {
    case 'list_docs':
      return { sections: docIndex };

    case 'read_doc':
      return { path: args.path, content: readDoc(args.path) };

    case 'list_workflows': {
      const db = getDb('workflows');
      const rows = await db.findAsync({});
      return rows.map(summarizeWorkflow);
    }

    case 'get_workflow': {
      if (!args.id) throw new Error('id is required');
      const db = getDb('workflows');
      const wf = await db.findOneAsync({ $or: [{ id: args.id }, { _id: args.id }] });
      if (!wf) throw new Error(`Workflow not found: ${args.id}`);
      return wf;
    }

    case 'list_connections':
      return helpers.connections.map(summarizeConnection);

    case 'get_connection': {
      if (!args.id) throw new Error('id is required');
      const c = helpers.connections.find((x) => (x.id || x._id) === args.id || x.name === args.id);
      if (!c) throw new Error(`Connection not found: ${args.id}`);
      const { dbConfig, ...safe } = c;
      // Strip anything secret-shaped from the public config preview.
      const safeConfig = {};
      for (const [k, v] of Object.entries(dbConfig || {})) {
        if (/(password|secret|token|key)/i.test(k)) continue;
        safeConfig[k] = v;
      }
      return { ...safe, dbConfig: safeConfig };
    }

    case 'list_executions': {
      const db = getDb('executions');
      const limit = Math.min(Number(args.limit) || 20, 50);
      let cursor = db.findAsync(args.workflowId ? { workflowId: args.workflowId } : {})
        .sort({ startedAt: -1, createdAt: -1 });
      cursor = cursor.limit(limit);
      const rows = await cursor;
      return rows.map(summarizeExecution);
    }

    case 'get_execution': {
      if (!args.id) throw new Error('id is required');
      const db = getDb('executions');
      const ex = await db.findOneAsync({
        $or: [{ executionId: args.id }, { id: args.id }, { _id: args.id }],
      });
      if (!ex) throw new Error(`Execution not found: ${args.id}`);
      return ex;
    }

    case 'get_tables': {
      if (!args.connection) throw new Error('connection is required');
      return await helpers.getTables(args.connection);
    }

    case 'get_columns': {
      if (!args.connection || !args.table) throw new Error('connection and table are required');
      return await helpers.getColumns(args.connection, args.table, args.schema || null);
    }

    case 'run_query': {
      if (!args.connection || args.query == null) {
        throw new Error('connection and query are required');
      }
      const limit = Math.min(Number(args.limit) || MAX_QUERY_ROWS, MAX_QUERY_ROWS);
      const queryArg = typeof args.query === 'string' ? args.query : args.query;
      const rows = await helpers.runQuery(args.connection, queryArg);
      const arr = Array.isArray(rows) ? rows : (rows?.rows || rows?.data || []);
      return { rowCount: arr.length, rows: arr.slice(0, limit) };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Pull the first balanced {...} object out of `s`, ignoring braces inside
 * string literals. Models sometimes emit a second hallucinated turn after the
 * first; we only ever want the first one.
 */
function extractFirstJsonObject(s) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseModelJson(raw) {
  if (!raw) throw new Error('Empty model response');
  let s = raw.trim();
  // The provider helpers strip ```json fences in most cases, but be defensive.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1].trim();
  const first = extractFirstJsonObject(s);
  if (first) s = first;
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error(`Model returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

/**
 * Build a compact snapshot of the workspace so the model can reason about it
 * without spending a tool call per simple question. Heavy fields (full nodes,
 * full execution logs, secrets) are intentionally excluded.
 */
async function buildSnapshot(getDb, helpers) {
  const wfDb = getDb('workflows');
  const exDb = getDb('executions');

  const [workflows, recentExecs] = await Promise.all([
    wfDb.findAsync({}).then((r) => r.map(summarizeWorkflow)),
    exDb.findAsync({}).sort({ startedAt: -1, createdAt: -1 }).limit(10)
      .then((r) => r.map(summarizeExecution)),
  ]);

  return {
    workflowCount: workflows.length,
    workflows: workflows.slice(0, 25),
    connectionCount: helpers.connections.length,
    connections: helpers.connections.slice(0, 25).map(summarizeConnection),
    recentExecutions: recentExecs,
  };
}

function formatContext(activeContext) {
  if (!activeContext || !activeContext.kind) return null;
  const { kind, id, name, summary } = activeContext;
  const lines = [
    `Kind:    ${kind}`,
    id   ? `Id:      ${id}`   : null,
    name ? `Name:    ${name}` : null,
    summary ? `Summary: ${trimText(summary, 1200)}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Format the running scratchpad — every prior step the agent has taken in
 * this question, and what each tool returned. We hand this back to the model
 * so it can decide what to do next.
 */
function formatScratchpad(scratchpad) {
  if (!Array.isArray(scratchpad) || scratchpad.length === 0) return '';
  const lines = [];
  for (const step of scratchpad) {
    lines.push(`\n[step ${step.index}] thought: ${step.thought || '(none)'}`);
    if (Array.isArray(step.actions)) {
      step.actions.forEach((a, i) => {
        const argsStr = trimText(a.args, 10000);
        const obs = a.error
          ? `ERROR: ${a.error}`
          : trimText(a.result, MAX_FIELD_CHARS);
        lines.push(`  action ${step.index}.${i + 1}: ${a.tool}(${argsStr})\n    observation: ${obs}`);
      });
    }
  }
  return lines.join('\n');
}

/**
 * Public entry point — invoked from the chat:step IPC handler.
 *
 * @param {Object}   params
 * @param {string}   params.message         The user's original message for this question.
 * @param {Array}    [params.history]       Prior cross-turn chat: [{ role, text }].
 * @param {Array}    [params.scratchpad]    Steps already taken THIS question:
 *                                          [{ index, thought, actions: [{tool,args,result|error}] }]
 * @param {Object}   [params.activeContext] What the user is currently focused on.
 * @param {string}   [params.provider]      Override AI provider.
 * @param {Function} params.getDb           From electron.js — getDb(collection).
 * @param {Object}   params.helpers         From buildSkillHelpers() in electron.js.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   done:    boolean,
 *   thought: string,
 *   actions: Array<{ tool, args, ok, error?, result? }>,
 *   finalAnswer: string|null,
 *   step:    object,         // entry to append to scratchpad for the next call
 * }>}
 */
async function runStep({
  message,
  history = [],
  scratchpad = [],
  activeContext = null,
  provider,
  getDb,
  helpers,
}) {
  if (!message || !message.trim()) throw new Error('message is required');
  if (!helpers || typeof helpers.callAI !== 'function') {
    throw new Error('helpers (with callAI) is required');
  }
  if (typeof getDb !== 'function') throw new Error('getDb is required');

  const docIndex = listDocFiles();
  const readme = safeReadFile(path.join(DOCS_ROOT, 'README.md')) || '(README missing)';
  const snapshot = await buildSnapshot(getDb, helpers);
  const contextSummary = formatContext(activeContext);

  const systemPrompt = buildSystemPrompt({
    docIndex, readme, contextSummary, snapshot, maxActions: MAX_ACTIONS_PER_STEP,
  });
  console.log('!!!!!systemPrompt: ', docIndex, readme, contextSummary, snapshot)
  // Cross-turn chat history (prior questions and answers, NOT this question's
  // intermediate steps — those live in the scratchpad).
  const chatHistory = (history || []).map((h) => ({
    sender: h.role === 'assistant' ? 'assistant' : 'user',
    text: h.text || h.content || '',
  }));

  const stepIndex = scratchpad.length + 1;
  const scratchText = formatScratchpad(scratchpad);
  const turnPrompt = scratchText
    ? `User question: ${message}\n\nWork done so far:${scratchText}\n\nReply with the next single JSON object (more actions, or finalAnswer).`
    : `User question: ${message}\n\nReply with a single JSON object — either { thought, actions:[...] } or { thought, finalAnswer }.`;

  let raw;
  try {
    raw = await helpers.callAI(turnPrompt, {
      systemPrompt,
      chatHistory,
      provider,
      maxTokens: 1500,
    });
  } catch (err) {
    throw new Error(`AI call failed on step ${stepIndex}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = parseModelJson(raw);
  } catch (err) {
    return {
      success: true,
      done: false,
      thought: `Model produced invalid JSON; will retry. (${err.message})`,
      actions: [],
      finalAnswer: null,
      step: {
        index: stepIndex,
        thought: '(parse error)',
        actions: [{ tool: 'invalid', args: {}, ok: false, error: err.message }],
      },
    };
  }
  console.log('!!!!!response_raw: ', raw)
  const thought = String(parsed.thought || '').trim();

  // Branch B — final answer.
  if (parsed.finalAnswer) {
    const finalAnswer = String(parsed.finalAnswer).trim();
    return {
      success: true,
      done: true,
      thought,
      actions: [],
      finalAnswer,
      step: { index: stepIndex, thought, actions: [], finalAnswer },
    };
  }

  // Branch A — one or more tool calls.
  let actions = parsed.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return {
      success: true,
      done: false,
      thought: thought || 'Model returned no actions and no finalAnswer; will retry.',
      actions: [],
      finalAnswer: null,
      step: {
        index: stepIndex,
        thought,
        actions: [{ tool: 'invalid', args: {}, ok: false, error: 'no actions and no finalAnswer' }],
      },
    };
  }

  if (actions.length > MAX_ACTIONS_PER_STEP) actions = actions.slice(0, MAX_ACTIONS_PER_STEP);

  // Run each action sequentially. Independent actions in parallel would be
  // marginally faster but harder to reason about when one fails.
  const executed = [];
  for (const a of actions) {
    const tool = a.tool;
    const args = a.args || {};
    try {
      const result = await runTool(tool, args, { helpers, getDb, docIndex });
      executed.push({ tool, args, ok: true, result });
    } catch (err) {
      executed.push({ tool, args, ok: false, error: err.message || String(err) });
    }
  }

  return {
    success: true,
    done: false,
    thought,
    actions: executed,
    finalAnswer: null,
    step: { index: stepIndex, thought, actions: executed },
  };
}

module.exports = {
  runStep,
};
