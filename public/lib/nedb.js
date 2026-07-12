/**
 * Local NeDB helper. Single entry point: runQuery({ dbPath, ... }) plus
 * getTables / getColumns. Used by buildSkillHelpers to route any local NeDB
 * call through one API, so AI-generated code only has to learn ctx.runQuery.
 *
 * NeDB stores ONE collection per file. We treat the file basename as the
 * "table" name for the getTables/getColumns API.
 *
 * Per-path Datastore cache: NeDB's loadDatabase rewrites `<file>.db~` and
 * renames it to `<file>.db`. Two Datastore instances on the same path race
 * that rename and one fails with ENOENT. Sharing a single instance per path
 * serializes operations through NeDB's internal executor.
 */

const Datastore = require('@seald-io/nedb');
const fs = require('fs');
const path = require('path');

const cache = new Map();

/**
 * Convert documents coming from other stores (notably MongoDB) into a
 * NeDB-safe shape. NeDB indexes `_id` as the unique primary key and cannot
 * index BSON ObjectIds — they serialize to `{}`, so every doc collides on the
 * same key ("Can't insert key {}, it violates the unique constraint").
 * Mirrors saveToLocalNeDB's sanitizer: ObjectId → string, Date → ISO string,
 * recursively for nested objects/arrays.
 */
function sanitizeForNeDB(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (doc._bsontype === 'ObjectId') return doc.toString();
  if (doc instanceof Date) return doc.toISOString();

  const sanitized = Array.isArray(doc) ? [] : {};
  for (const key in doc) {
    const value = doc[key];
    if (value && typeof value === 'object' && value._bsontype === 'ObjectId') {
      sanitized[key] = value.toString();
    } else if (value instanceof Date) {
      sanitized[key] = value.toISOString();
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeForNeDB(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

async function open(dbPath) {
  if (!dbPath) throw new Error('NeDB runQuery requires dbPath');
  let entry = cache.get(dbPath);
  if (!entry) {
    const db = new Datastore({ filename: dbPath, autoload: false });
    const loaded = new Promise((resolve, reject) => {
      db.loadDatabase((err) => (err ? reject(err) : resolve(db)));
    });
    entry = { db, loaded };
    cache.set(dbPath, entry);
    try {
      await loaded;
    } catch (err) {
      cache.delete(dbPath);
      throw err;
    }
  } else {
    await entry.loaded;
  }
  return entry.db;
}

function dropCache(dbPath) {
  cache.delete(dbPath);
}

/**
 * Single entry point for all NeDB operations.
 *
 * query shape:
 *   { operation?: 'find' | 'insert' | 'update' | 'remove' | 'drop',
 *     filter?, sort?, limit?, skip?,
 *     docs?, doc?,                 // insert
 *     update?, options?,           // update
 *     mode?: 'append' | 'replace'  // insert convenience: 'replace' wipes file first
 *   }
 * The operation defaults to 'find' so passing a bare filter Just Works.
 */
async function runQuery({ dbPath, ...query } = {}) {
  const op = (query.operation || 'find').toLowerCase();

  if (op === 'drop') {
    dropCache(dbPath);
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    return [];
  }

  if (op === 'insert') {
    const rawDocs = query.docs || (query.doc ? [query.doc] : []);
    const docs = rawDocs.map(sanitizeForNeDB);
    if (!docs.length) return [];
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (query.mode === 'replace' && fs.existsSync(dbPath)) {
      dropCache(dbPath);
      fs.unlinkSync(dbPath);
    }
    const db = await open(dbPath);
    return new Promise((resolve, reject) => {
      db.insert(docs, (err, inserted) => (err ? reject(err) : resolve(inserted)));
    });
  }

  const db = await open(dbPath);

  if (op === 'update') {
    const filter = query.filter || {};
    const update = query.update || {};
    const options = query.options || { multi: true };
    return new Promise((resolve, reject) => {
      db.update(filter, update, options, (err, num) => (err ? reject(err) : resolve(num)));
    });
  }

  if (op === 'remove' || op === 'delete') {
    const filter = query.filter || {};
    const options = query.options || { multi: true };
    return new Promise((resolve, reject) => {
      db.remove(filter, options, (err, num) => (err ? reject(err) : resolve(num)));
    });
  }

  if (op === 'count') {
    const filter = query.filter || {};
    return new Promise((resolve, reject) => {
      db.count(filter, (err, n) => (err ? reject(err) : resolve([{ count: n }])));
    });
  }

  if (op === 'aggregate') {
    if (!Array.isArray(query.pipeline)) {
      throw new Error('aggregate requires `pipeline` (array of stages)');
    }
    const docs = await new Promise((resolve, reject) => {
      db.find({}).exec((err, rows) => (err ? reject(err) : resolve(rows)));
    });
    return runAggregatePipeline(docs, query.pipeline);
  }

  // Default: find
  const filter = query.filter || {};
  return new Promise((resolve, reject) => {
    let cursor = db.find(filter);
    if (query.sort)  cursor = cursor.sort(query.sort);
    if (query.skip)  cursor = cursor.skip(query.skip);
    if (query.limit) cursor = cursor.limit(query.limit);
    cursor.exec((err, docs) => (err ? reject(err) : resolve(docs)));
  });
}

// -----------------------------------------------------------------------------
// Minimal in-JS aggregation pipeline for NeDB. NeDB doesn't ship one, but the
// AI-driven chat treats Mongo + NeDB as interchangeable NoSQL targets, so we
// implement the slice that covers the chat's typical "how big / how grouped"
// queries: $match, $group, $project, $sort, $skip, $limit, $count.
//
// Supported accumulators inside $group: $sum (literal or $field), $avg, $min,
// $max, $first, $last, $push, $addToSet, $count.
// Supported expressions inside $group._id / accumulator field refs / $project:
// string field refs ('$path.to.field'), literals, and a tiny set of operators
// ($cond, $eq, $ne, $gt, $gte, $lt, $lte, $ifNull, $and, $or, $not).
// -----------------------------------------------------------------------------

function getField(doc, path) {
  if (path == null) return undefined;
  const parts = String(path).split('.');
  let cur = doc;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalExpr(expr, doc) {
  if (expr == null) return expr;
  if (typeof expr === 'string') {
    return expr.startsWith('$') ? getField(doc, expr.slice(1)) : expr;
  }
  if (typeof expr !== 'object' || Array.isArray(expr)) return expr;
  const keys = Object.keys(expr);
  if (keys.length === 1 && keys[0].startsWith('$')) {
    const op = keys[0];
    const args = expr[op];
    const a = Array.isArray(args) ? args.map((x) => evalExpr(x, doc)) : evalExpr(args, doc);
    switch (op) {
      case '$cond':   return Array.isArray(args)
                        ? (evalExpr(args[0], doc) ? evalExpr(args[1], doc) : evalExpr(args[2], doc))
                        : (evalExpr(args.if, doc) ? evalExpr(args.then, doc) : evalExpr(args.else, doc));
      case '$eq':     return a[0] === a[1];
      case '$ne':     return a[0] !== a[1];
      case '$gt':     return a[0] >  a[1];
      case '$gte':    return a[0] >= a[1];
      case '$lt':     return a[0] <  a[1];
      case '$lte':    return a[0] <= a[1];
      case '$ifNull': return a[0] != null ? a[0] : a[1];
      case '$and':    return a.every(Boolean);
      case '$or':     return a.some(Boolean);
      case '$not':    return !(Array.isArray(a) ? a[0] : a);
      case '$add':    return a.reduce((s, v) => s + (Number(v) || 0), 0);
      case '$subtract': return (Number(a[0]) || 0) - (Number(a[1]) || 0);
      default:
        throw new Error(`Unsupported expression operator in NeDB aggregate: ${op}`);
    }
  }
  // Object literal — build a doc by recursively evaluating each value.
  const out = {};
  for (const [k, v] of Object.entries(expr)) out[k] = evalExpr(v, doc);
  return out;
}

function matchDoc(filter, doc) {
  // Minimal NeDB-compatible: pass through find() for accuracy.
  // Synchronous deep compare for the common equality / nested-path cases.
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$and') return val.every((f) => matchDoc(f, doc));
    if (key === '$or')  return val.some((f) => matchDoc(f, doc));
    const docVal = getField(doc, key);
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [op, opArg] of Object.entries(val)) {
        if (op === '$eq'  && !(docVal === opArg)) return false;
        if (op === '$ne'  && !(docVal !== opArg)) return false;
        if (op === '$gt'  && !(docVal >  opArg)) return false;
        if (op === '$gte' && !(docVal >= opArg)) return false;
        if (op === '$lt'  && !(docVal <  opArg)) return false;
        if (op === '$lte' && !(docVal <= opArg)) return false;
        if (op === '$in'  && !(Array.isArray(opArg) && opArg.includes(docVal))) return false;
        if (op === '$nin' && !(Array.isArray(opArg) && !opArg.includes(docVal))) return false;
        if (op === '$exists') {
          const has = docVal !== undefined;
          if (Boolean(opArg) !== has) return false;
        }
      }
    } else if (docVal !== val) return false;
  }
  return true;
}

function applyGroup(docs, stage) {
  const idExpr = stage._id;
  const groups = new Map();
  const keyOf = (v) => (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
  for (const doc of docs) {
    const idVal = evalExpr(idExpr, doc);
    const key = keyOf(idVal);
    if (!groups.has(key)) groups.set(key, { _id: idVal, _docs: [] });
    groups.get(key)._docs.push(doc);
  }
  const fields = Object.entries(stage).filter(([k]) => k !== '_id');
  const out = [];
  for (const grp of groups.values()) {
    const row = { _id: grp._id };
    for (const [name, accExpr] of fields) {
      const keys = Object.keys(accExpr || {});
      if (keys.length !== 1) throw new Error(`Bad accumulator for "${name}": expected single $op`);
      const acc = keys[0];
      const arg = accExpr[acc];
      switch (acc) {
        case '$sum':   row[name] = grp._docs.reduce((s, d) => s + (Number(evalExpr(arg, d)) || 0), 0); break;
        case '$avg': {
          const vs = grp._docs.map((d) => Number(evalExpr(arg, d))).filter((x) => !Number.isNaN(x));
          row[name] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
          break;
        }
        case '$min':   row[name] = grp._docs.reduce((m, d) => { const v = evalExpr(arg, d); return m == null || v < m ? v : m; }, null); break;
        case '$max':   row[name] = grp._docs.reduce((m, d) => { const v = evalExpr(arg, d); return m == null || v > m ? v : m; }, null); break;
        case '$first': row[name] = grp._docs.length ? evalExpr(arg, grp._docs[0]) : null; break;
        case '$last':  row[name] = grp._docs.length ? evalExpr(arg, grp._docs[grp._docs.length - 1]) : null; break;
        case '$push':  row[name] = grp._docs.map((d) => evalExpr(arg, d)); break;
        case '$addToSet': {
          const set = new Set();
          for (const d of grp._docs) set.add(JSON.stringify(evalExpr(arg, d)));
          row[name] = Array.from(set).map((s) => JSON.parse(s));
          break;
        }
        case '$count': row[name] = grp._docs.length; break;
        default: throw new Error(`Unsupported NeDB aggregate accumulator: ${acc}`);
      }
    }
    out.push(row);
  }
  return out;
}

function applyProject(docs, stage) {
  return docs.map((doc) => {
    const out = {};
    const explicitInclude = Object.entries(stage).some(([k, v]) => k !== '_id' && (v === 1 || v === true));
    if (!explicitInclude) {
      // $project with only excludes / computed fields — start from full doc.
      for (const [k, v] of Object.entries(doc)) out[k] = v;
    }
    for (const [k, v] of Object.entries(stage)) {
      if (v === 0 || v === false) { delete out[k]; continue; }
      if (v === 1 || v === true)  { out[k] = getField(doc, k); continue; }
      out[k] = evalExpr(v, doc);
    }
    return out;
  });
}

function runAggregatePipeline(input, pipeline) {
  let docs = Array.isArray(input) ? input.slice() : [];
  for (const stage of pipeline) {
    const keys = Object.keys(stage || {});
    if (keys.length !== 1) throw new Error('Each pipeline stage must have exactly one $op key');
    const op = keys[0];
    const arg = stage[op];
    switch (op) {
      case '$match':   docs = docs.filter((d) => matchDoc(arg, d)); break;
      case '$group':   docs = applyGroup(docs, arg); break;
      case '$project': docs = applyProject(docs, arg); break;
      case '$sort': {
        const entries = Object.entries(arg);
        docs.sort((a, b) => {
          for (const [k, dir] of entries) {
            const av = getField(a, k), bv = getField(b, k);
            if (av < bv) return dir < 0 ? 1 : -1;
            if (av > bv) return dir < 0 ? -1 : 1;
          }
          return 0;
        });
        break;
      }
      case '$skip':  docs = docs.slice(Number(arg) || 0); break;
      case '$limit': docs = docs.slice(0, Number(arg) || 0); break;
      case '$count': docs = [{ [arg]: docs.length }]; break;
      default: throw new Error(`Unsupported NeDB aggregate stage: ${op}`);
    }
  }
  return docs;
}

/** NeDB has one collection per file; report the basename as the only "table". */
async function getTables({ dbPath } = {}) {
  if (!dbPath) return [];
  return [path.basename(dbPath, path.extname(dbPath))];
}

/** Infer columns from the first document's keys. */
async function getColumns({ dbPath } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const db = await open(dbPath);
  const sample = await new Promise((resolve, reject) => {
    db.find({}).limit(1).exec((err, docs) => (err ? reject(err) : resolve(docs)));
  });
  if (!sample.length) return [];
  return Object.entries(sample[0]).map(([name, value]) => ({
    name,
    type: typeof value === 'object' && value !== null ? 'object' : typeof value
  }));
}

module.exports = {
  runQuery,
  getTables,
  getColumns,
  // exposed for buildSkillHelpers cleanup
  dropCache
};
