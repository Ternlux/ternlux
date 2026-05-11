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
    const docs = query.docs || (query.doc ? [query.doc] : []);
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
