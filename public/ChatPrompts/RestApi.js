/**
 * Chat Prompts for REST API DataSource Configuration
 *
 * The user has already picked a REST API connection (which owns baseUrl +
 * auth). This prompt turns their natural-language request into:
 *   - `code`: a single async JavaScript function expression that performs the
 *     fetch (including any pagination / looping logic) and returns rows.
 *   - `explanation`: one-line summary of what the function does.
 *
 * Secrets MUST be referenced only via the placeholder vocabulary below, and
 * only inside string literals / template literals. The main-process runner
 * substitutes placeholders using credentials decrypted from the OS keychain
 * before evaluating the function.
 *
 * Placeholder vocabulary is scoped to the connection's authType so the prompt
 * only surfaces the tokens that are actually valid for this connection — a
 * Bearer connection won't see `{{BASIC_USERNAME}}`, a none-auth connection
 * won't see any auth header placeholders, etc.
 */

// Placeholders common to every REST API request.
const BASE_PLACEHOLDERS = ['{{BASE_URL}}'];

// Auth-scoped placeholders. Keep in sync with ApiFetch.js `buildPlaceholderMap`.
const AUTH_PLACEHOLDERS = {
  none: [],
  bearer: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{BEARER_TOKEN}}'],
  apiKey: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{API_KEY_VALUE}}'],
  basic: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{BASIC_USERNAME}}', '{{BASIC_PASSWORD}}'],
};

function placeholdersFor(authType) {
  const auth = AUTH_PLACEHOLDERS[authType] || AUTH_PLACEHOLDERS.none;
  return [...BASE_PLACEHOLDERS, ...auth];
}

// Auth-specific guidance the model needs in order to write correct headers.
// Each branch only describes its own scheme — we do not mention other schemes
// so the model has a single, unambiguous path.
function authGuidance({ authType, apiKeyName, basicUser }) {
  switch (authType) {
    case 'bearer':
      return `**Authentication — Bearer Token**
This connection authenticates with a Bearer token. Attach the auth header on
every request using the resolved header placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
At runtime \`{{AUTH_HEADER_NAME}}\` becomes \`Authorization\` and
\`{{AUTH_HEADER_VALUE}}\` becomes \`Bearer <token>\`. If you need the raw token
inside a query string or request body, use \`{{BEARER_TOKEN}}\` instead.`;

    case 'apiKey': {
      const nameHint = apiKeyName && String(apiKeyName).trim()
        ? `\`${String(apiKeyName).trim()}\``
        : '`X-API-Key` (default when the user didn\'t set a header name)';
      return `**Authentication — API Key header**
This connection authenticates with an API key sent as a request header. The
header name is ${nameHint}. Attach it on every request using the resolved
header placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
If the API expects the key in a query string or body instead of a header, use
\`{{API_KEY_VALUE}}\` in that location and OMIT the auth header.`;
    }

    case 'basic': {
      const userHint = basicUser && String(basicUser).trim()
        ? ` (username: \`${String(basicUser).trim()}\`)`
        : '';
      return `**Authentication — HTTP Basic**
This connection authenticates with HTTP Basic auth${userHint}. Attach the
pre-encoded auth header on every request using the resolved header
placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
At runtime \`{{AUTH_HEADER_NAME}}\` becomes \`Authorization\` and
\`{{AUTH_HEADER_VALUE}}\` becomes \`Basic <base64(user:pass)>\` — the encoding is
done for you. Do NOT build the Base64 yourself. If the API requires the raw
credentials elsewhere, use \`{{BASIC_USERNAME}}\` and \`{{BASIC_PASSWORD}}\`.`;
    }

    case 'none':
    default:
      return `**Authentication — None**
This connection has no authentication configured. Do NOT add an
\`Authorization\` header, an API key header, or any credential query-string
parameters. Call the endpoint anonymously.`;
  }
}

// Example that matches the connection's auth type. Mirrors the same style
// every example ships with — GET + axios + pagination guard — so the model
// has one concrete pattern for this specific auth scheme.
function authExample(authType) {
  const headerLine = authType === 'none'
    ? ''
    : `      headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' },\n`;

  return `\`\`\`javascript
async function fetchData({ axios }) {
  const rows = [];
  let page = 1;
  const MAX_PAGES = 500;
  while (page <= MAX_PAGES) {
    const res = await axios({
      method: 'GET',
      url: \`{{BASE_URL}}/items?page=\${page}&limit=100\`,
${headerLine}      timeout: 30000,
    });
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    if (items.length === 0) break;
    rows.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return rows;
}
\`\`\``;
}

const RestApiPrompts = {
  /**
   * Build the analysis prompt. The model decides whether to answer, ask a
   * follow-up, or return a complete fetch function.
   */
  restApiAnalysisRequest: ({
    userRequest,
    connectionAuthType,
    connectionBaseUrl,
    connectionApiKeyName = '',
    connectionBasicUser = '',
    conversationHistory = '',
  }) => {
    const authType = connectionAuthType || 'none';
    const vocabulary = placeholdersFor(authType);
    const guidance = authGuidance({
      authType,
      apiKeyName: connectionApiKeyName,
      basicUser: connectionBasicUser,
    });
    const example = authExample(authType);

    return `
You are a REST API integration expert helping a non-technical user pull data
from an HTTP endpoint. A connection named "REST API" is already selected; it
carries the base URL and auth credentials. You never see the raw credentials —
you only use placeholder tokens in your output.

**Connection context**
- Base URL: ${connectionBaseUrl || '(not set — user must supply full URLs)'}
- Auth type: ${authType}

**Current user request**
"${userRequest}"

**Your task**
Write a SINGLE JavaScript async function expression that uses the injected
\`axios\` to fetch the requested data and returns the resulting rows as an
array of plain objects. The function may loop over pages, cursor tokens, or
related endpoints — put any looping logic inside the function itself.

**Function contract**
- It is an async function expression. It may be named or anonymous.
- It takes one argument: \`{ axios }\`.
- It returns an array of plain objects (one per row). If the API returns a
  single object, wrap it as \`[obj]\`. If it returns nothing, return \`[]\`.
- No \`require\`, no \`import\`, no module exports, no top-level statements
  outside the function. Only the function expression itself.
- Use standard JS only (\`let\`, \`const\`, \`while\`, \`for\`, \`await\`, etc.).

**Placeholder vocabulary** — the ONLY tokens you may emit for this connection.
They MUST appear only inside JS string literals or template literals, never as
identifiers or bare object keys.
${vocabulary.map(p => `- ${p}`).join('\n')}

- Use \`{{BASE_URL}}\` as the URL prefix when the user's request is relative.
- Do NOT invent placeholders outside this list. Do NOT write raw tokens,
  passwords, or api keys inline.

${guidance}

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. If you need to explain something or answer a question, put that text inside the "directAnswer"/"explanation" fields — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.

Return JSON with EXACTLY this shape (no extra keys):

\`\`\`json
{
  "action": "answer_directly" | "ask_questions" | "create_plan",
  "followUpQuestion": "single clear question (only if action is ask_questions)",
  "directAnswer": "answer (only if action is answer_directly)",
  "code": "async function fetchData({ axios }) { /* ... */ return rows; }",
  "explanation": "One sentence describing what the function does, including any looping behavior."
}
\`\`\`

RULES:

1. **answer_directly** — user is asking a question and does not yet want to
   configure a request. Fill \`directAnswer\`. Leave \`code\` and
   \`explanation\` as nulls.

2. **ask_questions** — you need one more detail before you can write the
   function. Fill \`followUpQuestion\`. Leave code/explanation as nulls.

3. **create_plan** — you have enough to describe the exact call. Populate
   \`code\` and \`explanation\`.

4. \`code\` MUST be a single async function expression. It is passed directly
   to \`new Function("return (" + code + ");")\` in the runtime, so a function
   declaration like \`async function fetchData(...) { ... }\` works — it is
   wrapped to become an expression.

5. Prefer sensible defaults for the user (e.g. GET, \`Accept: application/json\`,
   30s timeout via \`timeout: 30000\` in axios config, reasonable page size).

6. For pagination, loop until the API returns no more results, a \`next\`
   cursor is absent, or a page is partial — your choice, but make it correct
   for the API at hand. Guard against infinite loops with an upper bound
   (e.g. 500 pages).

**Example — paginated GET for this auth type**

${example}

Return ONLY the JSON object. No markdown fences, no commentary.
`;
  },
};

module.exports = RestApiPrompts;
module.exports.default = RestApiPrompts;
module.exports.placeholdersFor = placeholdersFor;
