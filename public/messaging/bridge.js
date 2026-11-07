/**
 * Chat-platform ↔ chat assistant bridge: everything that is the same on every
 * platform. Telegram and Slack plug in an adapter (public/telegram/adapter.js,
 * public/slack/adapter.js) that turns platform events into the two event kinds
 * below and renders this module's messages in the platform's own format.
 *
 * Event kinds the adapter calls `handle` with:
 *   { kind: 'message', chatId, user: { id, name, username }, isPrivate, text,
 *     file: { ref, name, size } | null, photo, replyTo }
 *   { kind: 'action', chatId, userId, data, ack(text, { refusal }) }
 *
 * Messages are built as LINES of styled spans, which each adapter renders
 * (Telegram HTML, Slack mrkdwn): a line is a string or an array of spans,
 * a span is a string or { b } | { i } | { code }.
 *
 * Behaviour (identical on every platform):
 *   - only paired users get answers (pair with a one-time code from Settings)
 *   - direct messages only — in a group or channel anyone could read the data
 *   - one thing at a time per chat; the cancel command stops it
 *   - generated code and workflow-build steps wait for Run / Don't run
 *   - workflow plans get Build / Cancel; new workflows build from the chat
 *   - a data file sent in becomes a connection
 */

const path = require('path');
const { chunkMarkdown, tableToCsv, tablePreview } = require('../telegram/format');

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const FILE_TYPE_BY_EXT = {
  '.csv': 'spreadsheet', '.tsv': 'spreadsheet', '.txt': 'spreadsheet',
  '.xlsx': 'spreadsheet', '.xlsm': 'spreadsheet',
  '.json': 'json', '.ndjson': 'json', '.jsonl': 'json',
  '.parquet': 'parquet',
  '.avro': 'avro',
};

// A plan step's node type, as the app's plan card badges it — the closest
// coloured square to each canvas colour (NODE_COLORS in nodeCardShared.js).
const STEP_BADGE = {
  start: { icon: '🟦', label: 'START' },
  dataSource: { icon: '🟦', label: 'DATA SOURCE' },
  transformer: { icon: '🟪', label: 'TRANSFORMER' },
  join: { icon: '🟧', label: 'JOIN' },
  output: { icon: '🟥', label: 'OUTPUT' },
};
const DESCRIPTION_MAX = 400;

/**
 * A workflow plan as lines — the same content the app's plan card shows:
 * each step's type, title, inputs (← step numbers) and description.
 */
function planLines(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const labels = plan.nodeLabels || {};
  const stepNoById = new Map();
  steps.forEach((st, i) => {
    const id = typeof st === 'string' ? st : st?.existingNodeId;
    if (id) stepNoById.set(id, i + 1);
  });
  const ref = (r) => (typeof r === 'number' ? String(r + 1) : (stepNoById.has(r) ? String(stepNoById.get(r)) : (labels[r] || r)));
  const lines = [[
    { b: plan.mode === 'modify' ? 'Modify workflow' : (plan.name || 'New workflow') },
    ` · ${steps.length} step${steps.length === 1 ? '' : 's'}`,
  ]];
  steps.forEach((st, i) => {
    const kept = typeof st === 'string';
    const badge = kept ? { icon: '⬜', label: 'KEEP' } : (STEP_BADGE[st.stepType] || { icon: '⬜', label: String(st.stepType || 'STEP').toUpperCase() });
    const title = kept
      ? `Keep ${labels[st] || st}`
      : (st.existingNodeId ? `Modify ${labels[st.existingNodeId] || st.existingNodeId}` : (st.label || st.stepType || 'step'));
    const inputs = !kept && Array.isArray(st.sources) && st.sources.length ? ` ← ${st.sources.map(ref).join(', ')}` : '';
    lines.push('');
    lines.push([`${badge.icon} `, { b: `${i + 1}. ${title}` }, '  ', { code: badge.label }, inputs]);
    const desc = kept ? '' : String(st.prompt || '').trim();
    if (desc) lines.push(desc.length > DESCRIPTION_MAX ? `${desc.slice(0, DESCRIPTION_MAX - 1)}…` : desc);
  });
  if (plan.mode === 'modify' && Array.isArray(plan.deletedNodes) && plan.deletedNodes.length) {
    lines.push('', `🗑 Deletes: ${plan.deletedNodes.map((id) => labels[id] || id).join(', ')}`);
  }
  return lines;
}

const newConvoId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const newToken = () => Math.random().toString(36).slice(2, 10);

class MessagingBridge {
  /**
   * @param {object} deps
   * @param {object} deps.adapter        platform adapter (see the header)
   * @param {object} deps.store          createStore(…) — pairing, users, sessions
   * @param {object} deps.runner         createConversationRunner(…)
   * @param {Function} deps.importFile   (localPath, { name, originalName, fileType }) → { connection, tables }
   * @param {Function} deps.saveUpload   (chatId, fileName, buffer) → local path
   * @param {object} [deps.builds]       createWorkflowBuildRunner(…); without it plans are left for the app
   * @param {Function} [deps.onWorkflowBuilt]
   * @param {Function} [deps.renderChart] (visual) → Promise<Buffer|null>
   */
  constructor({
    adapter, store, runner, importFile, saveUpload, builds = null, onWorkflowBuilt = () => {},
    renderChart = async () => null, log = console,
  }) {
    this.adapter = adapter;
    this.store = store;
    this.runner = runner;
    this.builds = builds;
    this.onWorkflowBuilt = onWorkflowBuilt;
    this.importFile = importFile;
    this.saveUpload = saveUpload;
    this.renderChart = renderChart;
    this.log = log;
    this.busyChats = new Set();
    this.approvals = new Map();      // token → { resolve, userId, chatId, handle, timer }
    this.plans = new Map();          // token → { plan, chatId, userId, convoId, handle }
    this.buildQuestions = new Map(); // chatId → { plan, question, stepIndex, userId, convoId }
    this.work = new Map();           // chatId → { kind: 'answer' | 'build', cancelled }
  }

  get label() { return this.adapter.label; }
  cmd(name) { return this.adapter.commandHint(name); }

  helpLines() {
    return [
      [{ b: 'Ternlux' }, ' — ask about your data, workflows and runs.'],
      '',
      ['• Just type a question, e.g. ', { i: '"How many orders did each store have last month? Chart it."' }],
      `• Send a CSV, Excel, JSON, Parquet or Avro file to add it as a connection. ${this.adapter.fileNameHint}`,
      `• ${this.cmd('new')} starts a fresh conversation.`,
      `• ${this.cmd('cancel')} stops what I'm working on (an answer, a workflow build, or a waiting approval).`,
      '',
      'Ternlux has to be open on your computer for me to answer.',
    ];
  }

  stop() {
    for (const token of [...this.approvals.keys()]) {
      this.settleApproval(token, false, `Ternlux stopped the ${this.label} bridge.`);
    }
  }

  // ── routing ─────────────────────────────────────────────────────────────

  async handle(event) {
    if (event.kind === 'action') return this.handleAction(event);
    if (event.kind !== 'message') return undefined;
    const { chatId, user } = event;

    if (!event.isPrivate) {
      return this.adapter.sendPlain(chatId, `I only work in a direct message with you for now — ${this.adapter.groupWord} `
        + 'would let anyone in them query your data.', { replyTo: event.replyTo });
    }

    const text = String(event.text || '').trim();
    const command = this.adapter.parseCommand(text);
    if (!this.store.isAllowed(user.id)) {
      if (command && (command.name === 'pair' || command.name === 'start') && /^\d{6}$/.test(command.arg)
        && this.store.checkPairingCode(command.arg)) {
        this.store.addUser({ id: user.id, name: user.name || '', username: user.username || null, chatId, pairedAt: new Date().toISOString() });
        const help = this.helpLines();
        return this.adapter.sendRich(chatId, [['Paired. ', ...[].concat(help[0])], ...help.slice(1)]);
      }
      return this.adapter.sendPlain(chatId, `This bot is private. To use it, open Ternlux → Settings → ${this.label}, `
        + `create a pairing code and send it here as ${this.cmd('pair')} 123456.`);
    }

    if (command && !event.file) {
      if (command.name === 'start' || command.name === 'help') return this.adapter.sendRich(chatId, this.helpLines());
      if (command.name === 'new') {
        this.buildQuestions.delete(chatId);
        this.store.setSession(chatId, newConvoId());
        return this.adapter.sendPlain(chatId, 'Started a new conversation.');
      }
      if (command.name === 'cancel') return this.cancel(chatId);
    }
    if (event.file) return this.handleFile(event);
    if (event.photo) {
      return this.adapter.sendPlain(chatId, 'I can add data files (CSV, Excel, JSON, Parquet, Avro) — send them as a file, not a photo.');
    }
    if (!text) return undefined;
    return this.handleQuestion(event, text);
  }

  /**
   * Cancel — stop whatever this chat is doing:
   *   - an answer being worked on: no further steps run; a step already
   *     talking to the AI finishes and its result is dropped
   *   - a workflow build: no further passes; the pass in progress finishes
   *   - an approval waiting on a button: declined
   *   - a build waiting on an answer to its question: dropped
   */
  async cancel(chatId) {
    const work = this.work.get(chatId);
    const waiting = [...this.approvals.entries()].filter(([, a]) => String(a.chatId) === String(chatId));
    if (work) {
      work.cancelled = true;
      for (const [token] of waiting) this.settleApproval(token, false, 'Cancelled.');
      return this.adapter.sendPlain(chatId, work.kind === 'build'
        ? 'Stopping the build — the step already running finishes first, then nothing more is built.'
        : 'Stopping — the step already running finishes first, then I stop without answering.');
    }
    const parked = this.buildQuestions.get(chatId);
    if (parked) {
      this.buildQuestions.delete(chatId);
      await this.runner.note(parked.convoId, [], { pendingBuild: null },
        { planStatus: { kind: 'cancelled', message: `Build stopped from ${this.label}.` } });
      return this.adapter.sendPlain(chatId, 'Stopped the workflow build. Nothing more will be built.');
    }
    return this.adapter.sendPlain(chatId, 'Nothing to cancel — I\'m not working on anything in this chat.');
  }

  // ── a question ──────────────────────────────────────────────────────────

  async handleQuestion(event, text) {
    const { chatId, user } = event;
    if (this.busyChats.has(chatId)) {
      return this.adapter.sendPlain(chatId, `Still working on your last message — I'll answer that first. Send ${this.cmd('cancel')} to stop it.`);
    }
    // A workflow build is waiting on an answer: this message is it.
    const parked = this.buildQuestions.get(chatId);
    if (parked && String(parked.userId) === String(user.id)) {
      this.buildQuestions.delete(chatId);
      await this.runner.note(parked.convoId, [{ role: 'user', text }]);
      return this.runPlan(chatId, user.id, parked.convoId,
        this.builds.answer(parked.plan, parked.question, text, parked.stepIndex), event);
    }
    this.busyChats.add(chatId);
    const work = { kind: 'answer', cancelled: false };
    this.work.set(chatId, work);
    let convoId = this.store.sessionFor(chatId);
    if (!convoId) {
      convoId = newConvoId();
      this.store.setSession(chatId, convoId);
    }
    const stopWorking = this.adapter.startWorking(chatId, event);
    try {
      const outcome = await this.runner.runTurn({
        convoId,
        text,
        source: { platform: this.adapter.platform, chatId, userId: user.id, username: user.username || null },
        requestApproval: (req) => this.requestApproval(chatId, user.id, req),
        isCancelled: () => work.cancelled,
      });
      if (outcome.cancelled) {
        await this.adapter.sendPlain(chatId, 'Stopped.');
      } else {
        await this.deliver(chatId, outcome, { userId: user.id, convoId });
      }
    } catch (err) {
      this.log.error(`[${this.adapter.platform}] turn failed:`, err.message);
      await this.adapter.sendPlain(chatId, `Something went wrong: ${err.message}`);
    } finally {
      stopWorking();
      this.busyChats.delete(chatId);
      this.work.delete(chatId);
    }
    return undefined;
  }

  async deliver(chatId, outcome, { userId = null, convoId = null } = {}) {
    if (outcome.error && !outcome.answer) {
      await this.adapter.sendPlain(chatId, outcome.error);
      return;
    }
    for (const piece of chunkMarkdown(outcome.answer || '(no answer)')) {
      await this.adapter.sendMarkdown(chatId, piece);
    }
    for (const visual of outcome.visuals || []) {
      await this.sendVisual(chatId, visual);
    }
    if (outcome.workflowPlan) await this.offerPlan(chatId, userId, convoId, outcome.workflowPlan);
  }

  async sendVisual(chatId, visual) {
    const caption = visual.title ? visual.title.slice(0, 1000) : undefined;
    if (visual.type === 'table' && Array.isArray(visual.data) && visual.data.length) {
      await this.adapter.sendPreformatted(chatId, tablePreview(visual));
      const name = `${(visual.title || 'table').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'table'}.csv`;
      await this.adapter.sendFile(chatId, Buffer.from(tableToCsv(visual), 'utf8'), name, caption);
      return;
    }
    if (visual.type === 'kpi' && Array.isArray(visual.data)) {
      await this.adapter.sendRich(chatId, [
        ...(caption ? [[{ b: caption }]] : []),
        ...visual.data.map((d) => [{ b: String(d.x) }, `: ${d.y}`]),
      ]);
      return;
    }
    let png = null;
    try {
      png = await this.renderChart(visual);
    } catch (err) {
      this.log.warn(`[${this.adapter.platform}] chart render failed:`, err.message);
    }
    if (png) {
      await this.adapter.sendPhoto(chatId, png, 'chart.png', caption);
    } else if (Array.isArray(visual.data) && visual.data.length) {
      // No image form (box) or the render failed: the numbers still go out.
      await this.sendVisual(chatId, { type: 'table', title: visual.title, columns: ['x', 'y'], data: visual.data });
    }
  }

  // ── workflow plans ──────────────────────────────────────────────────────

  /**
   * A plan the assistant proposed, with Build / Cancel. Changes to an EXISTING
   * workflow are left to the app: the build reads the saved workflow, and if it
   * is open in Ternlux with unsaved edits, building from here would write over
   * them — the app asks to save first; a chat cannot see the canvas.
   */
  async offerPlan(chatId, userId, convoId, plan) {
    const lines = planLines(plan);
    if (!this.builds || plan.mode === 'modify') {
      const why = plan.mode === 'modify'
        ? `This changes an existing workflow, so build it in Ternlux — if it is open there with unsaved edits, building from ${this.label} would overwrite them.`
        : 'Open Ternlux to review and build it.';
      return this.adapter.sendRich(chatId, [...lines, '', [{ i: why }]]);
    }
    const token = newToken();
    const handle = await this.adapter.sendButtons(chatId, lines, [
      { label: 'Build it', data: `pl:${token}:b`, style: 'primary' },
      { label: 'Cancel', data: `pl:${token}:c` },
    ]);
    this.plans.set(token, { plan, chatId, userId, convoId, handle, lines });
    return undefined;
  }

  /**
   * Build a plan, answering its pauses here: approvals become Run / Don't run
   * buttons, a question waits for the user's next message. Same resume rules
   * as the app (public/messaging/workflowBuild.js).
   */
  async runPlan(chatId, userId, convoId, startPlan, event = null) {
    if (this.busyChats.has(chatId)) return this.adapter.sendPlain(chatId, `Still working on your last message. Send ${this.cmd('cancel')} to stop it.`);
    this.busyChats.add(chatId);
    const work = { kind: 'build', cancelled: false };
    this.work.set(chatId, work);
    const stopWorking = this.adapter.startWorking(chatId, event);
    const from = `from ${this.label}`;
    let plan = startPlan;
    const stoppedBuild = async () => {
      await this.adapter.sendPlain(chatId, 'Build stopped. Nothing more was built.');
      await this.runner.note(convoId, [{ role: 'assistant', kind: 'final', text: '_Build stopped by user._', agentSource: 'builder' }],
        { pendingBuild: null }, { planStatus: { kind: 'cancelled', message: `Build stopped ${from}.` } });
    };
    try {
      for (let pass = 0; pass < 10; pass++) {
        if (work.cancelled) { await stoppedBuild(); return undefined; }
        if (pass === 0) {
          await this.adapter.sendPlain(chatId, 'Building the workflow…');
          await this.runner.note(convoId, [], {}, { planStatus: { kind: 'running', message: `Building workflow… (${from})` } });
        }
        const r = await this.builds.build(plan);
        plan = r.plan;
        // Stopped during that pass: a finished build stands (it is saved), but
        // a pause is not followed up.
        if (work.cancelled && r.kind !== 'built') { await stoppedBuild(); return undefined; }
        if (r.kind === 'built') {
          const summary = `Built "${r.workflowName}" — ${r.nodeCount} node${r.nodeCount === 1 ? '' : 's'}, ${r.edgeCount} edge${r.edgeCount === 1 ? '' : 's'}.`;
          const warn = r.warnings.length ? `\n\nWarnings:\n${r.warnings.map((w) => `• ${w}`).join('\n')}` : '';
          await this.adapter.sendPlain(chatId, `✓ ${summary} Open it in Ternlux → Workflows to run it.${warn}`);
          await this.runner.note(convoId, [{ role: 'assistant', kind: 'final', text: `✓ ${summary}${warn}`, agentSource: 'builder' }],
            { agentMode: 'main', workflowSession: null, pendingBuild: null },
            { planStatus: { kind: 'success', message: `${summary} (built ${from})` } });
          this.onWorkflowBuilt({ workflowId: r.workflowId, workflowName: r.workflowName });
          return undefined;
        }
        if (r.kind === 'approval') {
          const isRebuild = r.approval.kind === 'target_rebuild';
          const approved = await this.requestApproval(chatId, userId, {
            title: isRebuild ? `Recreate ${r.approval.table}?` : 'Run this API call to build the workflow?',
            explanation: r.approval.explanation || r.question,
            code: r.approval.code || '',
          });
          if (!approved && work.cancelled) { await stoppedBuild(); return undefined; }
          if (!approved) {
            const text = isRebuild
              ? `Not approved — the build stopped, nothing was saved, and ${r.approval.table} was left as it is.`
              : 'Not run — the build stopped before calling the API, and nothing was saved.';
            await this.adapter.sendPlain(chatId, text);
            await this.runner.note(convoId, [{ role: 'assistant', kind: 'final', text, agentSource: 'builder' }], { pendingBuild: null },
              { planStatus: { kind: 'error', message: isRebuild ? `Stopped — recreating ${r.approval.table} was not approved.` : 'Stopped — the API call was not approved.' } });
            return undefined;
          }
          plan = this.builds.approve(plan, r.approval, r.stepIndex);
          continue;
        }
        if (r.kind === 'question') {
          this.buildQuestions.set(chatId, { plan, question: r.question, stepIndex: r.stepIndex, userId, convoId });
          await this.adapter.sendPlain(chatId, `${r.question}\n\n(Reply to continue the build, or ${this.cmd('cancel')} to stop it.)`);
          await this.runner.note(convoId, [{ role: 'assistant', kind: 'final', text: r.question, clarification: true, agentSource: 'builder' }], {},
            { planStatus: { kind: 'running', message: `Waiting for your answer in ${this.label}: ${r.question}` } });
          return undefined;
        }
        await this.adapter.sendPlain(chatId, `The build stopped: ${r.message}`);
        await this.runner.note(convoId, [{ role: 'assistant', error: true, text: `Build failed: ${r.message}`, agentSource: 'builder' }], { pendingBuild: null },
          { planStatus: { kind: 'error', message: r.message } });
        return undefined;
      }
      return this.adapter.sendPlain(chatId, 'The build kept stopping for approvals — finish it in Ternlux.');
    } catch (err) {
      this.log.error(`[${this.adapter.platform}] build failed:`, err.message);
      return this.adapter.sendPlain(chatId, `The build failed: ${err.message}`);
    } finally {
      stopWorking();
      this.busyChats.delete(chatId);
      this.work.delete(chatId);
    }
  }

  // ── approvals ───────────────────────────────────────────────────────────

  /**
   * Ask Run / Don't run. The description leads; the adapter keeps the code out
   * of the way (Telegram: a collapsed quote; Slack: a View code pop-up), so the
   * decision rests on what the code does rather than on reading it.
   */
  async requestApproval(chatId, userId, { code, explanation, title = 'Approve before this runs' }) {
    const token = newToken();
    const handle = await this.adapter.sendApproval(chatId, {
      token, title, explanation, code,
      buttons: [
        { label: 'Run it', data: `ap:${token}:y`, style: 'primary' },
        { label: 'Don\'t run', data: `ap:${token}:n`, style: 'danger' },
      ],
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleApproval(token, false, 'Approval expired — not run.'), APPROVAL_TTL_MS);
      // A pending approval must not keep the process alive on its own.
      if (typeof timer.unref === 'function') timer.unref();
      this.approvals.set(token, { resolve, userId, chatId, handle, timer });
    });
  }

  settleApproval(token, approved, note) {
    const a = this.approvals.get(token);
    if (!a) return;
    this.approvals.delete(token);
    clearTimeout(a.timer);
    a.resolve(approved);
    if (a.handle) this.adapter.settle(a.handle, note).catch(() => {});
  }

  async handleAction(action) {
    const [kind, token, choice] = String(action.data || '').split(':');
    if (kind === 'pl') return this.handlePlanAction(action, token, choice);
    const a = kind === 'ap' ? this.approvals.get(token) : null;
    if (!a) return action.ack('This request has expired.', { refusal: true });
    if (String(action.userId) !== String(a.userId)) return action.ack('Only the person who asked can approve this.', { refusal: true });
    const approved = choice === 'y';
    await action.ack(approved ? 'Running…' : 'Not run.');
    this.settleApproval(token, approved, approved ? 'Approved — running.' : 'Declined — not run.');
    return undefined;
  }

  async handlePlanAction(action, token, choice) {
    const p = this.plans.get(token);
    if (!p) return action.ack('This plan has expired — ask again.', { refusal: true });
    if (String(action.userId) !== String(p.userId)) return action.ack('Only the person who asked can build this.', { refusal: true });
    this.plans.delete(token);
    const build = choice === 'b';
    await action.ack(build ? 'Building…' : 'Cancelled.');
    if (p.handle) this.adapter.settle(p.handle, build ? 'Building…' : 'Cancelled — nothing was built.').catch(() => {});
    if (!build) {
      await this.runner.note(p.convoId, [{ role: 'assistant', kind: 'final', text: 'Plan cancelled — nothing was built.' }],
        { agentMode: 'main', workflowSession: null }, { planStatus: { kind: 'cancelled', message: `Plan discarded (from ${this.label}).` } });
      return undefined;
    }
    return this.runPlan(p.chatId, p.userId, p.convoId, p.plan);
  }

  // ── a file → a connection ───────────────────────────────────────────────

  async handleFile(event) {
    const { chatId, file } = event;
    const originalName = file.name || 'upload';
    const ext = path.extname(originalName).toLowerCase();
    if (!FILE_TYPE_BY_EXT[ext]) {
      return this.adapter.sendPlain(chatId, `I can't add ${originalName} — send a CSV, TSV, Excel (.xlsx), JSON, `
        + 'NDJSON, Parquet or Avro file.');
    }
    if (file.size && file.size > this.adapter.maxFileBytes) {
      return this.adapter.sendPlain(chatId, `That file is over ${Math.round(this.adapter.maxFileBytes / 1024 / 1024)} MB, `
        + `the most I take through ${this.label}. Add it in Ternlux → Connections instead.`);
    }
    const stopWorking = this.adapter.startWorking(chatId, event, 'upload');
    try {
      const buffer = await this.adapter.downloadFile(file);
      const localPath = await this.saveUpload(chatId, originalName, buffer);
      const caption = String(event.text || '').trim();
      const { connection, tables } = await this.importFile(localPath, {
        name: caption || path.basename(originalName, ext),
        originalName,
        fileType: FILE_TYPE_BY_EXT[ext],
      });
      return this.adapter.sendRich(chatId, [
        ['Added ', { b: connection.name }, ' as a connection.'],
        ...(tables || []).slice(0, 10).map((t) => ['• ', { code: t.name }, t.columns ? ` — ${t.columns} columns` : '']),
        'Ask me about it here, or use it in a workflow.',
      ]);
    } catch (err) {
      this.log.error(`[${this.adapter.platform}] file import failed:`, err.message);
      return this.adapter.sendPlain(chatId, `I couldn't add ${originalName}: ${err.message}`);
    } finally {
      stopWorking();
    }
  }
}

module.exports = { MessagingBridge, planLines, FILE_TYPE_BY_EXT, APPROVAL_TTL_MS, STEP_BADGE };
