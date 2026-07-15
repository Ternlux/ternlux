/**
 * Ternlux Chat Assistant — two-agent architecture.
 *
 * The chat runs one turn at a time; the renderer drives the loop by calling
 * `chat:step` repeatedly with an accumulating `scratchpad`. Each turn picks
 * exactly one of two system prompts based on `agentMode`:
 *
 *   - 'main'     → general-purpose Ternlux helper. Slim system prompt, no
 *                  workflow-builder internals. Its only workflow tool is
 *                  `plan_workflow_build`, which is a TRIGGER: it records
 *                  the user's request + workflowId on a `workflowSession`
 *                  and flips `agentMode` to 'workflow' for the next turn.
 *
 *   - 'workflow' → focused workflow-builder sub-agent. Owns the docs
 *                  bundle (docs/nodes/* + docs/chat-prompts/*), gathers
 *                  clarifications, and calls `propose_plan` (which is the
 *                  real planBuild). On accept / off-topic, it calls
 *                  `exit_workflow_mode` to hand control back to 'main'.
 *
 * Mode + session state lives in the renderer (per conversation). Each
 * `chat:step` response carries `nextAgentMode` and `workflowSession`; the
 * renderer persists them and sends them on the next call. This is also
 * what lets the renderer trigger an immediate follow-up turn after a
 * mode flip (no extra user input required).
 */

const fs = require('fs');
const path = require('path');
const workflowBuilder = require('./workflowBuilder');

const DOCS_ROOT = path.join(__dirname, '..', 'docs');
const MAX_FIELD_CHARS = 10000;
const MAX_QUERY_ROWS = 50;
const MAX_ACTIONS_PER_STEP = 5;
// Above this JSON size, get_workflow returns an ultra-slim outline of the
// nodes (id + type + one-line description). The AI is told to call
// get_workflow_nodes for full detail on specific node ids.
const MAX_WORKFLOW_PROMPT_CHARS = 20000;

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

// Walk the chat history and pull out every workflow-builder clarification
// Q/A pair. The renderer flags assistant messages that were clarification
// questions with `clarification: true`; the immediately-following user
// message is taken as the answer. This is the single source of truth for
// gathered clarifications — there is no separate session field.
function clarificationsFromHistory(history) {
  const out = [];
  if (!Array.isArray(history)) return out;
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i];
    const b = history[i + 1];
    const isClarification =
      a && a.role === 'assistant' && a.clarification === true && typeof a.text === 'string';
    if (isClarification && b && b.role === 'user' && typeof b.text === 'string') {
      out.push({ question: a.text.trim(), answer: b.text.trim() });
    }
  }
  return out;
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
  const out = {
    id,
    name: c.name,
    dbType: c.dbType,
    dbCategory: c.dbCategory || null,
    connectionType: c.connectionType || null,
  };
  // For imported-file connections (sqlite/nedb/lancedb), the table/collection
  // name usually does NOT match the connection name — e.g. a spreadsheet
  // imported as "orders" lands in a table called "orders_Sheet1", and several
  // imports share one app-wide SQLite db. Surface the owned table names so the
  // AI queries the right table instead of guessing the connection name and
  // hitting "no such table".
  const tables = Array.isArray(c.fileInfo?.tables)
    ? c.fileInfo.tables.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
    : null;
  if (tables && tables.length) out.tables = tables;
  return out;
}

// One-line description per node — used when the slimmed workflow is too
// large for the prompt. Picks the few config fields that identify what
// the node does, so the AI can decide which node ids to drill into via
// get_workflow_nodes.
function nodeOutline(node) {
  const id    = node?.id || null;
  const type  = node?.type || node?.data?.type || null;
  const label = node?.data?.label || null;
  const cfg   = node?.data?.config || {};
  const out   = { id, type, label };
  switch (type) {
    case 'start':
      out.triggerType = cfg.triggerType || null;
      if (cfg.description) out.description = cfg.description;
      break;
    case 'dataSource':
      out.connection = cfg.sourceConnectionName || null;
      out.source     = cfg.sourceTable || cfg.sourceCollection || null;
      if (cfg.sourceQueryDescription) out.description = cfg.sourceQueryDescription;
      break;
    case 'transformer':
      out.operationType    = cfg.operationType || null;
      out.targetConnection = cfg.targetConnectionName || null;
      out.target           = cfg.targetTable || cfg.targetCollection || null;
      out.description      = String(cfg.transformationRequest || cfg.builderPrompt || cfg.targetSqlExplanation || '').slice(0, 400) || null;
      break;
    case 'join':
      out.joinType         = cfg.joinType || null;
      out.targetConnection = cfg.targetConnectionName || null;
      out.target           = cfg.targetTableName || cfg.targetTable || cfg.targetCollection || null;
      out.description      = String(cfg.builderPrompt || cfg.targetSqlExplanation || '').slice(0, 400) || null;
      break;
    case 'output':
      out.outputType = cfg.outputType || null;
      out.target     = cfg.targetTable || cfg.targetCollection || cfg.savePath || null;
      out.format     = cfg.format || null;
      break;
    default:
      if (cfg.builderPrompt) out.description = String(cfg.builderPrompt).slice(0, 400);
  }
  return out;
}

function ultraSlimWorkflow(slim) {
  if (!slim || typeof slim !== 'object') return slim;
  const nodes = Array.isArray(slim.nodes) ? slim.nodes : [];
  const edges = Array.isArray(slim.edges) ? slim.edges : [];
  return {
    id:    slim.id || null,
    name:  slim.name || null,
    nodes: nodes.map(nodeOutline),
    edges,
    _trimmed:   true,
    _trimNote:  'This workflow exceeded the prompt size budget. Only node outlines (id, type, one-line description) are shown. Call get_workflow_nodes { workflowId, nodeIds: [...] } to fetch full config for specific node ids.',
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

// ---------------------------------------------------------------------------
// System prompts — one per mode.
// ---------------------------------------------------------------------------

/**
 * Main agent — slim. Knows about workflows, connections, executions, and
 * how to run queries. The ONLY thing it knows about building workflows is
 * that calling `plan_workflow_build` hands the conversation to the
 * workflow-builder sub-agent. No node-type rules, no chat-prompt rules.
 */
function buildMainSystemPrompt({ docIndex, readme, contextSummary, snapshot, systemContext, maxActions }) {
  return `You are the Ternlux Assistant — an in-app helper that answers questions about the
user's data workflows, saved connections, and execution history, and can run queries
against those connections to fetch live data.

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
  "finalAnswer": "<answer in markdown>",
  "visuals": [ ... ]   // OPTIONAL — see "Visuals" below; omit when nothing is worth charting
}

# Visuals (optional, only with a finalAnswer)

When a tool result (e.g. run_query rows) would be clearer as a chart, add a
"visuals" array to your finalAnswer. Each visual is ONE of these two shapes —
no aggregation, grouping, sorting, or filtering is applied; the rows are charted
exactly as they are:

  // Bind to a prior action's result and pick two columns:
  { "type": "bar", "title": "Revenue by city", "source": "3.1", "x": "city", "y": "revenue" }

  // OR provide small data you already have, pre-shaped as { x, y }:
  { "type": "pie", "title": "Status split", "dataset": [ { "x": "open", "y": 12 }, { "x": "closed", "y": 30 } ] }

Rules:
- type ∈ { bar, line, pie, scatter, kpi, table }.
- "source" is "<step>.<action>" — the index shown in the scratchpad, e.g. the
  result labelled "action 3.1" is source "3.1". With "source" you MUST give the
  "x" and "y" COLUMN NAMES exactly as they appear in that result's rows.
- "dataset" is an inline array of { "x": <label>, "y": <number> } objects.
- Provide EITHER "source" (+ x + y) OR "dataset" — never both.
- "kpi" shows one or more headline numbers: dataset of { x: label, y: number }.
- "table" shows the data as-is (use "source" with no x/y, or a "dataset"). It
  handles BOTH structured rows (a grid) AND unstructured/JSON results such as a
  single document or nested object (shown as formatted JSON) — so it's the safe
  choice for any result that isn't a clean set of {x,y} points.
- At most 3 visuals. Omit "visuals" entirely when a chart adds nothing.

When you batch actions, only batch tools whose results don't depend on each other
(e.g. "list_workflows" + "list_connections" together). If action B depends on the
result of action A, run A this turn and B next turn.

# Tool catalogue

- list_docs                  → { sections: [...] }            // already loaded below
- read_doc { path }          → markdown contents              // path relative to /docs
- list_workflows             → [{ id, name, type, nodeCount, ... }]
- get_workflow { id }        → slimmed workflow (nodes + edges; chat history
                              removed; sampleData truncated to 1 row).
                              If the workflow is large the result is an
                              outline only — each node shows id, type, and a
                              one-line description, with \`_trimmed: true\`.
                              Use get_workflow_nodes for full config.
- get_workflow_nodes { workflowId, nodeIds: [ ... ] }
                              → full slimmed config for the listed node ids
                              from one workflow. Use this after a trimmed
                              get_workflow to drill into the nodes that
                              matter for your question. Pass only the ids
                              you actually need — every extra id costs
                              tokens.
- list_connections           → [{ id, name, dbType, dbCategory, connectionType, tables? }]
- get_connection { id }      → connection metadata (no secrets)
- list_executions { limit?, workflowId? } → recent execution summaries
- get_execution { id }       → full execution doc with logs
- get_tables { connection }  → list tables/collections in a saved connection
- get_columns { connection, table, schema? } → list columns
- run_query { connection, query, limit? }   → rows from the connection
       • READ-ONLY. This tool ONLY runs read queries (SQL SELECT / WITH ... SELECT /
         SHOW / EXPLAIN / DESCRIBE; MongoDB find / count / aggregate without
         $out|$merge; vector query / fetch). Every query is checked and any
         data-modifying query (INSERT / UPDATE / DELETE / DROP / CREATE / ALTER /
         TRUNCATE / MERGE / upsert, etc.) is BLOCKED. You are in analysis mode.
       • If the user wants to CHANGE data (insert/update/delete/create/transform a
         table or collection), do NOT attempt it here — it cannot work. Hand off
         with plan_workflow_build and let them build/run a workflow instead.
       • For SQL connectors, query is a SQL string.
       • For MongoDB / NeDB, query is a JSON object the connector understands.
       • IMPORTANT: the table name is NOT the connection name. For imported-file
         connections the real table is in the connection's "tables" field (shown
         in the snapshot / list_connections) — e.g. a connection named "orders"
         may hold a table "orders_Sheet1". Use that exact name in your SQL. If
         "tables" is absent or you're unsure, call get_tables first instead of
         guessing.
       • Capped at ${MAX_QUERY_ROWS} rows per call. Add LIMIT in your SQL too.
       • Big-result safety: tool results are truncated in the scratchpad past
         ~${MAX_FIELD_CHARS} chars, so you may not see the tail of a wide
         result. BEFORE running a broad SELECT / find that could return a
         large or wide result, FIRST run a count query so you know the
         scale and can pick a sensible filter or LIMIT:
           – SQL:    SELECT COUNT(*) AS n FROM <table> WHERE <filter>
           – Mongo:  { "collection": "<c>", "filter": {...}, "operation": "count" }
                    or an aggregate with { "$count": "n" }
         If the count is large, narrow the filter or project specific
         columns; don't bulk-pull rows the chat won't be able to read.

- http_request { url, method?, params?, headers?, data?, timeout? }
       → { status, statusText, headers, data }
       Make an outbound HTTP request to an external API/endpoint with axios.
       Use this when the user asks to call a URL / hit a REST API / fetch from
       an endpoint. \`method\` defaults to GET; \`params\` are query-string
       params; \`data\` is the request body for POST/PUT/PATCH (pass a JSON
       object). Non-2xx responses are RETURNED (not errored) so you can read
       the status and body and react. Only send auth headers the user has
       explicitly provided — never invent or guess tokens/keys. Large response
       bodies are truncated in the scratchpad, so request narrowly when you can.

- run_javascript { request, source? }
       → { ran, explanation, recordCount, rows, transformFunction }
       Generate AND run a one-off async JavaScript function for logic that
       run_query / http_request can't express on their own — calling an AI
       model per row, generating embeddings, orchestrating several connections
       or HTTP calls, or custom shaping. \`request\` describes IN PLAIN ENGLISH
       what the function must do. Optional \`source\` = { connection, table }
       loads that table's rows as the function's \`records\` input; omit it to
       start from an empty array and have the function fetch everything itself
       (e.g. via ctx.runQuery / ctx.axios). The function runs with ctx helpers
       (runQuery, askAi, vectorize, axios, getTables, getColumns, log) and its
       returned array comes back as \`rows\` (capped at ${MAX_QUERY_ROWS}); you
       can chart it via "visuals". This does NOT save anything — it computes an
       answer to show the user. To build a SAVED transformer node instead, use
       plan_workflow_build. If \`ran\` is false the generator needs clarification
       (see \`questionsNeeded\`) — ask the user rather than retrying blindly.

- plan_workflow_build { request, workflowId? }
       Trigger — DO NOT use for anything else. Call this when the user
       wants to CREATE or MODIFY a workflow. The workflow-builder
       sub-agent takes over from the NEXT turn onward; you will not see
       the conversation again until the sub-agent finishes or the user
       changes topic.
       Call it EXACTLY ONCE, and ALONE — never batch plan_workflow_build
       in the same actions array as another tool (e.g. get_workflow), and
       never call it twice for the same request. If you still need a tool
       result first (such as get_workflow to confirm the target), run that
       tool THIS turn and call plan_workflow_build on the NEXT turn once
       you have the result. The turn you do call it, use Schema A with
       EXACTLY ONE action — the plan_workflow_build call — and put your
       hand-off acknowledgement in "thought" (it is shown to the user).
       Do NOT use Schema B / finalAnswer on this turn: a finalAnswer ends
       the turn WITHOUT running any tool, so the build would never start
       and the sub-agent would never take over. The sub-agent answers the
       user from the next turn onward.
         • \`request\` — you don't need to copy the user's request verbatim;
           a short description is enough; the full message is passed through
           automatically (including literal values like URLs, request bodies,
           tokens, and keys), plus any context clarified in main-mode beforehand.
         • \`workflowId\` is only set for modify intent. Pick the
           workflow the user clearly means by name. When ambiguous, ask
           one short clarifying question (a Schema-B finalAnswer)
           BEFORE calling plan_workflow_build, so the sub-agent doesn't
           start without knowing which workflow.

${contextSummary ? '# Context the user is currently looking at' : ''}
${contextSummary ? contextSummary : ''}

# System & file-path context
This is the user's actual machine and Ternlux's on-disk layout. Use it to
understand and reference real file paths — interpret relative paths against the
home directory, write absolute paths with the right separator for this OS, and
know where local data and exports live.

${systemContext}

# Snapshot of the workspace

${typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2)}

# Doc index (use read_doc to fetch any of these)

${docIndex.map((p) => `- ${p}`).join('\n')}

# Top-level overview (public/docs/README.md)

${readme}

# Rules
- Output ONLY the single JSON object. No prose, no backticks, no second turn.
- If a tool errors, read the error, then either retry with corrected args or
  switch tools next turn. Do not repeat the same failing call.
- Never claim to have done something you did not actually do via a tool.
- For workflow create/modify requests, your job ends at calling
  plan_workflow_build — do NOT try to design the workflow yourself.
- To hand off to the workflow builder you MUST emit the plan_workflow_build
  ACTION (Schema A). A Schema-B finalAnswer that merely says you're handing
  off does NOT trigger the hand-off — no tool runs, so the builder never
  starts. Put any "starting the builder…" wording in "thought", not in a
  finalAnswer.
- Keep "thought" short (≤ 20 words) — it is shown live to the user.
- Keep final answers concise; lead with the headline number/finding.`;
}

/**
 * Workflow sub-agent — focused. Loaded into the conversation after the
 * main agent calls plan_workflow_build. Owns the docs bundle and the
 * clarification loop. Releases control with exit_workflow_mode.
 */
function buildWorkflowSystemPrompt({
  nodeDocs, chatPromptDocs, connections, workflowSummary, workflowSession, systemContext, maxActions,
  transformerSkills = [], joinSkills = [],
}) {
  const renderSkillList = (skills) => {
    if (!Array.isArray(skills) || skills.length === 0) return '  (none registered)';
    return skills.map((s) => {
      const desc = s.description?.description || '';
      const caps = Array.isArray(s.description?.capabilities) ? s.description.capabilities : [];
      const capLines = caps.map((c) => `      - ${c}`).join('\n');
      return `  - ${s.name} (id: ${s.id})\n    ${desc}${caps.length ? `\n    Capabilities:\n${capLines}` : ''}`;
    }).join('\n');
  };
  return `You are the Ternlux Workflow Builder — a focused sub-agent. The main assistant
routed this conversation to you because the user wants to CREATE or MODIFY a workflow.
Your job is to gather the missing details, then ask the planner to produce a concrete
plan that the user will accept or cancel. After the user accepts the plan OR pivots to
a topic that is not about this workflow build, hand control back to the main assistant
by calling \`exit_workflow_mode\`.

You reply with a SINGLE JSON object per turn — nothing else. Schemas:

A) Run one or more tools:
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

# Active workflow session

Original request : ${JSON.stringify(workflowSession?.request || '')}
${workflowSession?.workflowId
  ? `Open workflow    : ${workflowSession.workflowId} — the workflow the user had open when this build started (its slimmed nodes are shown below under "Existing workflow"). Being open does NOT mean the user wants to change it.`
  : 'Open workflow    : (none — the user was not viewing a specific workflow)'}

# Decide: modify an existing workflow, or build a new one
Every propose_plan call carries a fresh \`request\` (a short description of what
the user wants built NOW — see the tool catalogue). ALSO decide the target:
  - MODIFY an existing workflow → propose_plan { "request": "...", "workflowId": "<id>" }.
    Usually that's the open workflow above, but the user may mean a different
    one — use list_workflows / get_workflow to find and confirm it.
  - Build a NEW workflow → propose_plan { "request": "...", "newWorkflow": true }.
Choose NEW when the request describes a self-contained pipeline that doesn't
refer back to an existing workflow; choose MODIFY when it changes / adds to /
removes from / fixes a specific existing workflow. Watch for mid-chat pivots:
if the user first asked to modify but now says "make it a new workflow", honor
the LATEST intent. If you can't tell, ask one short clarifying question before
calling propose_plan.

# Clarifications

Prior clarifying questions you've asked, AND the user's answers, live in the
CHAT HISTORY (not in this system prompt). Every assistant message starting
with "Clarifying question:" is one of your prior questions, immediately
followed by the user's reply. Treat those as authoritative — do NOT re-ask
anything already answered there. If you don't see any "Clarifying question:"
messages in history, none have been asked yet.

${workflowSummary ? `# Existing workflow (slimmed)\n${JSON.stringify(workflowSummary, null, 2)}\n` : ''}

# Available connections (the only ones you may reference; pick by NAME)
${JSON.stringify(connections, null, 2)}

# System & file-path context
This is the user's actual machine and Ternlux's on-disk layout. When the build
involves a local file (an export destination, a local collection, a SQLite/
LanceDB target, or a path the user names), reason about it against THIS layout:
resolve relative paths from the home directory, write absolute paths with the
right separator for this OS, and default exports to the Downloads folder when
the user doesn't give a path. These are the same deterministic locations the
planner records as targetLocalPath, so the paths you describe to the user match
what actually gets written.

${systemContext}

# Tool catalogue

Information-gathering (use freely to confirm columns, sample data, etc.):
- list_connections           → connections summary
- get_connection { id }      → public config (no secrets)
- get_tables { connection }  → tables/collections in a saved connection
- get_columns { connection, table, schema? } → columns
- run_query { connection, query, limit? } → sample rows (cap ${MAX_QUERY_ROWS}).
                              READ-ONLY: only SELECT-style reads run; data-modifying
                              queries are blocked. Writes happen when the built
                              workflow executes, never through this tool.
- list_workflows             → [{ id, name, type, nodeCount, ... }]. Use to find
                              which existing workflow the user means (or confirm
                              the request is a brand-new one).
- get_workflow { id }        → slim view of an existing workflow.
                              Large workflows come back as an outline
                              (id + type + one-line description per node)
                              with \`_trimmed: true\`.
- get_workflow_nodes { workflowId, nodeIds: [...] }
                              → full slimmed config for the listed node
                              ids. Use after a trimmed get_workflow.

Plan generation:
- propose_plan { request, workflowId?, newWorkflow? }
       Submit the build to the workflow planner.
       • request (REQUIRED): a short, self-contained description of the
         workflow the user CURRENTLY wants, synthesized from the latest
         conversation. Write THIS fresh every time — do NOT assume the planner
         remembers the original ask. If the user changed their mind mid-chat
         (e.g. started wanting JSON, now wants a new workflow exporting CSV),
         describe what they want NOW, not what they first said. Name the
         connections, tables, join keys, destination, and format concretely.
         (Plain text — no backticks or code fences.)
         You don't need to copy the user's request verbatim — a short
         description is enough; the full message is passed through
         automatically.
       • workflowId (optional): MODIFY that existing workflow (the planner
         produces the complete target step list for it).
       • newWorkflow (optional): true → build a brand-NEW, separate workflow.
       If you pass neither workflowId nor newWorkflow, it defaults to the open
       workflow when one was open (modify), else a new workflow — prefer being
       explicit so an open workflow is never modified by accident.
       The runtime reads every clarification Q/A (including the user's latest
       answer) from the chat history automatically — you do NOT pass those in.
       Calling propose_plan ends this turn: the backend short-circuits
       the user-facing answer with the planner's output, so you do NOT
       need a second turn to relay anything.
         • If the planner needs more info it surfaces the follow-up
           question directly to the user. The user's next message is
           the answer; on the turn after that, call propose_plan again.
         • If the planner returns a finished plan the renderer shows
           an Accept / Cancel card built from the plan envelope. This is
           a FULL STOP for you: you do NOT apply the plan — proposing is
           NOT applying. Only the user's Accept click applies it, on a
           LATER turn. So once propose_plan returns a plan, emit NOTHING
           else: do NOT call exit_workflow_mode, do NOT call propose_plan
           again, do NOT re-handoff. Just wait. You will be re-entered on
           the user's next message; only THEN — after Accept / Cancel /
           topic-pivot — call exit_workflow_mode.

Session control:
- exit_workflow_mode { reason }
       End the workflow session and hand control back to the main
       assistant. Call this when:
         • The plan has been accepted (renderer auto-builds), OR
         • The user explicitly cancels the build, OR
         • The user pivots to a topic that is not about this
           workflow build (asking about other workflows, executions,
           data, etc. — anything the main assistant should answer).
       Always emit a short finalAnswer with this action that
       summarises why you're handing back.

# Per-node-type requirements (gather these before calling propose_plan)

When the planner builds steps, each per-node builder runs the SAME chat-prompt
templates documented below — so anything that template's chat panel would
have asked the user, you should know the answer to BEFORE you call
propose_plan. Missing fields make the per-node builder fall back to
defaults that may be wrong.

## start
- triggerType ∈ {manual, time, file}.
  • time: cadence in plain English ("every Monday at 9:30 am").
  • file: absolute path + type (file|directory) + ≥1 event from
    {add, change, unlink, addDir, changeDir, unlinkDir}.
  • manual: no extra detail.

## dataSource
- Saved connection (by name) AND, depending on the connection:
  • Database / vector DB → which table or collection / index (+ namespace
    for Pinecone).
  • REST API → endpoint + pagination intent (auth is injected at runtime
    — NEVER mention tokens/keys).
  • Cloud storage (GCS / S3 / Dropbox / Google Drive) OR Google Sheets →
    chat CAN'T configure these (picking the bucket/object/sheet needs the
    editor's native picker). Don't propose_plan such a data source; if the
    pipeline needs one, tell the user to add and configure that node in the
    editor first, then chat builds the transformers / joins that read from
    its locally-materialised data — at run time it lands as SQLite (tabular)
    or NeDB (JSON). (Cloud storage can't import vector/LanceDB files.)
  • Imported file → just the connection name.

## transformer (1 upstream source)
- The transformation logic in concrete terms (which columns, what shape).
- operationMode: new_table (default, reversible) | in_place (mutates source).
- storageLocation (only when operationMode='new_table' AND source is remote):
  database | local. local forces new_table.
- Optional custom target name.
- Vector / embedding intent: a transformer can only embed/vectorise a column
  into a vector table, or maintain a vector store's own records in place
  (update/delete/tag). Matching rows to OTHER rows by similarity ("for each
  row find the top-K most similar", recommendations, semantic join) is a JOIN,
  not a transformer — even against the same vector table (a self-join).
- Available transformer skills (the analyzer may route a transformer
  through one of these instead of plain SQL/NoSQL; mention any of these
  by name in the user request to nudge it):
${renderSkillList(transformerSkills)}

## join (≥ 2 upstream sources)
- Use a join for ALL similarity matching, including vector-based and
  self-joins (the same vector table searched against itself → list it as
  two sources).
- For EVERY pair: the join key columns and the join type
  (INNER | LEFT | RIGHT | FULL — never inferred from name similarity).
- selectedColumns per source.
- Destination connection OR local-sqlite / local-nedb.
- targetTableName.
- Vector scenario: A (treat vector DB as regular DB, join on a plain key) vs
  B (similarity search drives the join — "for each row find top-K similar",
  optionally constrained by a metadata field). Read user intent literally —
  a vector source on its own does NOT imply Scenario B.
- Available join skills (the analyzer may route a join through one of
  these instead of plain SQL/NoSQL):
${renderSkillList(joinSkills)}

## output (1 upstream source)
- outputType ∈ {connection, local}.
  • connection: connection name + target table/collection. Cloud-storage
    destinations are MANUAL-ONLY — don't propose one; tell the user to add
    and configure the cloud-storage output node in the editor instead.
  • local: format ∈ {json, csv, excel, nedb, sqlite, lancedb, parquet, avro}
    + absolute savePath.

# Working pattern

1. Read the original request + clarifications above. Identify the FIRST
   missing detail (start with connection / table for sources, work toward
   the destination).
2. Ask exactly ONE short, specific question per turn as a Schema-B
   finalAnswer. Mention the connection / table / column names you
   already know so the user can answer quickly. The runtime tags your
   message as a clarification automatically.
3. When the user answers, call propose_plan with a fresh \`request\`
   (synthesized from the whole conversation so far) plus the target
   (workflowId or newWorkflow). The runtime folds the user's latest
   answer into the clarification history, runs the planner, and
   surfaces either its next follow-up or the finished plan to the user.
4. When propose_plan returns a finished plan, STOP — the Accept / Cancel
   card is now the user's to act on, and you cannot apply it yourself.
   Do not call exit_workflow_mode here; do not re-propose. Wait for the
   user's next message.
5. On that NEXT user turn — after Accept / Cancel / topic pivot — call
   exit_workflow_mode with a one-line reason.

# Node reference docs (public/docs/nodes/*.md)

${nodeDocs || '(no node docs available)'}

# Chat-prompt reference docs (public/docs/chat-prompts/*.md)

${chatPromptDocs || '(no chat-prompt docs available)'}

# Rules
- Output ONLY the single JSON object. No prose, no backticks, no second turn.
- Stay focused on building this workflow. If the user pivots away, call
  exit_workflow_mode immediately — do not try to answer non-workflow
  questions from here.
- Never include credentials, tokens, API keys, or passwords in your
  outputs. Connections own those server-side.
- Never invent connection ids — refer to connections by their name.
- Never invent column names — if you don't know them, ask.
- Keep "thought" short (≤ 20 words) — it is shown live to the user.`;
}

// ---------------------------------------------------------------------------
// Tools — split by agent mode.
// ---------------------------------------------------------------------------

// ── Read-only guard for the chat `run_query` tool ───────────────────────────
// The chat assistant runs in ANALYSIS mode and must never mutate a user's
// data. "Read-only" can NOT be assumed from the store type — every connector's
// runQuery entry point can also write (SQL: any statement; MongoDB: drop /
// insert* / aggregate $out|$merge; NeDB: insert/update/remove/drop; LanceDB &
// Pinecone: upsert/update/delete). So before any query runs we ask the model
// to classify it and refuse anything that isn't a pure read. To CHANGE data,
// the user must build a workflow (plan_workflow_build), which goes through the
// write-capable executor — never this tool.

// Resolve a connection reference to its dbType, purely to give the classifier
// context (e.g. "this is a Mongo JSON query, not SQL"). Best-effort: returns
// null when it can't be determined.
function resolveDbType(helpers, ref) {
  const LOCAL = new Set(['sqlite', 'nedb', 'lancedb']);
  if (typeof ref === 'string' && LOCAL.has(ref)) return ref;
  try {
    const conn = helpers && typeof helpers.getConnection === 'function' ? helpers.getConnection(ref) : null;
    return conn?.dbType || (ref && typeof ref === 'object' ? ref.dbType : null) || null;
  } catch (_) {
    return (ref && typeof ref === 'object' ? ref.dbType : null) || null;
  }
}

// Ask the model whether `query` is STRICTLY read-only. Returns a boolean and
// fails CLOSED (false) on any error or ambiguous response, so a misfire can
// never let a mutating query through.
async function classifyQueryReadOnly({ helpers, provider, dbType, query }) {
  if (!helpers || typeof helpers.callAI !== 'function') return false;
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);
  const prompt = [
    'You are a database query safety classifier. Decide whether the query below is STRICTLY read-only.',
    '',
    'A query is read-only ONLY IF it cannot create, alter, insert, update, delete, drop, truncate,',
    'merge, replace, upsert, grant, revoke, or write to any table, collection, index, or file —',
    'directly or as a side effect.',
    '',
    'Read-only: SQL SELECT / WITH ... SELECT / SHOW / EXPLAIN / DESCRIBE; MongoDB find / count /',
    'aggregate WITHOUT $out or $merge; vector-store query / fetch.',
    'NOT read-only: any INSERT / UPDATE / DELETE / DROP / CREATE / ALTER / TRUNCATE / MERGE /',
    'REPLACE / GRANT / REVOKE; SELECT ... INTO or INTO OUTFILE; data-modifying CTEs; multiple /',
    'stacked statements where any one writes; MongoDB drop / insert* / update* / delete* / $out /',
    '$merge; vector upsert / update / delete.',
    'If you are unsure, answer false.',
    '',
    `Store type: ${dbType || 'unknown'}`,
    'Query:',
    queryStr,
    '',
    'Respond with ONLY a compact JSON object and nothing else: {"readOnly": true} or {"readOnly": false}.',
  ].join('\n');

  let raw;
  try {
    raw = await helpers.callAI(prompt, { maxTokens: 50, provider });
  } catch (_) {
    return false;
  }
  const text = String(raw || '');
  const m = text.match(/"?readonly"?\s*:\s*(true|false)/i);
  if (m) return m[1].toLowerCase() === 'true';
  // No explicit field — only trust a bare, unambiguous "true".
  if (/\btrue\b/i.test(text) && !/\bfalse\b/i.test(text)) return true;
  return false;
}

// Return a helpers clone whose runQuery is READ-ONLY. The chat assistant hands
// this to AI-generated code (run_javascript) so a generated function can read
// any connection via ctx.runQuery but can NEVER write. This guard lives ONLY
// on the chat path: the workflow EXECUTION path (executeBuild → transformer /
// output nodes) passes the unwrapped helpers and keeps its write capability.
// Identical queries are classified once and cached, so a function that reuses
// the same query in a loop pays the classifier cost only on the first call.
function readOnlyHelpers(helpers, provider) {
  if (!helpers || typeof helpers.runQuery !== 'function') return helpers;
  const cache = new Map();
  const guardedRunQuery = async (connection, query, dbPath = null) => {
    let cacheKey;
    try {
      const connKey = typeof connection === 'string' ? connection : (connection?.name || connection?.id || '');
      cacheKey = JSON.stringify([connKey, query, dbPath]);
    } catch (_) { cacheKey = null; }
    let ok = cacheKey != null && cache.has(cacheKey) ? cache.get(cacheKey) : undefined;
    if (ok === undefined) {
      const dbType = resolveDbType(helpers, connection);
      ok = await classifyQueryReadOnly({ helpers, provider, dbType, query });
      if (cacheKey != null) cache.set(cacheKey, ok);
    }
    if (!ok) {
      throw new Error(
        'ctx.runQuery is read-only here: this query was classified as data-modifying and was blocked. '
        + 'Generated code in analysis mode can READ any connection but cannot write. To change data, build a workflow.',
      );
    }
    return helpers.runQuery(connection, query, dbPath);
  };
  return { ...helpers, runQuery: guardedRunQuery };
}

// Shared tool helpers reused by both agents (read-only lookups).
const SHARED_TOOLS = {
  async list_docs({ docIndex }) {
    return { sections: docIndex };
  },
  async read_doc(_ctx, args) {
    return { path: args.path, content: readDoc(args.path) };
  },
  async list_workflows({ getDb }) {
    const db = getDb('workflows');
    const rows = await db.findAsync({});
    return rows.map(summarizeWorkflow);
  },
  async get_workflow({ getDb }, args) {
    if (!args.id) throw new Error('id is required');
    const db = getDb('workflows');
    const wf = await db.findOneAsync({ $or: [{ id: args.id }, { _id: args.id }] });
    if (!wf) throw new Error(`Workflow not found: ${args.id}`);
    const slim = workflowBuilder.slimWorkflowForPrompt(wf);
    const size = JSON.stringify(slim).length;
    if (size > MAX_WORKFLOW_PROMPT_CHARS) return ultraSlimWorkflow(slim);
    return slim;
  },
  async get_workflow_nodes({ getDb }, args) {
    if (!args.workflowId) throw new Error('workflowId is required');
    if (!Array.isArray(args.nodeIds) || args.nodeIds.length === 0) {
      throw new Error('nodeIds must be a non-empty array');
    }
    const db = getDb('workflows');
    const wf = await db.findOneAsync({ $or: [{ id: args.workflowId }, { _id: args.workflowId }] });
    if (!wf) throw new Error(`Workflow not found: ${args.workflowId}`);
    const slim = workflowBuilder.slimWorkflowForPrompt(wf);
    const wanted = new Set(args.nodeIds.map(String));
    const matched = (slim.nodes || []).filter((n) => wanted.has(String(n.id)));
    const found   = new Set(matched.map((n) => String(n.id)));
    const missing = args.nodeIds.filter((id) => !found.has(String(id)));
    return {
      workflowId: slim.id,
      nodes:      matched,
      missing,
    };
  },
  async list_connections({ helpers }) {
    return helpers.connections.map(summarizeConnection);
  },
  async get_connection({ helpers }, args) {
    if (!args.id) throw new Error('id is required');
    const c = helpers.connections.find((x) => (x.id || x._id) === args.id || x.name === args.id);
    if (!c) throw new Error(`Connection not found: ${args.id}`);
    const { dbConfig, ...safe } = c;
    const safeConfig = {};
    for (const [k, v] of Object.entries(dbConfig || {})) {
      if (/(password|secret|token|key)/i.test(k)) continue;
      safeConfig[k] = v;
    }
    return { ...safe, dbConfig: safeConfig };
  },
  async list_executions({ getDb }, args) {
    const db = getDb('executions');
    const limit = Math.min(Number(args.limit) || 20, 50);
    let cursor = db.findAsync(args.workflowId ? { workflowId: args.workflowId } : {})
      .sort({ startedAt: -1, createdAt: -1 });
    cursor = cursor.limit(limit);
    const rows = await cursor;
    return rows.map(summarizeExecution);
  },
  async get_execution({ getDb }, args) {
    if (!args.id) throw new Error('id is required');
    const db = getDb('executions');
    const ex = await db.findOneAsync({
      $or: [{ executionId: args.id }, { id: args.id }, { _id: args.id }],
    });
    if (!ex) throw new Error(`Execution not found: ${args.id}`);
    return ex;
  },
  async get_tables({ helpers }, args) {
    if (!args.connection) throw new Error('connection is required');
    return await helpers.getTables(args.connection);
  },
  async get_columns({ helpers }, args) {
    if (!args.connection) throw new Error('connection is required');
    let table = args.table;
    if (!table) {
      // Imported-file connections record the tables they own. When the caller
      // omits `table` and the connection owns exactly one, default to it
      // (e.g. "customers" → "customers_Sheet1") instead of hard-failing. With
      // several tables, list them so the model can pick the right one.
      const conn = helpers.connections.find(
        (c) => (c.id || c._id) === args.connection || c.name === args.connection
      );
      const owned = Array.isArray(conn?.fileInfo?.tables)
        ? conn.fileInfo.tables.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
        : [];
      if (owned.length === 1) {
        table = owned[0];
      } else if (owned.length > 1) {
        throw new Error(`table is required; "${args.connection}" has tables: ${owned.join(', ')}`);
      } else {
        throw new Error('table is required (call get_tables to list available tables)');
      }
    }
    return await helpers.getColumns(args.connection, table, args.schema || null);
  },
  async run_query({ helpers, provider }, args) {
    if (!args.connection || args.query == null) {
      throw new Error('connection and query are required');
    }
    // Read-only guard for BOTH agents. Neither the analysis agent nor the
    // workflow-builder sub-agent may mutate data through run_query — the
    // builder only SAMPLES here. The ONLY place writes (INSERT / UPDATE /
    // CREATE / etc.) are allowed is the workflow runtime in
    // NodeExecution/workflowExecutionHelpers.js, which a built workflow runs
    // through — never this tool. Classify the query and refuse anything that
    // isn't a pure read.
    const dbType = resolveDbType(helpers, args.connection);
    const readOnly = await classifyQueryReadOnly({ helpers, provider, dbType, query: args.query });
    if (!readOnly) {
      throw new Error(
        'run_query only runs read-only (SELECT-style) queries. This query was classified as '
        + 'data-modifying and was blocked. Writes only happen when a BUILT workflow executes '
        + '(via NodeExecution), never through run_query — if the user wants to change data, build '
        + 'a workflow with plan_workflow_build.',
      );
    }
    const limit = Math.min(Number(args.limit) || MAX_QUERY_ROWS, MAX_QUERY_ROWS);
    const queryArg = typeof args.query === 'string' ? args.query : args.query;
    const rows = await helpers.runQuery(args.connection, queryArg);
    const arr = Array.isArray(rows) ? rows : (rows?.rows || rows?.data || []);
    return { rowCount: arr.length, rows: arr.slice(0, limit) };
  },
};

// Main-only tools. http_request and run_javascript give the main agent the
// ability to reach external HTTP endpoints and to generate+run a one-off
// JavaScript function (via the javascript-executor skill). Both are
// "act/compute" tools, NOT workflow-builder tools — the workflow sub-agent
// must not have them.
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const MAX_HTTP_TIMEOUT_MS = 60000;

// http_request — arbitrary outbound HTTP via the shared axios bundle. Non-2xx
// responses are returned (not thrown) so the AI can read the status + body and
// decide what to do. The scratchpad formatter trims oversized bodies, so we
// don't cap the payload here beyond axios' own limits.
async function httpRequestTool({ helpers }, args) {
  if (!helpers || typeof helpers.axios !== 'function') {
    throw new Error('HTTP is unavailable (axios not injected)');
  }
  if (!args.url || typeof args.url !== 'string') throw new Error('url is required');
  const method = String(args.method || 'GET').toUpperCase();
  const timeout = Math.min(Number(args.timeout) || DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS);

  const resp = await helpers.axios({
    method,
    url: args.url,
    params: args.params || undefined,
    headers: args.headers || undefined,
    data: args.data !== undefined ? args.data : undefined,
    timeout,
    // Report any status instead of throwing, so the AI sees 4xx/5xx bodies.
    validateStatus: () => true,
  });

  return {
    status: resp.status,
    statusText: resp.statusText || '',
    headers: resp.headers || {},
    data: resp.data,
  };
}

// run_javascript — generate AND run a one-off async transform(records, ctx)
// function using the javascript-executor skill. This drives the skill's
// stage-2 flow directly: buildFunctionPrompt → callAI → runTransformFunction.
// Unlike the skill's transformer node, it does NOT persist anything; the
// function's returned array is handed straight back to the chat so the AI can
// answer / visualise it.
async function runJavascriptTool({ helpers, provider }, args) {
  const request = args && typeof args.request === 'string' ? args.request.trim() : '';
  if (!request) throw new Error('request is required');

  const skill = helpers?.pluginManager?.getSkill?.('javascript-executor');
  if (!skill || typeof skill.buildFunctionPrompt !== 'function'
      || typeof skill.runTransformFunction !== 'function') {
    throw new Error('javascript-executor skill is not available');
  }

  // Optional source table — load its columns + rows so the generated function
  // gets a `records` input and the prompt knows the data shape. When omitted,
  // the function starts from an empty array and fetches what it needs via ctx.
  let sourceConnection = {};
  let sourceTableSchema = {};
  let records = [];
  const source = args.source;
  if (source && source.connection) {
    sourceConnection = helpers.getConnection(source.connection);
    const table = source.table || null;
    let columns = [];
    if (table) {
      try {
        columns = await helpers.getColumns(
          sourceConnection.name || sourceConnection.id,
          table,
          sourceConnection.dbConfig?.schema || null,
        );
      } catch (_err) { /* columns are best-effort context */ }
    }
    sourceTableSchema = {
      tableName: table,
      originalTableName: table,
      columns,
      schema: sourceConnection.dbConfig?.schema || null,
      sampleData: [],
    };
    if (table && typeof skill.loadSourceRecords === 'function') {
      try {
        records = await skill.loadSourceRecords({ sourceConnection, sourceTableSchema, helpers });
        sourceTableSchema.sampleData = (records || []).slice(0, 3);
      } catch (_err) { records = []; }
    }
  }

  // Minimal plan envelope — buildFunctionPrompt only reads summary/outputType/
  // provider hints. We always run inline to NeDB-shaped (plain JSON) output;
  // the function can still emit a `vector` field if the user asked for one.
  const plan = {
    summary: request,
    outputType: 'nedb',
    aiProvider: null,
    embeddingProvider: null,
    connectionsNeeded: [],
  };
  const prompt = skill.buildFunctionPrompt({
    userRequest: request,
    plan,
    schemaContext: [],
    sourceConnection,
    sourceTableSchema,
  });

  const raw = await helpers.callAI(prompt, { maxTokens: 4096 });
  const parsed = typeof skill.processSkillResponse === 'function'
    ? skill.processSkillResponse(raw)
    : null;
  if (!parsed || parsed.action !== 'execute' || !parsed.transformFunction) {
    // The generator asked for clarification (or produced something invalid):
    // surface that to the AI so it can relay/refine rather than execute.
    return {
      ran: false,
      action: parsed?.action || 'ask_questions',
      message: parsed?.message || null,
      questionsNeeded: parsed?.questionsNeeded || null,
    };
  }

  // Run the generated function with a READ-ONLY helpers bundle: its
  // ctx.runQuery can read any connection but is blocked from writing. (Source
  // records above were loaded with the unwrapped helpers — our own controlled
  // reads — so only the AI-authored code is constrained.)
  const output = await skill.runTransformFunction({
    transformFunction: parsed.transformFunction,
    records,
    helpers: readOnlyHelpers(helpers, provider),
  });

  return {
    ran: true,
    explanation: parsed.explanation || '',
    transformFunction: parsed.transformFunction,
    recordCount: output.length,
    rows: output.slice(0, MAX_QUERY_ROWS),
  };
}

const MAIN_TOOLS = new Set([
  'list_docs', 'read_doc',
  'list_workflows', 'get_workflow', 'get_workflow_nodes',
  'list_connections', 'get_connection',
  'list_executions', 'get_execution',
  'get_tables', 'get_columns', 'run_query',
  'http_request', 'run_javascript',
  'plan_workflow_build',
]);

const WORKFLOW_TOOLS = new Set([
  'list_connections', 'get_connection',
  'list_workflows', 'get_workflow', 'get_workflow_nodes',
  'get_tables', 'get_columns', 'run_query',
  'propose_plan',
  'exit_workflow_mode',
]);

/**
 * Main-agent tool runner. `plan_workflow_build` is the only mode-flipping
 * tool here — it records the request + workflowId on a fresh
 * workflowSession and signals the renderer to switch to 'workflow' mode.
 */
async function runMainTool(name, args, ctx) {
  args = args || {};
  if (!MAIN_TOOLS.has(name)) throw new Error(`Unknown tool for main agent: ${name}`);

  if (SHARED_TOOLS[name]) return SHARED_TOOLS[name](ctx, args);

  if (name === 'http_request')   return httpRequestTool(ctx, args);
  if (name === 'run_javascript') return runJavascriptTool(ctx, args);

  if (name === 'plan_workflow_build') {
    if (!args.request || !String(args.request).trim()) {
      throw new Error('request is required');
    }
    const targetId = args.workflowId
      || (ctx.activeContext?.kind === 'workflow' ? ctx.activeContext.id : null);
    let resolvedId = null;
    if (targetId) {
      const wfDb = ctx.getDb('workflows');
      const wf = await wfDb.findOneAsync({ $or: [{ id: targetId }, { _id: targetId }] });
      if (!wf) throw new Error(`Workflow not found: ${targetId}`);
      resolvedId = wf.id || wf._id;
    }
    // Carry the user's ORIGINAL message verbatim alongside the model's short
    // description. The builder needs literal values (API URLs, request bodies,
    // recaptcha tokens, keys) exactly as the user typed them — re-typing them
    // through the model risks truncation/corruption, so the model only has to
    // write a brief description and the real text rides along here.
    const session = {
      request:     String(args.request).trim(),
      userMessage: String(ctx.message || '').trim(),
      workflowId:  resolvedId,
    };
    return {
      handed_off: true,
      nextAgentMode: 'workflow',
      workflowSession: session,
      __sessionUpdate: { nextAgentMode: 'workflow', workflowSession: session },
    };
  }

  throw new Error(`Unhandled main tool: ${name}`);
}

/**
 * Workflow sub-agent tool runner. Owns `propose_plan` (real planner) and
 * `exit_workflow_mode` (flip back to main).
 */
async function runWorkflowTool(name, args, ctx) {
  args = args || {};
  if (!WORKFLOW_TOOLS.has(name)) throw new Error(`Unknown tool for workflow agent: ${name}`);

  if (SHARED_TOOLS[name]) return SHARED_TOOLS[name](ctx, args);

  if (name === 'propose_plan') {
    const session = ctx.workflowSession;
    if (!session || !session.request) {
      throw new Error('No active workflow session. Did you mean exit_workflow_mode?');
    }
    // Clarifications come from chat history (derived once at the top of
    // runStep, with the current user message folded in). The sub-agent passes
    // no clarifications; it does not maintain a separate clarifications list.
    const clarifications = Array.isArray(ctx.clarifications) ? ctx.clarifications : [];

    // The sub-agent passes `request` — a short, self-contained description of
    // the workflow the user CURRENTLY wants, synthesized from the latest
    // conversation. This supersedes session.request, which can be stale when
    // the user changes their mind mid-chat (e.g. "actually, a new workflow that
    // exports CSV"). Fall back to session.request only if none was supplied.
    const description = (typeof args.request === 'string' && args.request.trim())
      ? args.request.trim()
      : session.request;
    // Append the user's original message verbatim so the builder always has
    // literal values (URLs, request bodies, tokens, keys) exactly as typed —
    // the model only writes a short description; it never re-types these.
    const original = String(session.userMessage || '').trim();
    const userRequest = (original && !description.includes(original))
      ? `${description}\n\n--- User's original message (use literal values such as URLs, request bodies, tokens, and keys exactly as written here) ---\n${original}`
      : description;

    // The sub-agent decides the target. An explicit `workflowId` means "modify
    // THAT workflow"; `newWorkflow: true` means "build a brand-new workflow"
    // (ignore any open one). When it specifies neither, fall back to the
    // session's workflow — i.e. the one the user had open when this build
    // started. A workflow being open does NOT by itself force a modify; the
    // sub-agent must opt in via workflowId.
    let targetWorkflowId = null;
    if (args.newWorkflow === true) {
      targetWorkflowId = null;
    } else if (typeof args.workflowId === 'string' && args.workflowId.trim()) {
      targetWorkflowId = args.workflowId.trim();
    } else {
      targetWorkflowId = session.workflowId || null;
    }

    let workflow = null;
    if (targetWorkflowId) {
      const wfDb = ctx.getDb('workflows');
      workflow = await wfDb.findOneAsync({
        $or: [{ id: targetWorkflowId }, { _id: targetWorkflowId }],
      });
      if (!workflow) throw new Error(`Workflow not found: ${targetWorkflowId}`);
    }

    const plan = await workflowBuilder.planBuild({
      userRequest,
      workflow,
      helpers: ctx.helpers,
      getDb:   ctx.getDb,
      clarifications,
    });
    if (plan.action === 'plan' && plan.mode === 'modify' && workflow) {
      plan.workflowId = workflow.id || workflow._id;
    }
    // Short-circuit: the backend will finish the turn with the planner's
    // output rather than asking the model to relay it. Plans become a
    // dedicated workflowPlan field on the response; clarifying questions
    // become the finalAnswer text; planner errors surface as plain prose
    // (no clarification flag so the user isn't expected to "answer").
    let shortCircuit;
    if (plan.action === 'plan') {
      shortCircuit = {
        finalAnswer: `Here's the plan I'd build (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}). Accept to apply it, or Cancel.`,
        workflowPlan: plan,
      };
    } else if (plan.action === 'error') {
      shortCircuit = {
        finalAnswer: `I couldn't produce a valid workflow plan: ${plan.message}`,
      };
    } else {
      shortCircuit = {
        finalAnswer: String(plan.followUpQuestion || '').trim(),
        clarification: true,
      };
    }
    return {
      plan,
      __shortCircuit: shortCircuit,
    };
  }

  if (name === 'exit_workflow_mode') {
    return {
      exited: true,
      reason: args.reason || '',
      nextAgentMode: 'main',
      workflowSession: null,
      __sessionUpdate: { nextAgentMode: 'main', workflowSession: null },
    };
  }

  throw new Error(`Unhandled workflow tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON envelope parsing — model occasionally adds prose around the object.
// ---------------------------------------------------------------------------

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
  const first = extractFirstJsonObject(raw.trim());
  const s = first || raw.trim();
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error(`Model returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshots, context, scratchpad formatting.
// ---------------------------------------------------------------------------

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
    workflows: workflows,
    connectionCount: helpers.connections.length,
    connections: helpers.connections.map(summarizeConnection),
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
    summary ? `Summary: ${typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2)}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function formatScratchpad(scratchpad) {
  if (!Array.isArray(scratchpad) || scratchpad.length === 0) return '';
  const lines = [];
  for (const step of scratchpad) {
    lines.push(`\n[step ${step.index}] thought: ${step.thought || '(none)'}`);
    if (Array.isArray(step.actions)) {
      step.actions.forEach((a, i) => {
        const argsStr = typeof a.args === 'string' ? a.args : JSON.stringify(a.args);
        // get_workflow is slimmed (and ultra-slimmed past a size threshold)
        // at the source; get_workflow_nodes returns whatever the AI
        // explicitly asked for. Trimming either one mid-JSON makes the AI
        // think it missed something and refetch on the next turn.
        const skipTrim = a.tool === 'get_workflow' || a.tool === 'get_workflow_nodes';
        const obs = a.error
          ? `ERROR: ${a.error}`
          : (skipTrim
              ? (typeof a.result === 'string' ? a.result : JSON.stringify(a.result, null, 2))
              : trimText(a.result, MAX_FIELD_CHARS));
        lines.push(`  action ${step.index}.${i + 1}: ${a.tool}(${argsStr})\n    observation: ${obs}`);
      });
    }
  }
  return lines.join('\n');
}

// ── Visuals ────────────────────────────────────────────────────────────────
// The main agent may attach a `visuals` array to its finalAnswer. Each item is
// resolved here into the { type, title, data } shape the DataVisualization
// component renders. No aggregation / grouping / sorting — rows are charted
// as-is. A visual either references a prior action result ("source": "3.1") or
// carries inline { x, y } rows ("dataset"). Anything malformed degrades to a
// table (or is dropped) rather than erroring the turn.
const MAX_VISUALS = 3;
const MAX_VISUAL_POINTS = 500;

// Pull row objects out of a tool result, whatever connector shape it came in.
function extractRows(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    if (Array.isArray(result.rows)) return result.rows;
    if (Array.isArray(result.recordset)) return result.recordset;
    if (Array.isArray(result.data)) return result.data;
  }
  return null;
}

// Resolve a "<step>.<action>" reference (e.g. "3.1") to that action's raw result.
function resultFromScratchpad(source, scratchpad) {
  if (typeof source !== 'string') return null;
  const m = source.match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  const step = (scratchpad || []).find((s) => s.index === Number(m[1]));
  if (!step || !Array.isArray(step.actions)) return null;
  const action = step.actions[Number(m[2]) - 1];
  if (!action || action.error) return null;
  return action.result;
}

function rowsFromScratchpad(source, scratchpad) {
  return extractRows(resultFromScratchpad(source, scratchpad));
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Build a table visual that handles BOTH structured and unstructured data:
//   • array of plain objects → a column grid (isJson: false)
//   • anything else (single object / document, array of primitives, nested
//     blob, scalar) → a JSON payload the component shows in a Monaco editor,
//     mirroring DataPreview's `isJson` document view.
function tableVisual(title, value) {
  const base = { type: 'table', title: title || '' };

  if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
    const list = value.slice(0, MAX_VISUAL_POINTS);
    const columns = [];
    const seen = new Set();
    for (const row of list) {
      for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    }
    return { ...base, isJson: false, columns, data: list };
  }

  // Unstructured → JSON view. Cap arrays so we never ship a huge blob.
  const json = Array.isArray(value) ? value.slice(0, MAX_VISUAL_POINTS) : value;
  return { ...base, isJson: true, json };
}

function resolveVisuals(visuals, scratchpad) {
  if (!Array.isArray(visuals)) return [];
  const out = [];
  for (const v of visuals.slice(0, MAX_VISUALS)) {
    if (!v || typeof v !== 'object') continue;
    const type = typeof v.type === 'string' ? v.type : 'table';
    const title = typeof v.title === 'string' ? v.title : '';

    const inline = Array.isArray(v.dataset);

    // A table can showcase structured rows OR unstructured/JSON data, so it
    // takes the RAW value (the array of rows when there is one, otherwise the
    // whole result — a document, scalar, etc.). tableVisual decides grid vs
    // JSON view.
    if (type === 'table') {
      const value = inline
        ? v.dataset
        : (() => { const raw = resultFromScratchpad(v.source, scratchpad); return extractRows(raw) ?? raw; })();
      if (value === null || value === undefined) continue;
      out.push(tableVisual(title, value));
      continue;
    }

    // Chart types need an array of rows: inline { x, y } data or a source's rows.
    const rows = inline ? v.dataset : (v.source ? rowsFromScratchpad(v.source, scratchpad) : null);
    if (!Array.isArray(rows) || rows.length === 0) continue;

    // Chart types need [{ x, y }]. Inline data is already shaped; a source maps
    // the two named columns straight across with no transformation.
    let data;
    if (inline) {
      data = rows
        .filter((r) => r && typeof r === 'object' && 'x' in r && 'y' in r)
        .map((r) => ({ x: r.x, y: r.y }));
    } else {
      const first = rows[0];
      if (!first || typeof first !== 'object' || !(v.x in first) || !(v.y in first)) {
        out.push(tableVisual(title, rows));   // columns don't exist → safe fallback
        continue;
      }
      data = rows.map((r) => ({ x: r[v.x], y: r[v.y] }));
    }

    if (!data.length) { out.push(tableVisual(title, rows)); continue; }
    out.push({ type, title, data: data.slice(0, MAX_VISUAL_POINTS) });
  }
  return out;
}

// Canonical JSON for a tool call's args — keys sorted recursively so
// { id: 'x', limit: 5 } and { limit: 5, id: 'x' } hash to the same key.
function canonicalArgs(args) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  try { return JSON.stringify(sortKeys(args ?? {})); }
  catch { return String(args); }
}

// Walk the scratchpad and build a set of `${tool}|${canonicalArgs}` keys
// for every action already attempted this conversation turn — successful
// or not. The action loop refuses to re-run any call already in this set
// and instead pushes a synthetic observation telling the AI to reuse the
// prior result.
function priorCallSet(scratchpad) {
  const seen = new Set();
  if (!Array.isArray(scratchpad)) return seen;
  for (const step of scratchpad) {
    if (!Array.isArray(step.actions)) continue;
    for (const a of step.actions) {
      if (!a || !a.tool) continue;
      seen.add(`${a.tool}|${canonicalArgs(a.args)}`);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// runStep — single entry, branches on agentMode. Returns nextAgentMode +
// workflowSession so the renderer can persist / restart with new mode.
// ---------------------------------------------------------------------------

async function runStep({
  message,
  history = [],
  scratchpad = [],
  activeContext = null,
  provider,
  agentMode = 'main',
  workflowSession = null,
  triggerPlanWorkflowBuild = null,
  getDb,
  helpers,
}) {
  if (!message || !message.trim()) throw new Error('message is required');
  if (!helpers || typeof helpers.callAI !== 'function') {
    throw new Error('helpers (with callAI) is required');
  }
  if (typeof getDb !== 'function') throw new Error('getDb is required');

  // Renderer-triggered direct run of plan_workflow_build. Used after a
  // turn that batched plan_workflow_build with other tools — we deferred
  // it then; the renderer restarts the loop with this flag so we can
  // run it here without going through the AI again.
  if (triggerPlanWorkflowBuild) {
    const docIndex = listDocFiles();
    const baseCtx = { helpers, getDb, docIndex, activeContext, message };
    const args = triggerPlanWorkflowBuild.args || {};
    const stepIndex = scratchpad.length + 1;
    try {
      const result = await runMainTool('plan_workflow_build', args, baseCtx);
      let nextAgentMode = agentMode;
      let nextWorkflowSession = workflowSession;
      if (result && result.__sessionUpdate) {
        const su = result.__sessionUpdate;
        if (su.nextAgentMode) nextAgentMode = su.nextAgentMode;
        if ('workflowSession' in su) nextWorkflowSession = su.workflowSession;
        delete result.__sessionUpdate;
      }
      const executed = [{ tool: 'plan_workflow_build', args, ok: true, result }];
      return {
        success: true,
        done: false,
        thought: 'Resuming deferred plan_workflow_build.',
        actions: executed,
        finalAnswer: null,
        workflowPlan: null,
        clarification: false,
        agentMode,
        nextAgentMode,
        workflowSession: nextWorkflowSession,
        pendingPlanWorkflowBuild: null,
        step: { index: stepIndex, thought: 'Resuming deferred plan_workflow_build.', actions: executed },
      };
    } catch (err) {
      const executed = [{ tool: 'plan_workflow_build', args, ok: false, error: err.message || String(err) }];
      return {
        success: true,
        done: false,
        thought: 'Failed to resume deferred plan_workflow_build.',
        actions: executed,
        finalAnswer: null,
        workflowPlan: null,
        clarification: false,
        agentMode,
        nextAgentMode: agentMode,
        workflowSession,
        pendingPlanWorkflowBuild: null,
        step: { index: stepIndex, thought: 'Failed to resume deferred plan_workflow_build.', actions: executed },
      };
    }
  }

  const docIndex = listDocFiles();
  const readme = safeReadFile(path.join(DOCS_ROOT, 'README.md')) || '(README missing)';
  const systemContext = workflowBuilder.buildSystemContext();

  // Build per-mode system prompt + tool runner.
  let systemPrompt;
  let runOneTool;
  if (agentMode === 'workflow') {
    if (!workflowSession || !workflowSession.request) {
      // Should not happen — but if it does, fall back to main agent so we
      // don't leave the chat stuck.
      agentMode = 'main';
    }
  }

  // Clarifications are derived from chat history in workflow mode — the
  // renderer flags clarification questions with `clarification: true` and
  // their answers are the immediately-following user messages. No
  // separate session field is needed.
  //
  // The CURRENT user message is the answer to the most recent clarification
  // (it lives in `message`, not yet in `history`), so fold it in as a trailing
  // user turn before pairing — otherwise the latest question/answer pair is
  // dropped and the planner re-asks something the user just answered.
  const clarifications = agentMode === 'workflow'
    ? clarificationsFromHistory([...(history || []), { role: 'user', text: message }])
    : [];

  if (agentMode === 'workflow') {
    const nodeDocs = workflowBuilder.nodeDocsAsPromptSection();
    const chatPromptDocs = workflowBuilder.chatPromptDocsAsPromptSection();
    let workflowSummary = null;
    if (workflowSession.workflowId) {
      const wfDb = getDb('workflows');
      const wf = await wfDb.findOneAsync({
        $or: [{ id: workflowSession.workflowId }, { _id: workflowSession.workflowId }],
      });
      if (wf) workflowSummary = workflowBuilder.slimWorkflowForPrompt(wf);
    }
    // Surface the installed skill catalog so the workflow-builder agent
    // knows which transformer / join skills the per-node builders can
    // route through (mirrors the NodeChat loadAvailableSkills flow).
    let transformerSkills = [];
    let joinSkills = [];
    try {
      if (helpers?.pluginManager?.getSkillDescriptions) {
        transformerSkills = helpers.pluginManager.getSkillDescriptions('transformer', {}) || [];
        joinSkills = (helpers.pluginManager.getSkillDescriptions('join', {}) || [])
          .filter((s) => s.id !== 'vector-db-executor');
      }
    } catch (_err) { /* skills are optional; ignore lookup failures */ }
    systemPrompt = buildWorkflowSystemPrompt({
      nodeDocs,
      chatPromptDocs,
      connections: helpers.connections.map(summarizeConnection),
      workflowSummary,
      workflowSession,
      systemContext,
      maxActions: MAX_ACTIONS_PER_STEP,
      transformerSkills,
      joinSkills,
    });
    runOneTool = (name, args, baseCtx) =>
      runWorkflowTool(name, args, { ...baseCtx, workflowSession, clarifications });
  } else {
    const snapshot = await buildSnapshot(getDb, helpers);
    const contextSummary = formatContext(activeContext);
    systemPrompt = buildMainSystemPrompt({
      docIndex, readme, contextSummary, snapshot, systemContext,
      maxActions: MAX_ACTIONS_PER_STEP,
    });
    runOneTool = (name, args, baseCtx) => runMainTool(name, args, baseCtx);
  }

  // Cross-turn chat history. Assistant messages flagged with
  // `clarification: true` (workflow-mode follow-ups asked by either the
  // sub-agent or the build planner) get a "Clarifying question: " prefix
  // so the model — and our docs / system prompts — can recognise them by
  // pattern. The display-side message text is left alone; this prefix
  // only travels into the AI's chatHistory.
  const chatHistory = (history || []).map((h) => {
    const baseText = h.text || h.content || '';
    const text = h.clarification
      ? `Clarifying question: ${baseText}`
      : baseText;
    return {
      sender: h.role === 'assistant' ? 'assistant' : 'user',
      text,
      ...(h.clarification ? { clarification: true } : {}),
    };
  });

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
      
      maxTokens: 4096,
    });
  } catch (err) {
    throw new Error(`AI call failed on step ${stepIndex}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = parseModelJson(raw);
  } catch (err) {
    // The model produced something that isn't valid JSON (most often a
    // response truncated mid-string when it overflows the token budget).
    // Stop here and surface the parse error instead of returning done:false,
    // which would retry the same prompt identically and loop forever.
    const errorText = `Failed to parse model response as JSON: ${err.message}`;
    return {
      success: false,
      done: true,
      thought: 'Model produced invalid JSON.',
      actions: [],
      // `message` is what the renderer shows on the !success break path
      // (ChatAssistant.js); finalAnswer/error mirror it for the done path
      // and for callers that inspect those fields.
      message: errorText,
      finalAnswer: errorText,
      error: errorText,
      rawResponse: raw,
      workflowPlan: null,
      clarification: false,
      agentMode,
      nextAgentMode: agentMode,
      workflowSession,
      step: {
        index: stepIndex,
        thought: '(parse error)',
        actions: [{ tool: 'invalid', args: {}, ok: false, error: err.message }],
      },
    };
  }

  const thought = String(parsed.thought || '').trim();

  // Branch B — final answer. In workflow mode, a non-plan finalAnswer is
  // a clarification question; the renderer tags it so the next turn picks
  // up the answer from history.
  if (parsed.finalAnswer) {
    const finalAnswer = String(parsed.finalAnswer).trim();
    // Visuals are a main-agent feature only; the workflow sub-agent's
    // finalAnswers are clarification questions, not data answers.
    const visuals = agentMode === 'main' ? resolveVisuals(parsed.visuals, scratchpad) : [];
    return {
      success: true,
      done: true,
      thought,
      actions: [],
      finalAnswer,
      visuals,
      workflowPlan: null,
      clarification: agentMode === 'workflow',
      agentMode,
      nextAgentMode: agentMode,
      workflowSession,
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
      workflowPlan: null,
      clarification: false,
      agentMode,
      nextAgentMode: agentMode,
      workflowSession,
      step: {
        index: stepIndex,
        thought,
        actions: [{ tool: 'invalid', args: {}, ok: false, error: 'no actions and no finalAnswer' }],
      },
    };
  }

  if (actions.length > MAX_ACTIONS_PER_STEP) actions = actions.slice(0, MAX_ACTIONS_PER_STEP);

  // If plan_workflow_build is batched alongside ordinary tools, peel it
  // off and run only the ordinary tools this turn. We surface its args
  // via `pendingPlanWorkflowBuild` so the renderer can restart the loop
  // with it once the user has seen this turn's finalAnswer. Plain
  // single-tool calls to plan_workflow_build still run normally.
  let pendingPlanWorkflowBuild = null;
  const buildIdx = actions.findIndex((a) => a?.tool === 'plan_workflow_build');
  if (buildIdx >= 0 && actions.length > 1) {
    pendingPlanWorkflowBuild = { args: actions[buildIdx].args || {} };
    actions = actions.filter((_, i) => i !== buildIdx);
  }

  // Run each action sequentially. Two sentinels can come back attached to
  // a tool result:
  //   __sessionUpdate  — flips agentMode / workflowSession.
  //   __shortCircuit   — ends the turn with the planner's user-facing
  //                      output (propose_plan).
  const baseCtx = { helpers, getDb, docIndex, activeContext, provider };
  const executed = [];
  let nextAgentMode = agentMode;
  let nextWorkflowSession = workflowSession;
  let shortCircuit = null;
  // Seed with prior-turn calls so the AI can't loop the same fetch across
  // turns; also dedups within this turn as we add each freshly-run call.
  const seenCalls = priorCallSet(scratchpad);
  for (const a of actions) {
    const tool = a.tool;
    const args = a.args || {};
    const key = `${tool}|${canonicalArgs(args)}`;
    if (seenCalls.has(key)) {
      executed.push({
        tool, args, ok: false,
        error: `Already called ${tool} with identical arguments earlier in this conversation. Reuse the previous observation from the scratchpad — do not call this again. If you need different data, change the arguments or pick a different tool.`,
      });
      continue;
    }
    seenCalls.add(key);
    try {
      const result = await runOneTool(tool, args, baseCtx);
      if (result && result.__sessionUpdate) {
        const su = result.__sessionUpdate;
        if (su.nextAgentMode) nextAgentMode = su.nextAgentMode;
        if ('workflowSession' in su) nextWorkflowSession = su.workflowSession;
        delete result.__sessionUpdate;
      }
      if (result && result.__shortCircuit) {
        shortCircuit = result.__shortCircuit;
        delete result.__shortCircuit;
      }
      executed.push({ tool, args, ok: true, result });
    } catch (err) {
      executed.push({ tool, args, ok: false, error: err.message || String(err) });
    }
  }

  if (shortCircuit) {
    // End the turn with the planner's output. The renderer renders the
    // tool step AND the final answer (with optional workflowPlan card)
    // from this one response.
    return {
      success: true,
      done: true,
      thought,
      actions: executed,
      finalAnswer: shortCircuit.finalAnswer || '',
      workflowPlan: shortCircuit.workflowPlan || null,
      clarification: !!shortCircuit.clarification,
      agentMode,
      nextAgentMode,
      workflowSession: nextWorkflowSession,
      pendingPlanWorkflowBuild,
      step: {
        index: stepIndex,
        thought,
        actions: executed,
        finalAnswer: shortCircuit.finalAnswer || '',
      },
    };
  }

  return {
    success: true,
    done: false,
    thought,
    actions: executed,
    finalAnswer: null,
    workflowPlan: null,
    clarification: false,
    agentMode,
    nextAgentMode,
    workflowSession: nextWorkflowSession,
    pendingPlanWorkflowBuild,
    step: { index: stepIndex, thought, actions: executed },
  };
}

module.exports = {
  runStep,
};
