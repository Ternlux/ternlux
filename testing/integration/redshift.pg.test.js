/**
 * The Redshift connector's driver paths, run against PostgreSQL.
 *
 * Redshift speaks the PostgreSQL wire protocol and this connector drives it
 * with `pg`, so a Postgres server exercises everything except Redshift's own
 * SQL (DISTKEY, SUPER, MERGE…): connecting, listing, column sizes, cursor
 * reads, streaming, batch inserts with awkward column names, and transactions.
 *
 *   TERNLUX_PG_TEST="postgres://postgres:test@127.0.0.1:55439/dev" \
 *     node --test testing/integration/redshift.pg.test.js
 *
 * Skipped unless TERNLUX_PG_TEST is set. Use a throwaway database: the test
 * creates and drops its own schema.
 */

const test = require('node:test');
const assert = require('node:assert');

const URL_ENV = process.env.TERNLUX_PG_TEST;
const redshift = require('../../plugins/connectors/redshift');

const config = (() => {
  if (!URL_ENV) return null;
  const u = new URL(URL_ENV);
  return {
    host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
    username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false,
  };
})();
const ID = 'redshift-pg-test';
const SCHEMA = 'ternlux_rs_test';
const opts = { skip: !config && 'set TERNLUX_PG_TEST to run' };

test('Redshift connector against a PostgreSQL server', opts, async (t) => {
  const run = async (query) => {
    const r = await redshift.runQuery(config, ID, { query });
    assert.notStrictEqual(r.success, false, r.message);
    return r;
  };
  await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await run(`CREATE SCHEMA ${SCHEMA}`);
  await run(`CREATE TABLE ${SCHEMA}.orders ("order" INTEGER, "first name" VARCHAR(40), "e.mail" TEXT, amount NUMERIC(12,2), placed TIMESTAMP)`);

  try {
    await t.test('testConnection', async () => {
      assert.deepStrictEqual(await redshift.testConnection(config, ID), { success: true, message: 'Connection successful' });
    });

    await t.test('getTables lists the table', async () => {
      const r = await redshift.getTables(config, ID);
      assert.ok(r.success);
      assert.ok(r.tables.some((x) => x.schema === SCHEMA && x.name === 'orders' && x.type === 'table'));
    });

    await t.test('getColumns returns sizes, and toCanonicalType reads them', async () => {
      const r = await redshift.getColumns(config, ID, SCHEMA, 'orders');
      assert.ok(r.success, r.message);
      const byName = Object.fromEntries(r.columns.map((c) => [c.name, c]));
      assert.deepStrictEqual(Object.keys(byName), ['order', 'first name', 'e.mail', 'amount', 'placed']);
      assert.strictEqual(byName['first name'].maxLength, 40);
      assert.deepStrictEqual(redshift.toCanonicalType(byName.amount), { kind: 'DECIMAL', precision: 12, scale: 2 });
      assert.deepStrictEqual(redshift.toCanonicalType(byName.order), { kind: 'INTEGER' });
      assert.deepStrictEqual(redshift.toCanonicalType(byName.placed), { kind: 'TIMESTAMP' });
      // Qualified name with no separate schema resolves the same table.
      const q = await redshift.getColumns(config, ID, null, `${SCHEMA}.orders`);
      assert.strictEqual(q.columns.length, 5);
    });

    await t.test('batchInsert quotes reserved, spaced and dotted column names', async () => {
      const rows = Array.from({ length: 2500 }, (_, i) => ({
        order: i, 'first name': `n${i}`, 'e.mail': `u${i}@x.io`, amount: (i * 1.5).toFixed(2), placed: new Date(Date.UTC(2026, 0, 1)),
      }));
      const r = await redshift.batchInsert(config, ID, `${SCHEMA}.orders`, ['order', 'first name', 'e.mail', 'amount', 'placed'], rows);
      assert.deepStrictEqual(r, { success: true, rowsInserted: 2500 });
      const c = await run(`SELECT COUNT(*)::int AS n, MAX("e.mail") AS m FROM ${SCHEMA}.orders`);
      assert.strictEqual(c.rows[0].n, 2500);
    });

    await t.test('runQuery caps rows through a cursor and reports truncation', async () => {
      const r = await redshift.runQuery(config, ID, { query: `SELECT * FROM ${SCHEMA}.orders ORDER BY "order"` }, { maxRows: 10 });
      assert.strictEqual(r.rows.length, 10);
      assert.strictEqual(r.truncated, true);
      assert.deepStrictEqual(r.columns, ['order', 'first name', 'e.mail', 'amount', 'placed']);
    });

    await t.test('streamQuery delivers every row in batches', async () => {
      let seen = 0; let batches = 0;
      const r = await redshift.streamQuery(config, ID, `SELECT * FROM ${SCHEMA}.orders`, async (rows) => { seen += rows.length; batches += 1; }, 1000);
      assert.deepStrictEqual(r, { success: true, totalRows: 2500 });
      assert.strictEqual(seen, 2500);
      assert.strictEqual(batches, 3);
    });

    await t.test('runInTransaction commits together and rolls back together', async () => {
      const ok = await redshift.runInTransaction(config, ID, [
        `DELETE FROM ${SCHEMA}.orders WHERE 1=1`,
        `INSERT INTO ${SCHEMA}.orders ("order") VALUES (1)`,
      ]);
      assert.deepStrictEqual(ok, { success: true });
      const bad = await redshift.runInTransaction(config, ID, [
        `DELETE FROM ${SCHEMA}.orders WHERE 1=1`,
        `INSERT INTO ${SCHEMA}.missing_table VALUES (1)`,
      ]);
      assert.strictEqual(bad.success, false);
      assert.strictEqual(bad.code, '42P01');
      const c = await run(`SELECT COUNT(*)::int AS n FROM ${SCHEMA}.orders`);
      assert.strictEqual(c.rows[0].n, 1, 'the DELETE must have been rolled back');
    });

    await t.test('a failed query keeps its SQLSTATE', async () => {
      const r = await redshift.runQuery(config, ID, { query: `ALTER TABLE ${SCHEMA}.orders ADD COLUMN amount INTEGER` });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.code, '42701');
    });
  } finally {
    await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await redshift.closeConnection(ID);
  }
});

test('Redshift connector: pure helpers', () => {
  assert.strictEqual(redshift.quoteColumn('e.mail'), '"e.mail"');
  assert.strictEqual(redshift.quoteIdentifier('public.orders'), '"public"."orders"');
  assert.strictEqual(redshift.quoteIdentifier('orders', 'sales'), '"sales"."orders"');
  assert.strictEqual(redshift.columnNameProblem('x'.repeat(128)), 'is 128 bytes long; Redshift allows at most 127');
  assert.strictEqual(redshift.types.STRING(1000), 'VARCHAR(65535)');
  assert.strictEqual(redshift.types.DECIMAL(50, 2), null);
  assert.deepStrictEqual(redshift.toCanonicalType({ type: 'super' }), { kind: 'OBJECT' });
  assert.match(redshift.mergeSupport.guidance, /^MERGE INTO \{\{TARGET\}\} USING/);
});
