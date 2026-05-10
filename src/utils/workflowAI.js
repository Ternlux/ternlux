/**
 * AI-powered workflow assistance
 * Provides intelligent responses for workflow node configuration
 */

import { getConfiguredProvider, callAI } from './aiProviders';


/**
 * Node type prompts - different for each workflow node type
 */
const NODE_PROMPTS = {
  dataSource: (userMessage, context) => `You are a database expert helping a user query their data source.

User's question: "${userMessage}"

Context:
- Database type: ${context.dbType || 'Unknown'}
- Available tables: ${context.tables?.join(', ') || 'Unknown'}

Based on the user's natural language request, provide:
1. A clear explanation of what data they're looking for
2. A SQL query that retrieves that data
3. Any important considerations (e.g., limit rows, join requirements)

Return your response in this format:
{
"explanation": "Brief explanation of the SQL logic"
"sql": "The SQL query"
}
Be specific and provide working SQL code.`,

  transformer: (userMessage, context) => {
    return userMessage
    // const transformationType = context.transformationType || 'custom';
    // const promptGenerator = TRANSFORMATION_PROMPTS[transformationType];

    // if (promptGenerator) {
    //   return promptGenerator(userMessage, context);
    // }

    // return TRANSFORMATION_PROMPTS.custom(userMessage, context);
  },

  join: (userMessage, context) => `You are a SQL join expert helping a user combine datasets.

User's request: "${userMessage}"

Context:
- Dataset 1 columns: ${context.dataset1Columns?.join(', ') || 'Unknown'}
- Dataset 2 columns: ${context.dataset2Columns?.join(', ') || 'Unknown'}
- Number of datasets: ${context.datasetCount || 2}

Provide guidance on:
1. Which columns to join on (common keys)
2. What type of join to use (INNER, LEFT, RIGHT, FULL)
3. SQL JOIN syntax example

Format:
JOIN TYPE: [INNER/LEFT/RIGHT/FULL]
JOIN CONDITION: [column1 = column2]
SQL EXAMPLE: [Full SQL with JOIN]

Be specific with SQL syntax.`,

  output: (userMessage, context) => `You are a data export expert helping a user configure output settings.

User's request: "${userMessage}"

Context:
- Output type: ${context.outputType || 'analysis'}
- Data columns available: ${context.columns?.join(', ') || 'Unknown'}
- Email notifications: ${context.emailEnabled ? 'Enabled' : 'Disabled'}

Provide guidance on:
1. How to format the output
2. What analysis or summary to include
3. Best practices for the export

Keep your response focused on practical export configuration.`,

  start: (userMessage, context) => `You are a workflow automation expert helping a user configure workflow triggers.

User's question: "${userMessage}"

Context:
- Current trigger type: ${context.triggerType || 'manual'}
- Workflow name: ${context.workflowName || 'Untitled'}

Explain:
1. Available trigger options (manual, scheduled, event-based)
2. How to configure the requested trigger
3. Best practices for workflow automation

Keep your response clear and actionable.`,
};

/**
 * Format chat history for the LLM
 * @param {Array} chatHistory - Array of chat messages
 * @returns {string} - Formatted chat history
 */
function formatChatHistory(chatHistory = []) {
  if (!chatHistory || chatHistory.length === 0) {
    return '';
  }

  const formattedMessages = chatHistory
    .filter(msg => msg.sender === 'user' || msg.sender === 'bot')
    .map((msg, index) => {
      const role = msg.sender === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid token limits
      const text = msg.text.length > 500 ? msg.text.substring(0, 500) + '...' : msg.text;
      return `${role}: ${text}`;
    })
    .join('\n');

  return `\n\nPrevious Conversation:\n${formattedMessages}\n\nCurrent User Request (respond to this):\n`;
}

/**
 * Generate a prompt for the AI based on node type and user message
 * @param {string} nodeType - The type of workflow node
 * @param {string} userMessage - The user's message/question
 * @param {Object} context - Additional context (columns, settings, etc.)
 * @param {Array} chatHistory - Previous chat messages for context
 * @returns {string} - The generated prompt
 */
export function generatePrompt(nodeType, userMessage, context = {}, chatHistory = []) {
  const promptGenerator = NODE_PROMPTS[nodeType];

  let basePrompt;
  if (!promptGenerator) {
    // Fallback for unknown node types
    basePrompt = userMessage;
  } else {
    basePrompt = promptGenerator(userMessage, context);
  }

  // Append chat history if available
  const history = formatChatHistory(chatHistory);

  return basePrompt + history;
}

/**
 * Get AI assistance for a workflow node
 * @param {string} nodeType - The type of workflow node
 * @param {string} userMessage - The user's message/question
 * @param {Object} context - Additional context
 * @param {Array} chatHistory - Previous chat messages for context
 * @param {Object} options - AI options (temperature, maxTokens)
 * @returns {Promise<string>} - The AI response
 */
export async function getWorkflowAssistance(nodeType, userMessage, context = {}, chatHistory = [], options = {}) {
  try {
    // Get the configured provider
    const provider = await getConfiguredProvider();

    if (!provider) {
      throw new Error('No AI provider configured. Please set up your API key in settings.');
    }

    // Generate the prompt WITHOUT chat history (we'll pass it separately)
    const promptGenerator = NODE_PROMPTS[nodeType];
    let prompt;
    if (!promptGenerator) {
      // Fallback for unknown node types
      prompt = userMessage;
    } else {
      prompt = promptGenerator(userMessage, context);
    }

    // Set default options with chat history
    const aiOptions = {
      systemPrompt: 'You are an expert data engineering assistant helping users configure workflow nodes. Provide clear, concise, and technically accurate guidance. When providing SQL, ensure it is syntactically correct and well-formatted. Consider the conversation history to provide contextually relevant responses.',
      chatHistory: chatHistory || [],
      ...options
    };
    // console.log('provider, prompt, aiOptions: ', prompt, aiOptions)
    // Call the AI with chat history passed separately
    const response = await callAI(prompt, aiOptions);

    return response;
  } catch (error) {
    console.error('Error getting workflow assistance:', error);
    throw error;
  }
}

/**
 * Extract SQL from AI response
 * Looks for SQL blocks in the response and extracts them
 * @param {string} response - The AI response
 * @returns {string|null} - Extracted SQL or null
 */
export function extractSQL(response) {
  // Try to find SQL between SQL: and the next section or end
  const sqlMatch = response.match(/SQL:\s*```(?:sql)?\s*([\s\S]*?)```/i);
  if (sqlMatch) {
    return sqlMatch[1].trim();
  }

  // Try to find SQL: followed by the query
  const sqlLineMatch = response.match(/SQL:\s*([^\\n]+(?:\n(?!(?:NOTES|EXPLANATION):)[^\n]+)*)/i);
  if (sqlLineMatch) {
    return sqlLineMatch[1].trim();
  }

  // Try to find any SQL code block
  const codeBlockMatch = response.match(/```(?:sql)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  return null;
}

/**
 * Parse transformation suggestions from AI response
 * @param {string} response - The AI response
 * @returns {Object} - Parsed transformation details
 */
export function parseTransformationResponse(response) {
  const result = {
    explanation: '',
    sql: null,
    steps: [],
    notes: ''
  };

  // Extract explanation
  const explanationMatch = response.match(/EXPLANATION:\s*([^\n]+(?:\n(?!(?:SQL|NOTES|STEPS):)[^\n]+)*)/i);
  if (explanationMatch) {
    result.explanation = explanationMatch[1].trim();
  }

  // Extract SQL
  result.sql = extractSQL(response);

  // Extract notes
  const notesMatch = response.match(/NOTES:\s*([^\n]+(?:\n(?!(?:SQL|EXPLANATION):)[^\n]+)*)/i);
  if (notesMatch) {
    result.notes = notesMatch[1].trim();
  }

  // If no structured format, use the whole response as explanation
  if (!result.explanation && !result.sql) {
    result.explanation = response;
  }

  return result;
}

/**
 * Parse join suggestions from AI response
 * @param {string} response - The AI response
 * @returns {Object} - Parsed join details
 */
export function parseJoinResponse(response) {
  const result = {
    joinType: 'INNER',
    joinCondition: '',
    sql: null,
    explanation: ''
  };

  // Extract join type
  const joinTypeMatch = response.match(/JOIN TYPE:\s*(\w+)/i);
  if (joinTypeMatch) {
    result.joinType = joinTypeMatch[1].toUpperCase();
  }

  // Extract join condition
  const conditionMatch = response.match(/JOIN CONDITION:\s*([^\n]+)/i);
  if (conditionMatch) {
    result.joinCondition = conditionMatch[1].trim();
  }

  // Extract SQL
  result.sql = extractSQL(response);

  // Use the whole response as explanation if no structured parts
  result.explanation = response;

  return result;
}

export default {
  generatePrompt,
  getWorkflowAssistance,
  extractSQL,
  parseTransformationResponse,
  parseJoinResponse
};
