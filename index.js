const path=require("path"),{app}=require("electron"),{buildContext}=require("./lib/sandbox");module.exports={type:"skill",id:"javascript-executor",name:"JavaScript Executor",category:"transformer",icon:"./icon.svg",supportsInteraction:!0,getDescription:()=>({name:"JavaScript Executor",description:"Run an AI-generated async JavaScript function for complex transformations that need to query other connections, call AI, generate embeddings, or hit external APIs.",capabilities:["Single async transform(records, ctx) function over the source data","Query any saved connection (ctx.runQuery / getTables / getColumns)","Call any configured AI provider (ctx.askAi)","Generate embeddings (ctx.vectorize)","Local NeDB / SQLite / LanceDB via ctx.runQuery(dbType, query, dbPath)","External HTTP via ctx.axios","Write results to NeDB or LanceDB"],inputFormat:"Array of objects from the source node",outputFormat:"Array of objects (NeDB) or array with a vector field (LanceDB)",executionEnvironment:"local (Electron main process)"}),getTransformPrompts:()=>({systemContext:`
# JavaScript Executor Skill

Use this skill when the transformation needs to:
- Cross-reference data from another saved connection (SQL or NoSQL)
- Call an AI model on each record (classify, extract, summarize)
- Custom logic for creating embeddings where Vector Database Executor can't perform
- Hit an external HTTP API (axios)
- Combine several of the above

Skip it for plain SQL/NoSQL \u2014 the standard flow handles those.
Output is written to NeDB (default) or LanceDB (when records carry a vector).
`,responseFormat:`
When this skill fits, return:
{
  "usesSkill": true,
  "skillId": "javascript-executor",
  "skillExplanation": "Why a JavaScript function is needed"
}
`}),buildSkillPrompt:async e=>{const{userRequest:t,sourceTableSchema:o={},sourceConnection:n={},operationType:r,chatHistory:i=[],helpers:a}=e;if(!a||typeof a.callAI!="function")throw new Error("javascript-executor requires helpers.callAI (electron must inject helpers).");const u=n.id||n._id,m=(a.connections||[]).filter(c=>(c.id||c._id)!==u),l=buildPlanningPrompt({userRequest:t,sourceConnection:n,sourceTableSchema:o,otherConnections:m,aiProviders:a.aiProviders||[],embeddingProviders:a.embeddingProviders||[]});let s;try{const c=await a.callAI(l,{maxTokens:1024,chatHistory:i});s=parseJson(c)}catch(c){return preResolved({action:"ask_questions",questionsNeeded:{setup:`Planning step failed: ${c.message}`}},{stage:"failed",error:c.message})}if(console.log("plan: ",String(s)),s.action==="answer_directly"||s.action==="ask_questions")return preResolved(validateResult(s),{stage:"short_circuit",plan:s});if(s.action!=="plan_complete")return preResolved({action:"ask_questions",questionsNeeded:{request:"I could not understand the request. Please describe what transformation you need."}},{stage:"invalid_plan",plan:s});const b=await fetchSchemaContext({connectionsNeeded:s.connectionsNeeded||[],helpers:a}),p=buildFunctionPrompt({userRequest:t,plan:s,schemaContext:b,sourceConnection:n,sourceTableSchema:o});let d;try{const c=await a.callAI(p,{maxTokens:4096,chatHistory:i});d=parseJson(c)}catch(c){return preResolved({action:"ask_questions",questionsNeeded:{setup:`Function generation step failed: ${c.message}`}},{stage:"failed",error:c.message})}return preResolved(validateResult(d),{stage:"function_generation",plan:s,schemaContext:b,raw:d})},processSkillResponse:e=>{let t;try{t=parseJson(e)}catch(o){return{action:"ask_questions",message:`Could not parse response: ${o.message}`,questionsNeeded:{request:"Could you rephrase the transformation you want?"}}}return validateResult(t)},execute:async params=>{const startTime=Date.now(),{sourceConnection,sourceTableSchema,transformFunction,outputType="nedb",helpers,nodeId,sourceNodeId,sourceNodeLabel,sourceConnectionName,sourceConnectionType,userRequest,targetLocalPath}=params;if(!helpers)return{success:!1,message:"helpers bundle missing (electron injection failed)"};if(!transformFunction)return{success:!1,message:"transformFunction is required"};try{const records=await loadSourceRecords({sourceConnection,sourceTableSchema,helpers});let fn;try{fn=eval(`(${transformFunction})`)}catch(e){return{success:!1,message:`Failed to compile transform function: ${e.message}`}}if(typeof fn!="function")return{success:!1,message:"Compiled transform is not a function"};const ctx=buildContext(helpers),result=await fn(records,ctx),output=Array.isArray(result)?result:[result],targetTableName=(nodeId||`js_${Date.now()}`).replace(/-/g,"_").toLowerCase();let savedConfig,localPath;if(outputType==="lancedb"){const e=targetLocalPath||path.join(app.getPath("userData"),"data","lancedb"),t=output.map(n=>{const r=n.vector||n.values||n.embedding;if(!Array.isArray(r))throw new Error("LanceDB output requires each record to include a numeric `vector` array");const i={...n,vector:r};return delete i.values,delete i.embedding,i}),o=await helpers.runQuery("lancedb",{operation:"upsert",tableName:targetTableName,data:t},e);if(o&&o.success===!1)return{success:!1,message:`LanceDB write failed: ${o.message}`};localPath=e,savedConfig=buildConfig({outputType:"lancedb",targetTableName,targetLocalPath:e,sourceConnection,sourceTableSchema,sourceNodeId,sourceNodeLabel,sourceConnectionName,sourceConnectionType,userRequest,transformFunction,recordCount:output.length})}else{const e=path.join(app.getPath("userData"),"local-collections");localPath=targetLocalPath||path.join(e,`${targetTableName}.db`),await helpers.runQuery("nedb",{operation:"insert",mode:"replace",docs:output},localPath),savedConfig=buildConfig({outputType:"nedb",targetTableName,targetLocalPath:localPath,sourceConnection,sourceTableSchema,sourceNodeId,sourceNodeLabel,sourceConnectionName,sourceConnectionType,userRequest,transformFunction,recordCount:output.length})}return{success:!0,data:output,recordCount:output.length,message:`JavaScript transformation produced ${output.length} record(s) \u2192 ${outputType}`,executionTime:Date.now()-startTime,localPath,config:savedConfig}}catch(e){return console.error("[javascript-executor] Execution failed:",e),{success:!1,message:e.message,error:e.stack,executionTime:Date.now()-startTime}}},metadata:{displayName:"JavaScript Executor",description:"Run an AI-generated JavaScript function with helpers for connectors, AI, embeddings, and HTTP",version:"1.0.0",author:"Ternlux"}};function parseJson(e){if(typeof e!="string")return e;const t=e.match(/```json?\n?([\s\S]*?)\n?```/),o=t?t[1]:(e.match(/{[\s\S]*}/)||[e])[0];return JSON.parse(o)}function validateResult(e){if(!e||typeof e!="object")return{action:"ask_questions",questionsNeeded:{request:"Could not understand the response. Please rephrase the transformation."}};if(e.action==="answer_directly"||e.action==="ask_questions")return e;if(e.action==="execute"){if(!e.transformFunction||!e.transformFunction.includes("function transform"))return{action:"ask_questions",message:"Function missing. It must be named `transform(records, ctx)`.",questionsNeeded:{transformFunction:"Please describe what the function should do."}};const t=(e.outputType||"nedb").toLowerCase();return["nedb","lancedb"].includes(t)?{action:"execute",readyToExecute:!0,transformFunction:e.transformFunction,outputType:t,explanation:e.explanation||""}:{action:"ask_questions",message:`Unsupported outputType "${e.outputType}". Choose "nedb" or "lancedb".`,questionsNeeded:{outputType:"Where should the result be written: nedb or lancedb?"}}}return e}function preResolved(e,t){return{...e,context:t}}function buildPlanningPrompt({userRequest:e,sourceConnection:t,sourceTableSchema:o,otherConnections:n,aiProviders:r,embeddingProviders:i}){const u=(o?.columns||[]).map(s=>`${s.name} (${s.type})`).join(", ")||"(unknown)",m=(o?.sampleData||[]).slice(0,3),l=n.length?n.map(s=>`- "${s.name}" (id: ${s.id||s._id}, dbType: ${s.dbType}, category: ${s.dbCategory||"n/a"})`).join(`
`):"(no other connections configured)";return`You are PLANNING a JavaScript-based transformation in Ternlux.

User's request: "${e}"

Source data:
- Connection: ${t?.name||"Unknown"} (dbType: ${t?.dbType||"unknown"})
- Table/Collection: ${o?.tableName||"unknown"}
- Columns: ${u}
- Sample (first 3): ${JSON.stringify(m)}

Other available connections (the function may query any of these):
${l}

AI providers configured: ${r.join(", ")||"none"}
Embedding providers configured: ${i.join(", ")||"none"}

Decide ONE of:

1. **answer_directly** \u2014 User is asking a question that doesn't require code (e.g., what columns exist, explain prior work).
2. **ask_questions** \u2014 Request is ambiguous; ask plain-language clarifying questions.
3. **plan_complete** \u2014 Ready to write a transformation. List the OTHER connections + tables the function will need (do NOT list the source \u2014 it's loaded automatically), and pick providers + output destination.

Return JSON in EXACTLY one of these shapes (no markdown, no commentary):

{
  "action": "answer_directly",
  "directAnswer": "your answer"
}

{
  "action": "ask_questions",
  "questionsNeeded": { "topic": "Plain-language question" }
}

{
  "action": "plan_complete",
  "connectionsNeeded": [
    { "connection": "<connection name>", "tables": ["table1"] }
  ],
  "aiProvider": "openai" | "claude" | "gemini" | null,
  "embeddingProvider": "openai" | "huggingface" | null,
  "outputType": "nedb" | "lancedb",
  "summary": "Brief description of the planned transformation"
}

connectionsNeeded must be [] if no extra connections are required.
Choose providers ONLY from the configured lists; null if not needed.
outputType is "lancedb" only when the function will produce records with a numeric vector field; otherwise "nedb".`}async function fetchSchemaContext({connectionsNeeded:e,helpers:t}){const o=[];for(const n of e||[]){let r;try{r=t.getConnection(n.connection)}catch(a){o.push({connection:n.connection,error:a.message});continue}const i=[];for(const a of n.tables||[])try{const u=await t.getColumns(r.name||r.id,a,r.dbConfig?.schema||null);let m=[];try{m=await t.runQuery(r.name||r.id,{query:`SELECT * FROM ${a} LIMIT 3`,tableName:a,collection:a,filter:{},limit:3})}catch{}i.push({table:a,columns:u,sample:(m||[]).slice(0,3)})}catch(u){i.push({table:a,error:u.message})}o.push({connection:r.name,dbType:r.dbType,dbCategory:r.dbCategory,tables:i})}return o}function buildFunctionPrompt({userRequest:e,plan:t,schemaContext:o,sourceConnection:n,sourceTableSchema:r}){const a=(r?.columns||[]).map(d=>`${d.name} (${d.type})`).join(", ")||"(unknown)",u=(r?.sampleData||[]).slice(0,3),m=(o||[]).map(d=>{if(d.error)return`Connection "${d.connection}" \u2014 ERROR: ${d.error}`;const c=(d.tables||[]).map(f=>{if(f.error)return`  - ${f.table}: ERROR (${f.error})`;const y=(f.columns||[]).map(h=>`${h.name} (${h.type||h.dataType||"?"})`).join(", "),g=JSON.stringify((f.sample||[]).slice(0,2));return`  - ${f.table}
      columns: ${y}
      sample: ${g}`}).join(`
`);return`Connection "${d.connection}" (${d.dbType})
${c}`}).join(`

`)||"(no extra connections needed)",l=t.outputType||"nedb",p=!!n?.localPath||(l==="nedb"||l==="lancedb");return`You are writing a JavaScript transformation function for Ternlux.

User's request: "${e}"

Plan summary: ${t.summary||""}

Source data (already loaded for you):
- Connection: ${n?.name||"Unknown"} (dbType: ${n?.dbType||"unknown"})
- Table: ${r?.tableName||"unknown"}
- Columns: ${a}
- Sample (first 3): ${JSON.stringify(u)}

Schema for the connections you said you'd need:

${m}

AI provider for ctx.askAi: ${t.aiProvider||"first available"}
Embedding provider for ctx.vectorize: ${t.embeddingProvider||"first available"}
Output destination: ${l}

# Function contract

Write ONE async function with this exact signature:

  async function transform(records, ctx) {
    // ... your logic ...
    return outputRecords; // array of objects
  }

\`records\` is the source data already loaded as an array of objects. Return
an array of objects to write downstream. Keep the function small \u2014 every
ctx helper is a single async call so you almost never need to wrap or guard them.

# ctx helpers (all simple, single-call)

- ctx.connections                 -> [{ id, name, dbType, dbCategory }]
- ctx.aiProviders                 -> available providers, e.g. ['openai']
- await ctx.runQuery(connection, queryStringOrObject, dbPath?)
    Saved connection (dbPath omitted):
      SQL:    ctx.runQuery('warehouse', 'SELECT id, email FROM users')
      NoSQL:  ctx.runQuery('mongo-prod', { collection: 'users', filter: {}, limit: 100 })
    Returns an array of rows.
- await ctx.getTables(connection, dbPath?)
- await ctx.getColumns(connection, table, schema?, dbPath?)
- await ctx.askAi(prompt, { provider?, model?, systemPrompt?, maxTokens? })
    Returns the model's text response.
- await ctx.vectorize(['text', ...], { provider?, model? })
    Returns an array of vectors aligned with the input texts.
- ctx.axios                                     -> axios module for arbitrary HTTP
- ctx.log(...args)                              -> console log

\`connection\` accepts either the saved connection's name/id, OR \u2014 when reading
a local file \u2014 the dbType string ('nedb' | 'sqlite' | 'lancedb').
${p?`

# Local files (nedb / sqlite / lancedb)

This run touches a local file, so you MUST pass the absolute path as the
trailing \`dbPath\` argument. Saved connections aren't used for these \u2014 pass
the dbType string in place of the connection name.

  ctx.runQuery('nedb', { filter: {}, limit: 1000 }, '/abs/path/file.db')
  ctx.runQuery('nedb', { operation: 'insert', mode: 'replace', docs: rows }, '/abs/path/file.db')
  ctx.runQuery('sqlite', { query: 'SELECT * FROM customers' }, '/abs/path/store.db')
  ctx.runQuery('sqlite', { query: 'INSERT INTO t VALUES (?,?)', params: [1, 'a'] }, '/abs/path/store.db')
  ctx.runQuery('lancedb', { operation: 'queryVectors', tableName: 'docs', queryVector: v, topK: 5 }, '/abs/path/lancedir')
  ctx.runQuery('lancedb', { operation: 'upsert',  tableName: 'docs', data: records },          '/abs/path/lancedir')

\`getTables('nedb' | 'sqlite' | 'lancedb', dbPath)\` and
\`getColumns(dbType, table, null, dbPath)\` work the same way.
`:""}

# Output destination

"${l}":
${l==="lancedb"?"- Each output record MUST include a numeric `vector` array.":"- Plain JSON records, no vector field required."}

# Response format

Return JSON in one of these shapes (no markdown, no commentary):

Ready to execute:
{
  "action": "execute",
  "transformFunction": "async function transform(records, ctx) { /* ... */ return outputRecords; }",
  "outputType": "${l}",
  "explanation": "Short description"
}

If still unclear (rare at this stage):
{
  "action": "ask_questions",
  "questionsNeeded": { "topic": "..." }
}

Keep the function concise. Use only the ctx helpers listed above.`}async function loadSourceRecords({sourceConnection:e,sourceTableSchema:t,helpers:o}){if(!e)return[];const n=!!e.localPath;if(n&&e.dbType==="nedb")return o.runQuery("nedb",{filter:{},limit:1e6},e.localPath);if(n&&e.dbType==="sqlite"){const u=t.originalTableName||t.tableName;return o.runQuery("sqlite",{query:`SELECT * FROM ${u}`},e.localPath)}const r=["mongodb","nedb"].includes(e.dbType),i=r&&t.originalTableName||t.tableName,a=r?{collection:i,filter:{},limit:1e6}:{query:`SELECT * FROM ${t.tableName}`,tableName:i,schema:t.schema||e.dbConfig?.schema,sheetName:t.sheetName,limit:1e6};return o.runQuery(e.name||e.id,a)}async function runTransformFunction({transformFunction,records=[],helpers}){if(!helpers)throw new Error("helpers bundle is required");if(!transformFunction)throw new Error("transformFunction is required");let fn;try{fn=eval(`(${transformFunction})`)}catch(e){throw new Error(`Failed to compile transform function: ${e.message}`)}if(typeof fn!="function")throw new Error("Compiled transform is not a function");const ctx=buildContext(helpers),result=await fn(Array.isArray(records)?records:[],ctx);return Array.isArray(result)?result:[result]}function buildConfig({outputType:e,targetTableName:t,targetLocalPath:o,sourceConnection:n,sourceTableSchema:r,sourceNodeId:i,sourceNodeLabel:a,sourceConnectionName:u,sourceConnectionType:m,userRequest:l,transformFunction:s,recordCount:b}){const p=e==="nedb";return{nodeType:"transformer",sourceNodeId:i,sourceNodeLabel:a,sourceConnectionId:n?.id,sourceConnectionName:u,sourceConnectionType:m,sourceDbType:n?.dbType,sourceDbConfig:n?.dbConfig,sourceLocalPath:n?.localPath,sourceTableName:r?.originalTableName||r?.tableName,sourceSchema:r?.schema,sourceTableSchema:r,storageLocation:"local",targetConnectionId:e==="lancedb"?"local-lancedb":"local-nedb",targetConnectionName:e==="lancedb"?"Local LanceDB":"Local NeDB",targetConnectionType:"file",targetDbType:e,targetDbCategory:e==="lancedb"?"Vector":"NoSQL",targetDbConfig:e==="lancedb"?{dbPath:o,tableName:t}:{},targetLocalPath:o,targetTableName:e==="lancedb"?t:void 0,targetCollection:p?t:void 0,targetPreviewSql:p?JSON.stringify({collection:t,filter:{},limit:100}):null,transformationRequest:l||"JavaScript transformation",transformFunction:s,skillId:"javascript-executor",usesSkill:!0,skillExecution:{skillId:"javascript-executor",outputType:e,recordCount:b},needsSchemaLoad:!0}}module.exports.buildFunctionPrompt=buildFunctionPrompt,module.exports.loadSourceRecords=loadSourceRecords,module.exports.runTransformFunction=runTransformFunction;
