/**
 * Schema-aware autocomplete for the worksheet editor.
 *
 * Suggestions are assembled from three sources, weighted so the most likely
 * thing is at the top:
 *
 *   1. objects in the selected schema — tables and collections
 *   2. columns, once we know which table the caret is talking about
 *   3. the engine's keywords and functions, from its connector
 *
 * Everything is computed from data the explorer already holds, so typing
 * never waits on IPC. Columns for a table are fetched once, on first mention,
 * and cached by the caller.
 */

// Sort keys — Monaco orders lexicographically, so a numeric prefix pins the
// group order regardless of label.
const ORDER = {
  column: '0',
  object: '1',
  schema: '2',
  keyword: '3',
  function: '4',
};

/** Identifiers needing quotes: anything not a plain lowercase word. */
const needsQuoting = (name) => !/^[a-z_][a-z0-9_]*$/.test(String(name));

const quoteWith = (name, quote) => (needsQuoting(name) ? `${quote}${name}${quote}` : name);

/**
 * Find table references in a statement so `alias.` can resolve to columns.
 * Handles `FROM schema.table alias`, `JOIN table AS alias`, and bare tables.
 *
 * @returns {Map<string, {schema: string|null, table: string}>} keyed by both
 *   the alias and the bare table name.
 */
export function collectTableRefs(statementText) {
  const refs = new Map();
  const src = String(statementText || '');

  // FROM/JOIN/UPDATE/INTO  [schema.]table  [AS] [alias]
  const RE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([`"[\]\w$.]+)(?:\s+(?:AS\s+)?(?!ON\b|USING\b|WHERE\b|GROUP\b|ORDER\b|LEFT\b|RIGHT\b|INNER\b|OUTER\b|FULL\b|CROSS\b|JOIN\b|LIMIT\b|SET\b|VALUES\b)([A-Za-z_][\w$]*))?/gi;

  let m = RE.exec(src);
  while (m) {
    const unquote = (s) => String(s || '').replace(/[`"[\]]/g, '');
    const parts = unquote(m[1]).split('.').filter(Boolean);
    if (parts.length) {
      const table = parts[parts.length - 1];
      const schema = parts.length > 1 ? parts[parts.length - 2] : null;
      const entry = { schema, table };
      refs.set(table.toLowerCase(), entry);
      if (m[2]) refs.set(m[2].toLowerCase(), entry);
    }
    m = RE.exec(src);
  }

  return refs;
}

/** Every object across the tree, flattened, with its schema and kind. */
function flattenObjects(schemas) {
  const out = [];
  for (const schema of schemas || []) {
    for (const [kind, list] of Object.entries(schema.objects || {})) {
      for (const obj of list || []) {
        out.push({ schema: schema.name, name: obj.name, kind });
      }
    }
  }
  return out;
}

/**
 * Build the suggestion list for one caret position.
 *
 * Pure and synchronous so it can be unit-tested without Monaco; the provider
 * below only maps the result onto Monaco's item shape.
 *
 * @param {object} args
 * @param {string} args.textBefore    worksheet text up to the caret
 * @param {string} args.statementText the statement the caret is in
 * @param {object} args.dialect       from explorer:metadata
 * @param {Array}  args.schemas       from explorer:schema-tree
 * @param {string} args.activeSchema  the schema selected in the toolbar
 * @param {function} args.columnsFor  (schema, table) => columns[] | null
 * @returns {{items: Array, pendingTable: {schema,table}|null}} `pendingTable`
 *   is a table whose columns we wanted but don't have cached yet, so the
 *   caller can fetch them for next time.
 */
export function buildSuggestions({
  textBefore,
  statementText,
  dialect,
  schemas,
  activeSchema,
  columnsFor,
}) {
  const items = [];
  const quote = (dialect && dialect.quote) || '"';
  const isDoc = dialect && dialect.language === 'json';
  const objects = flattenObjects(schemas);
  let pendingTable = null;

  const add = (label, kind, detail, insertText) => {
    items.push({
      label: String(label),
      kind,
      detail,
      insertText: insertText === undefined ? String(label) : insertText,
      sortText: ORDER[kind] + String(label).toLowerCase(),
    });
  };

  // ── document stores ──────────────────────────────────────────────────────
  if (isDoc) {
    // `db.` → collection names
    if (/\bdb\s*\.\s*[\w$]*$/.test(textBefore)) {
      objects
        .filter((o) => !activeSchema || o.schema === activeSchema)
        .forEach((o) => add(o.name, 'object', `${o.schema} · collection`));
      return { items, pendingTable };
    }

    // Field names of whichever collection this statement names. The bare form
    // must not match a dot, or `db.page_views.find(` reads as one long name;
    // dotted collection names go through getCollection("…").
    const named = /\bdb\s*\.\s*(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([\w$-]+))/.exec(statementText);
    const collection = named ? (named[1] || named[2]) : null;
    if (collection) {
      const schema = (objects.find((o) => o.name === collection) || {}).schema || activeSchema;
      const cols = columnsFor(schema, collection);
      if (cols) {
        cols.forEach((c) => add(c.name, 'column', `${collection} · ${c.type || 'field'}`, `"${c.name}"`));
      } else if (schema) {
        pendingTable = { schema, table: collection };
      }
    }

    (dialect.keywords || []).forEach((k) => add(k, 'keyword', 'operator'));
    (dialect.functions || []).forEach((f) => add(f, 'function', 'expression'));
    return { items, pendingTable };
  }

  // ── SQL ──────────────────────────────────────────────────────────────────

  // A qualifier immediately before the caret: `something.` — either a schema
  // (offer its tables) or a table/alias (offer its columns).
  const qualified = /([A-Za-z_][\w$]*)\s*\.\s*([\w$]*)$/.exec(textBefore);
  if (qualified) {
    const prefix = qualified[1];
    const schemaHit = (schemas || []).find(
      (s) => s.name.toLowerCase() === prefix.toLowerCase(),
    );

    if (schemaHit) {
      flattenObjects([schemaHit]).forEach((o) =>
        add(o.name, 'object', `${schemaHit.name} · ${o.kind.replace(/s$/, '')}`, quoteWith(o.name, quote)),
      );
      return { items, pendingTable };
    }

    // Treat it as a table or alias.
    const refs = collectTableRefs(statementText);
    const ref = refs.get(prefix.toLowerCase())
      || { schema: activeSchema, table: prefix };
    const cols = columnsFor(ref.schema || activeSchema, ref.table);

    if (cols) {
      cols.forEach((c) =>
        add(c.name, 'column', `${ref.table} · ${c.type || ''}`.trim(), quoteWith(c.name, quote)),
      );
    } else if (ref.table) {
      pendingTable = { schema: ref.schema || activeSchema, table: ref.table };
    }
    return { items, pendingTable };
  }

  // Right after FROM / JOIN / UPDATE / INTO → tables lead.
  const afterFrom = /\b(FROM|JOIN|UPDATE|INTO)\s+[\w$]*$/i.test(textBefore);

  // Columns of every table this statement already mentions.
  const refs = collectTableRefs(statementText);
  const seenColumn = new Set();
  for (const ref of new Set(refs.values())) {
    const cols = columnsFor(ref.schema || activeSchema, ref.table);
    if (!cols) {
      if (!pendingTable && ref.table) pendingTable = { schema: ref.schema || activeSchema, table: ref.table };
      continue;
    }
    cols.forEach((c) => {
      if (seenColumn.has(c.name)) return;
      seenColumn.add(c.name);
      add(c.name, 'column', `${ref.table} · ${c.type || ''}`.trim(), quoteWith(c.name, quote));
    });
  }

  // Objects — the selected schema unqualified, everything else qualified, so
  // picking a table from another schema still produces a runnable reference.
  objects.forEach((o) => {
    const inActive = !activeSchema || o.schema === activeSchema;
    const insert = inActive
      ? quoteWith(o.name, quote)
      : `${quoteWith(o.schema, quote)}.${quoteWith(o.name, quote)}`;
    const label = inActive ? o.name : `${o.schema}.${o.name}`;
    items.push({
      label,
      kind: 'object',
      detail: `${o.schema} · ${o.kind.replace(/s$/, '')}`,
      insertText: insert,
      // Inside FROM/JOIN tables should outrank everything; elsewhere they sit
      // below columns. Active-schema objects always precede other schemas'.
      sortText: (afterFrom ? '0' : ORDER.object) + (inActive ? '0' : '1') + label.toLowerCase(),
    });
  });

  (schemas || []).forEach((s) => add(s.name, 'schema', 'schema'));

  if (!afterFrom) {
    (dialect.keywords || []).forEach((k) => add(k, 'keyword', 'keyword'));
    (dialect.functions || []).forEach((f) => add(f, 'function', 'function', `${f}(`));
  }

  return { items, pendingTable };
}

/**
 * Wrap `buildSuggestions` as a Monaco completion provider.
 *
 * @param {object} monaco   the monaco namespace
 * @param {function} getContext returns the args buildSuggestions needs, read
 *   fresh on each keystroke so schema/column changes are picked up without
 *   re-registering
 * @param {function} onNeedColumns called with {schema, table} when a lookup
 *   missed the cache
 */
export function makeCompletionProvider(monaco, getContext, onNeedColumns) {
  const KIND = {
    column: monaco.languages.CompletionItemKind.Field,
    object: monaco.languages.CompletionItemKind.Struct,
    schema: monaco.languages.CompletionItemKind.Module,
    keyword: monaco.languages.CompletionItemKind.Keyword,
    function: monaco.languages.CompletionItemKind.Function,
  };

  return {
    // `.` re-triggers so qualified names complete as soon as it's typed.
    triggerCharacters: ['.', ' ', '"', '$'],

    provideCompletionItems(model, position) {
      const ctx = getContext();
      if (!ctx) return { suggestions: [] };

      const textBefore = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const { items, pendingTable } = buildSuggestions({ ...ctx, textBefore });

      // Warm the cache so the next keystroke has this table's columns.
      if (pendingTable && onNeedColumns) onNeedColumns(pendingTable);

      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: KIND[it.kind] || monaco.languages.CompletionItemKind.Text,
          detail: it.detail,
          insertText: it.insertText,
          sortText: it.sortText,
          range,
        })),
      };
    },
  };
}
