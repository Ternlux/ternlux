/**
 * Chat prompt for WRITING rows to a REST API — an Output node whose
 * destination is an API connection, or a Join that writes to one.
 *
 * The sibling of RestApi.js (which writes the fetch function of a Data Source).
 * The model writes ONE async function, `sendBatch({ axios, rows, batchIndex })`,
 * that sends a batch of rows and reports what the API accepted. The runner
 * (NodeExecution/ApiWrite.js) cuts the source into batches of `batchSize`
 * rows, fills in the credential placeholders and calls it once per batch.
 *
 * Credentials are reached the same way as in a fetch: {{PLACEHOLDER}} tokens
 * inside string literals, values filled in by the main process.
 */

const { placeholdersFor, paramGuidance, authGuidance, liveContextSection } = require('./RestApi');

function columnsText(columns) {
  const list = (columns || []).map((c) => (typeof c === 'string' ? c : `${c.name}${c.type ? ` (${c.type})` : ''}`));
  return list.length ? list.map((c) => `- ${c}`).join('\n') : '(unknown — ask which fields to send if it matters)';
}

const RestApiWritePrompts = {
  /**
   * @param {object} p
   * @param {string} p.userRequest         what the user asked this node to send
   * @param {string} p.connectionName
   * @param {string} [p.connectionAuthType]
   * @param {string} [p.connectionBaseUrl]
   * @param {string[]} [p.connectionParamKeys]
   * @param {string} [p.presetReference]   the vendor's write reference (describePreset mode 'write')
   * @param {Array}  p.sourceColumns       the rows' columns: [{ name, type }]
   * @param {Array}  [p.sampleRows]        a few rows, for value formats
   * @param {string} [p.writeMode]         'create' | 'upsert' — what the user asked for, when known
   * @param {string[]} [p.upsertKeys]      the column(s) that identify a record, when known
   * @param {object} [p.selectedEndpoint]  { method, path, label } picked in the Output form
   * @param {string} [p.currentCode]       the function this node already has (a refinement edits it)
   */
  restApiWriteRequest: ({
    userRequest,
    connectionName = 'the API',
    connectionAuthType = 'none',
    connectionBaseUrl = '',
    connectionApiKeyName = '',
    connectionBasicUser = '',
    connectionParamKeys = [],
    presetReference = null,
    sourceColumns = [],
    sampleRows = [],
    writeMode = null,
    upsertKeys = null,
    selectedEndpoint = null,
    currentCode = null,
    // An API connector's own placeholders and its live account details
    // (see RestApi.restApiAnalysisRequest).
    connectorPlaceholders = [],
    liveContext = '',
  }) => {
    const authType = connectionAuthType || 'none';
    const paramKeys = Array.isArray(connectionParamKeys) ? connectionParamKeys : [];
    const vocabulary = [...new Set([...placeholdersFor(authType, paramKeys), ...(connectorPlaceholders || [])])];
    const params = paramGuidance(paramKeys);
    const legacyAuth = (authType === 'none' && params) ? '' : authGuidance({
      authType, apiKeyName: connectionApiKeyName, basicUser: connectionBasicUser,
    });
    const guidance = [params, legacyAuth].filter(Boolean).join('\n\n');
    const samples = (sampleRows || []).slice(0, 3);

    return `
You are a REST API integration expert. A workflow has computed some rows, and
the user wants them SENT to "${connectionName}" — created or updated there.
You write the function that sends them. You never see raw credentials; you only
use placeholder tokens.

**Connection**
- Name: ${connectionName}
- Base URL: ${connectionBaseUrl || '(not set — the user must give full URLs)'}
- Saved parameter keys: ${paramKeys.length ? paramKeys.map((k) => `"${k}"`).join(', ') : '(none)'}
${presetReference ? `
**Vendor API reference (writing)**
Use these endpoints, body shapes, batch limits and rules rather than guessing.

${presetReference}
` : `
This is a generic REST connection: there is no vendor reference. Use the
endpoint and body the user describes; ask when the request does not say which
URL to call or what a record's body looks like.
`}${liveContext ? `
${liveContextSection(liveContext)}
` : ''}${selectedEndpoint ? `
**Endpoint picked in the Output form**
${selectedEndpoint.method || 'POST'} ${selectedEndpoint.path}${selectedEndpoint.operation ? ` (${selectedEndpoint.operation})` : ''} — ${selectedEndpoint.label || ''}. Use it unless the
request clearly asks for something else.
` : ''}
**The rows you receive** (columns of each row object)
${columnsText(sourceColumns)}
${samples.length ? `
Sample rows (values only illustrate formats — never hard-code them):
${JSON.stringify(samples, null, 2).slice(0, 2500)}
` : ''}
**What the user asked**
"${userRequest}"
${writeMode ? `
Write mode the user chose: ${writeMode === 'upsert'
    ? `UPSERT — update a record that already exists${upsertKeys?.length ? ` (matched on ${upsertKeys.join(', ')})` : ''}, create the rest. Use the API's upsert endpoint; where it has none, look the record up first and update it, else create it.`
    : 'CREATE — every row becomes a new record.'}
` : ''}${currentCode ? `
**This node's current function** — the user is refining it. Keep what they did
not ask to change.
\`\`\`javascript
${currentCode}
\`\`\`
` : ''}
**Your task**
Write ONE async JavaScript function expression:

\`\`\`javascript
async function sendBatch({ axios, rows, batchIndex, state }) {
  // map each row to the API's record shape, send them, report the outcome
  return { sent: <number of rows the API accepted>, failed: [{ index: <position in rows>, error: '<why>' }] };
}
\`\`\`

**Contract**
- It also receives \`tools\`: \`tools.sha256(value)\` (hex — for APIs that take hashed
  emails or phones; normalise first, usually trim + lowercase), \`tools.sleep(ms)\`,
  \`tools.parseCsv\`, \`tools.gunzip\`, \`tools.unzip\`, \`tools.parseJsonLines\`.
- The runtime calls it once per batch: \`rows\` holds at most \`batchSize\` rows
  (you choose batchSize below — the API's per-request maximum for the endpoint
  you call, e.g. 100 for a HubSpot batch, 10 for Airtable, 1 for an endpoint
  that takes one record). Send them in as few requests as the API allows.
- Map columns to the API's field names explicitly. Skip null/undefined values
  rather than sending "null". Convert types the API needs (numbers, dates,
  booleans, ids).
- Let HTTP errors THROW — never set validateStatus, never catch a 4xx/5xx to
  carry on. A thrown error stops the run, which is what must happen when the
  key or endpoint is wrong. The runtime retries a 429 by itself.
- When the API reports per-record failures inside a SUCCESSFUL response
  (HubSpot 207 \`errors\`, Mailchimp \`errors\`, Jira bulk \`errors\`, a GraphQL
  \`errors\` array), do not throw: put each one in \`failed\` with the row's
  index in \`rows\` when it can be told, and count only accepted rows in \`sent\`.
- For an API that takes one record per request, loop over rows in order and
  respect its documented rate limit with a pause (e.g. \`await new Promise(r =>
  setTimeout(r, 350))\`) between requests.
- If a lookup is needed first (an id for a name, a record to update), do it
  inside the function and keep what it finds in \`state\` — one object shared
  by every batch of this run (empty at the start of each run). Batches are
  often a single row, so a company or list created for an earlier row must be
  remembered there (e.g. \`state.companyIds ??= {}\`), or the next row creates
  it again. Variables inside the function do NOT survive between batches.
- When a create answers "already exists" (409 / duplicate) and the response
  names the existing record's id, use that id instead of failing the row.
- No require/import, no top-level statements outside the function, standard JS.
- Never create payments, charges, refunds or deletions unless the user asked
  for exactly that.

**Placeholder vocabulary** — the ONLY tokens you may emit. They must appear
only inside string literals or template literals.
${vocabulary.map((p) => `- ${p}`).join('\n')}
- Use \`{{BASE_URL}}\` as the URL prefix. Never write a raw key.

${guidance}

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and nothing else.

{
  "action": "ask_questions" | "create_plan",
  "followUpQuestion": "one clear question (only with ask_questions)",
  "code": "async function sendBatch({ axios, rows, batchIndex, state }) { … }",
  "explanation": "One sentence: what each row becomes, which endpoint, create or update.",
  "endpoint": "METHOD and URL of the main request, e.g. POST {{BASE_URL}}/crm/v3/objects/contacts/batch/upsert",
  "batchSize": <integer rows per call>,
  "writeMode": "create" | "upsert",
  "fieldMapping": { "<source column>": "<API field>" }
}

RULES
1. ask_questions only when something the request cannot be built without is
   missing: WHICH object/table/list to write to when the user did not name one,
   or — for a generic connection — the endpoint. Ask ONE question. Do not ask
   about anything the reference, the columns or a sensible default settles.
   When the user NAMED it (the "Project Tracker" base, the "fefe" audience, the
   "Ternl" team, the CRM project) but not its id, do NOT ask for the id: look it
   up inside the function by name (list the bases / lists / teams and match),
   and throw a clear error if no match is found.
2. create_plan otherwise. Prefer an upsert endpoint when the API has one and the
   rows carry a natural key (email, an external id) — re-runs then update
   instead of duplicating — unless the user asked to create new records.
3. Ids the API needs that are not in the rows (a list id, a base id, a team id)
   come from the user's request or a lookup inside the function by the name the
   user gave. Never invent one.

Return ONLY the JSON object.
`;
  },
};

module.exports = RestApiWritePrompts;
module.exports.default = RestApiWritePrompts;
