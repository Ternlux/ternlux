/**
 * Headless chat assistant: one user message in, one answer out, with no
 * window involved. Used by the messaging bridges (Telegram today), where a
 * message arrives in the main process and nothing on screen drives the loop.
 *
 * It is the same loop the chat window runs (src/components/Chat/ChatAssistant.js,
 * the step loop in its send handler), minus everything tied to the canvas:
 *   - calls chatAssistant.runStep until the answer is done (MAX_STEPS cap),
 *   - replays this question's tool steps through `scratchpad`,
 *   - pauses on generated code until the user approves (`requestApproval`),
 *   - restarts with a deferred plan_workflow_build, as the window does,
 *   - stores the conversation in the same `chatSessions` collection, in the
 *     same message shape, so it can be opened and continued in the app.
 *
 * A plan card (propose_plan) is a hard stop here as it is in the window: the
 * answer carries `workflowPlan`, and building it is a separate decision.
 */

const MAX_STEPS = 8;

// What a batched call held back behind a code approval says (chatAssistant.js),
// and what it says once that approval is settled — same wording as the window.
const HELD_BACK = /^Not run: an earlier call in this step is waiting for the user to approve/;
const HELD_BACK_SETTLED = 'Not run: it was held back while an earlier call in this step waited for the user to approve its code. That approval is now settled and its result is in this step. Call this again now if you still need it — there is nothing left for the user to approve.';

const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nowTs = () => new Date().toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });

// NeDB refuses keys starting with `$` — same rewrite the chat window applies
// before it persists (sanitizeForNedb in ChatAssistant.js).
function sanitizeForNedb(value) {
  if (Array.isArray(value)) return value.map(sanitizeForNedb);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[typeof k === 'string' && k.startsWith('$') ? `_${k}` : k] = sanitizeForNedb(v);
    }
    return out;
  }
  return value;
}

// The history the model reads: the conversation before this turn, shaped
// exactly as the chat window sends it.
function historyFrom(messages) {
  return (messages || [])
    .filter((m) => m.kind !== 'buildLog' && m.kind !== 'nodeRun')
    .map((m) => (m.kind === 'step'
      ? { role: 'assistant', kind: 'step', stepIndex: m.stepIndex, thought: m.thought, actions: m.actions }
      : {
        role: m.role,
        text: m.text,
        ...(m.clarification ? { clarification: true } : {}),
        ...(m.agentSource ? { agentSource: m.agentSource } : {}),
      }));
}

// What the model is told when its approved code failed. Same wording and
// reasons as the chat window: the source travels back so the model can read
// its own error, and it must stop rather than guess again.
function failureForModel(message, source) {
  return [
    message,
    '',
    'This is the function that failed — you wrote it, so read the error against it before '
    + 'concluding anything about the connection or the endpoint:',
    source || '(source unavailable)',
    '',
    'Now STOP and tell the user, in your answer: what you called, what came back, and what '
    + 'you think is wrong. Do NOT call run_javascript again on your own — not with a '
    + 'different endpoint, a different auth scheme, or error handling that hides the '
    + 'failure. Wait for the user. When they tell you what to change (a URL, a parameter, '
    + 'where the credential goes), apply exactly that and call run_javascript again.',
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.chatAssistant   public/chat/chatAssistant.js
 * @param {Function} deps.getDb         collection → NeDB datastore
 * @param {Function} deps.buildSkillHelpers
 * @param {Function} [deps.onSaved]     (convoId) → void, after every save — lets an
 *                                      open chat panel show the conversation live
 */
function createConversationRunner({
  chatAssistant, getDb, buildSkillHelpers, maxSteps = MAX_STEPS, onSaved = () => {},
}) {
  const sessions = () => getDb('chatSessions');

  async function load(convoId) {
    return sessions().findOneAsync({ id: convoId });
  }

  async function save(convo) {
    const doc = { ...convo, updatedAt: Date.now() };
    await sessions().updateAsync({ id: convo.id }, { $set: sanitizeForNedb(doc) }, { upsert: true });
    try { onSaved(convo.id); } catch (_err) { /* a listener must not break the turn */ }
  }

  /**
   * Answer one message in a conversation.
   *
   * @param {object} turn
   * @param {string} turn.convoId          chatSessions id; created when it does not exist
   * @param {string} turn.text             the user's message
   * @param {object} [turn.source]         where it came from, kept on the session ({ platform, chatId, … })
   * @param {Function} turn.requestApproval  ({ runToken, code, explanation }) → Promise<boolean>
   * @param {Function} [turn.onStatus]     (stage) → void, for "typing…" style feedback
   * @param {Function} [turn.isCancelled]  () → boolean. Checked between steps: an AI
   *                                       call already in flight finishes, and its
   *                                       result is dropped (as the app's Stop does).
   * @returns {Promise<{ answer, visuals, workflowPlan, error, title, cancelled }>}
   */
  async function runTurn({
    convoId, text, source = null, requestApproval, onStatus = () => {}, isCancelled = () => false,
  }) {
    const message = String(text || '').trim();
    if (!message) throw new Error('message is required');

    const now = Date.now();
    const convo = (await load(convoId)) || {
      id: convoId, title: 'New chat', messages: [], agentMode: 'main', workflowSession: null,
      pendingBuild: null, createdAt: now, updatedAt: now,
    };
    if (source) convo.source = source;
    const isNewChat = convo.messages.length === 0;
    const history = historyFrom(convo.messages);
    const append = (m) => { convo.messages.push({ id: newId('m'), ts: nowTs(), ...m }); };
    append({ role: 'user', text: message, agentMode: convo.agentMode, workflowSession: convo.workflowSession });
    await save(convo);

    const scratchpad = [];
    let agentMode = convo.agentMode || 'main';
    let workflowSession = convo.workflowSession || null;
    let triggerPlanWorkflowBuild = null;
    let pendingPlanArgs = null;
    const outcome = { answer: null, visuals: [], workflowPlan: null, error: null, title: convo.title, cancelled: false };
    const stopped = () => {
      outcome.cancelled = true;
      append({ role: 'assistant', kind: 'final', text: '_Stopped by user._' });
    };

    try {
      for (let i = 0; i < maxSteps; i++) {
        if (isCancelled()) { stopped(); break; }
        onStatus(agentMode === 'workflow' ? 'Workflow builder…' : 'Thinking…');
        let resp;
        try {
          const helpers = await buildSkillHelpers();
          resp = await chatAssistant.runStep({
            message, history, scratchpad, activeContext: null, provider: null,
            agentMode, workflowSession, triggerPlanWorkflowBuild, targetNode: null,
            isNewChat, getDb, helpers,
            // Tells the assistant it is answering in Telegram / Slack, so
            // questions about "the chat" are answered for that app.
            channel: source?.platform ? { platform: source.platform } : null,
          });
        } catch (err) {
          outcome.error = err.message || String(err);
          append({ role: 'assistant', error: true, text: `Error: ${outcome.error}` });
          break;
        }
        triggerPlanWorkflowBuild = null;
        // Stopped while the AI was answering: drop what came back.
        if (isCancelled()) {
          if (resp?.pendingApproval) {
            try { chatAssistant.discardPendingJavascript(resp.pendingApproval.runToken); } catch (_err) { /* gone */ }
          }
          stopped();
          break;
        }

        if (!resp?.success) {
          outcome.error = resp?.message || 'The assistant could not answer that. Check the AI provider in Settings.';
          append({ role: 'assistant', error: true, text: outcome.error });
          break;
        }
        if (resp.chatTitle) { convo.title = resp.chatTitle; outcome.title = resp.chatTitle; }
        if (resp.nextAgentMode) agentMode = resp.nextAgentMode;
        if ('workflowSession' in resp) workflowSession = resp.workflowSession || null;
        if (resp.pendingPlanWorkflowBuild) pendingPlanArgs = resp.pendingPlanWorkflowBuild.args || {};

        if (resp.step) {
          scratchpad.push({
            index: resp.step.index ?? scratchpad.length + 1,
            thought: resp.step.thought || '',
            ...(resp.step.assistantRaw ? { assistantRaw: resp.step.assistantRaw } : {}),
            actions: (resp.step.actions || []).map((a) => ({
              ...(a.id ? { id: a.id } : {}),
              tool: a.tool,
              args: a.args,
              ok: a.ok,
              ...(a.error ? { error: a.error } : { result: a.result }),
            })),
          });
        }

        const pa = resp.pendingApproval || null;
        const hasActions = Array.isArray(resp.actions) && resp.actions.length > 0;
        let stepMsg = null;
        if (hasActions || pa) {
          append({
            role: 'assistant', kind: 'step',
            stepIndex: resp.step?.index ?? scratchpad.length,
            thought: resp.thought,
            actions: resp.actions,
            ...(pa ? { approval: { state: 'pending', runToken: pa.runToken, code: pa.transformFunction || '', explanation: pa.explanation || '' } } : {}),
          });
          stepMsg = convo.messages[convo.messages.length - 1];
        }
        await save(convo);

        if (pa) {
          onStatus('Waiting for approval…');
          let approved = false;
          try {
            approved = !!(await requestApproval({
              runToken: pa.runToken, code: pa.transformFunction || '', explanation: pa.explanation || '',
            }));
          } catch (_err) {
            approved = false;
          }
          if (stepMsg) stepMsg.approval.state = approved ? 'approved' : 'declined';
          if (!approved) {
            try { chatAssistant.discardPendingJavascript(pa.runToken); } catch (_err) { /* already gone */ }
            outcome.answer = 'Code not run. Tell me what to change and I\'ll rewrite it.';
            append({ role: 'assistant', kind: 'final', text: `_${outcome.answer}_` });
            break;
          }
          onStatus('Running approved code…');
          let exec;
          try {
            const helpers = await buildSkillHelpers();
            exec = { success: true, result: await chatAssistant.runApprovedJavascript({ runToken: pa.runToken, helpers, provider: null }) };
          } catch (err) {
            exec = { success: false, message: err.message || String(err) };
          }
          // Replay the outcome into the action slot the model is waiting on —
          // and into the stored step, so later turns read what really happened.
          const slot = scratchpad[scratchpad.length - 1];
          const isSlot = (a, list) => a.id === pa.actionId
            || (!list.some((x) => x.id === pa.actionId) && a.tool === 'run_javascript');
          const patch = (a) => {
            delete a.result; delete a.error;
            if (exec.success) { a.ok = true; a.result = exec.result; } else {
              a.ok = false; a.error = failureForModel(exec.message || 'The approved code failed to run.', pa.transformFunction);
            }
          };
          (slot?.actions || []).filter((a, _i, list) => isSlot(a, list)).slice(0, 1).forEach(patch);
          (stepMsg?.actions || []).filter((a, _i, list) => isSlot(a, list)).slice(0, 1).forEach(patch);
          // A call held back behind this approval no longer waits on anything.
          for (const a of [...(slot?.actions || []), ...(stepMsg?.actions || [])]) {
            if (HELD_BACK.test(a.error || '')) a.error = HELD_BACK_SETTLED;
          }
          await save(convo);
          continue;
        }

        if (resp.done) {
          outcome.answer = resp.finalAnswer || '(no answer)';
          outcome.visuals = Array.isArray(resp.visuals) ? resp.visuals : [];
          outcome.workflowPlan = resp.workflowPlan || null;
          append({
            role: 'assistant', kind: 'final', text: outcome.answer,
            workflowPlan: outcome.workflowPlan,
            visuals: outcome.visuals.length ? outcome.visuals : null,
            clarification: !!resp.clarification,
            agentSource: resp.agentSource || null,
          });
          if (resp.workflowPlan) break;
          if (pendingPlanArgs) {
            triggerPlanWorkflowBuild = pendingPlanArgs;
            pendingPlanArgs = null;
            i = -1;
            continue;
          }
          break;
        }

        if (i === maxSteps - 1) {
          outcome.error = `Reached the ${maxSteps}-step limit without a final answer. Ask a more specific follow-up.`;
          append({ role: 'assistant', error: true, text: outcome.error });
        }
      }
    } finally {
      convo.agentMode = agentMode;
      convo.workflowSession = workflowSession;
      await save(convo);
    }
    return outcome;
  }

  /**
   * Append messages to a stored conversation outside a turn — a workflow
   * build's progress and result, a declined approval. `patch` sets
   * conversation fields too (e.g. agentMode back to 'main' after a build).
   */
  async function note(convoId, messages = [], patch = {}, { planStatus = null } = {}) {
    const convo = await load(convoId);
    if (!convo) return;
    // The plan card in the app reads `planStatus` on the message that carries
    // the plan: set, it replaces Accept / Cancel with this status line.
    if (planStatus) {
      const card = [...convo.messages].reverse().find((m) => m.workflowPlan);
      if (card) card.planStatus = planStatus;
    }
    for (const m of messages) convo.messages.push({ id: newId('m'), ts: nowTs(), ...m });
    Object.assign(convo, patch);
    await save(convo);
  }

  return { runTurn, load, note };
}

module.exports = { createConversationRunner, historyFrom, sanitizeForNedb, MAX_STEPS };
