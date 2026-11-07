/**
 * Build a workflow plan with no window — what the chat panel's Accept button
 * does (runBuild in src/components/Chat/ChatAssistant.js), for the messaging
 * bridges.
 *
 * A build can stop part-way and wait for the user; the window and this module
 * resume it the same way:
 *   - approval  a step generated code it must run (a REST API fetch), or wants
 *               to recreate a table → approve() then build again
 *   - question  a step needs an answer → answer() then build again
 * Either way the plan carries what was already built (builtSteps,
 * buildWorkflowId), so the next pass resumes instead of starting over.
 */

function createWorkflowBuildRunner({ workflowBuilder, getDb, buildSkillHelpers }) {
  /**
   * @returns {Promise<
   *   { kind: 'built', workflowId, workflowName, nodeCount, edgeCount, warnings, plan } |
   *   { kind: 'approval', approval, question, stepIndex, plan } |
   *   { kind: 'question', question, stepIndex, plan } |
   *   { kind: 'failed', message, plan }
   * >}
   */
  async function build(plan, { onProgress = () => {} } = {}) {
    let workflow = null;
    if (plan.mode === 'modify' && plan.workflowId) {
      workflow = await getDb('workflows').findOneAsync({ $or: [{ id: plan.workflowId }, { _id: plan.workflowId }] });
    }
    try {
      const helpers = await buildSkillHelpers();
      const result = await workflowBuilder.executeBuild({ plan, workflow, helpers, getDb, onProgress });
      return {
        kind: 'built',
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        nodeCount: result.nodes.length,
        edgeCount: result.edges.length,
        warnings: (result.warnings || []).filter(Boolean),
        plan,
      };
    } catch (err) {
      // What was built before the stop rides on the plan, so the next pass
      // skips it and writes under the same workflow id.
      const carried = {
        ...plan,
        ...(err?.builtSteps ? { builtSteps: { ...(plan.builtSteps || {}), ...err.builtSteps } } : {}),
        ...(err?.buildWorkflowId ? { buildWorkflowId: err.buildWorkflowId } : {}),
      };
      const stepIndex = Number.isInteger(err?.stepIndex) ? err.stepIndex : null;
      if (err?.isClarificationNeeded && err.isApprovalNeeded) {
        return { kind: 'approval', approval: err.context?.approval || {}, question: err.question, stepIndex, plan: carried };
      }
      if (err?.isClarificationNeeded) {
        const skill = err.context?.skill;
        const next = skill && stepIndex != null
          ? { ...carried, pendingSkills: { ...(carried.pendingSkills || {}), [stepIndex]: skill } }
          : carried;
        return { kind: 'question', question: err.question, stepIndex, plan: next };
      }
      if (err?.code === 'MAX_TOKENS') {
        return { kind: 'failed', message: 'The AI ran out of room while building a step. Open Ternlux and press Continue on the build to finish it.', plan: carried };
      }
      return { kind: 'failed', message: err?.message || String(err), plan: carried };
    }
  }

  // The plan to build next after the user approved a parked step: that step's
  // function marked approved, its analysis call replayed — exactly what
  // handleBuildApproval does in the window.
  function approve(plan, approval, stepIndex) {
    const prevCalls = plan.resumedCalls || {};
    return {
      ...plan,
      apiFetchApprovals: { ...(plan.apiFetchApprovals || {}), [stepIndex]: approval.code },
      resumedCalls: { ...prevCalls, [stepIndex]: { ...(prevCalls[stepIndex] || {}), ...(approval.resumedCalls || {}) } },
    };
  }

  // The plan to build next with the user's answer to a step's question, scoped
  // to that step (a null stepIndex would be seeded into every step's chat).
  function answer(plan, question, text, stepIndex) {
    return {
      ...plan,
      clarifications: [...(Array.isArray(plan.clarifications) ? plan.clarifications : []), { question, answer: text, stepIndex }],
    };
  }

  return { build, approve, answer };
}

module.exports = { createWorkflowBuildRunner };
