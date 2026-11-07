/**
 * What every chat bridge (Telegram, Slack) shares in the main process: the
 * background chat runner, the workflow-build runner, chart images, and the
 * window notifications that keep an open Ternlux in step with the chat.
 */

const { createConversationRunner } = require('./conversation');
const { createWorkflowBuildRunner } = require('./workflowBuild');
const { renderChartPng } = require('./chartImage');

function createMessagingDeps({ chatAssistant, getDb, buildSkillHelpers, BrowserWindow, broadcast = () => {} }) {
  return {
    runner: createConversationRunner({
      chatAssistant, getDb, buildSkillHelpers,
      // The chat panel reads its history once, at startup — tell it about each
      // save so a chat-app conversation appears (and updates) while it is open.
      onSaved: (id) => broadcast('chat:sessions-changed', { id }),
    }),
    // Lazy: workflowBuilder is large and only needed once a plan is built.
    builds: createWorkflowBuildRunner({
      workflowBuilder: { executeBuild: (args) => require('../chat/workflowBuilder').executeBuild(args) },
      getDb,
      buildSkillHelpers,
    }),
    renderChart: (visual) => renderChartPng(visual, BrowserWindow),
    // Refresh the Workflows list in any open window — without opening the new
    // workflow, which could pull the user out of what they are editing.
    onWorkflowBuilt: (info) => broadcast('workflows:changed', info),
  };
}

module.exports = { createMessagingDeps };
