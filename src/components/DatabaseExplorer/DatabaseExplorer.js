/**
 * Data Explorer.
 *
 * A worksheet-based database IDE: browse the schema on the left, write and run
 * statements in the middle, read results below. Worksheets persist per
 * connection, so reopening a connection restores what you were working on.
 *
 * Every database interaction goes through window.electronAPI.explorer, which is
 * backed by public/database/ in the main process. Nothing here talks to a
 * driver directly, and nothing here knows one engine's syntax from another's —
 * that all arrives as `dialect`.
 *
 * Props
 *   connection       { id, name, dbType, dbConfig }
 *   onClose          dismiss the explorer
 *   onContextChange  optional — reports the open worksheet (or the user's
 *                    selection) so the main chat assistant can reference it
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { C, MONO, SANS, Icon, metaFor } from './theme';
import ObjectPanel from './ObjectPanel';
import QueryEditor from './QueryEditor';
import ResultsPanel from './ResultsPanel';
import { WorksheetTabs, Toolbar } from './WorksheetTabs';
import { splitStatements, summarize } from './statements';

/**
 * Typing is kept off the React render path: Monaco owns the buffer, and the
 * text is committed to state only after a pause. Everything downstream of the
 * text — validation, autosave, the chat context — keys off that commit, so a
 * keystroke costs nothing beyond Monaco's own work.
 */
// Rows a double-click preview asks for. Deliberately small: opening a table is
// a glance, not a read of the whole thing.
const PREVIEW_ROWS = 100;
const EDIT_COMMIT_MS = 350;
const SAVE_DEBOUNCE_MS = 700;
const VALIDATE_DEBOUNCE_MS = 250;

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

// Results-panel layout, remembered per connection. localStorage rather than the
// worksheet store: it is a view preference, not part of the user's work, and it
// must be readable synchronously on first paint to avoid a visible jump.
const LAYOUT_KEY = 'ternlux.explorer.resultsLayout';
const DEFAULT_LAYOUT = { dock: 'bottom', size: 0.4 };

const readLayout = (connectionId) => {
  try {
    const all = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || '{}');
    const mine = all[connectionId || '_'];
    if (!mine) return { ...DEFAULT_LAYOUT };
    return {
      dock: mine.dock === 'right' ? 'right' : 'bottom',
      size: Math.min(0.85, Math.max(0.15, Number(mine.size) || DEFAULT_LAYOUT.size)),
    };
  } catch (_) {
    return { ...DEFAULT_LAYOUT };
  }
};

const writeLayout = (connectionId, layout) => {
  try {
    const all = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || '{}');
    all[connectionId || '_'] = layout;
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
  } catch (_) { /* private mode / quota — the session default still applies */ }
};

const newWorksheet = (connectionId, index, overrides = {}) => ({
  id: uuid(),
  connectionId,
  name: `Worksheet ${index}`,
  sql: '',
  dirty: false,
  ...overrides,
});

const DatabaseExplorer = ({ connection, onClose, onContextChange }) => {
  const dbType = connection.dbType;
  const connectionId = connection.id || connection._id || null;
  const meta = metaFor(dbType);

  // File connections (local files, node outputs) carry their location in
  // `fileInfo` rather than `dbConfig`. The table list rides along to keep each
  // connection scoped to what it owns, and `tablePaths` maps those names to
  // files — a workbook becomes one Parquet file per sheet, so a connection can
  // own several paths at once.
  const config = useMemo(() => {
    if (connection.connectionType === 'file' && connection.fileInfo) {
      return {
        ...(connection.dbConfig || {}),
        dbPath: connection.fileInfo.filePath,
        tables: connection.fileInfo.tables || null,
        tablePaths: connection.fileInfo.tablePaths || null,
        format: connection.fileInfo.format || null,
      };
    }
    return connection.dbConfig;
  }, [connection]);

  const api = window.electronAPI && window.electronAPI.explorer;
  const isElectron = Boolean(api);

  // ── dialect + schema ─────────────────────────────────────────────────────
  const [dialect, setDialect] = useState(null);
  const [connectorMissing, setConnectorMissing] = useState(false);
  const [schemas, setSchemas] = useState([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState(null);
  const [activeSchema, setActiveSchema] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [favorites, setFavorites] = useState([]);

  // Column cache, keyed "schema.table". Feeds both the tree and autocomplete.
  const [columnCache, setColumnCache] = useState({});
  const pendingColumns = useRef(new Set());

  // ── worksheets ───────────────────────────────────────────────────────────
  const [worksheets, setWorksheets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selection, setSelection] = useState('');
  const saveTimers = useRef({});

  // ── execution ────────────────────────────────────────────────────────────
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState([]);
  const [history, setHistory] = useState([]);
  const [resultTab, setResultTab] = useState('results');
  const [resultsMinimized, setResultsMinimized] = useState(false);

  // Where the results sit and how much room they get. Both persist per
  // connection, so a layout you set up for one database is what you come back
  // to. `size` is a fraction of the editor area (0.15–0.85) rather than pixels,
  // so it survives a window resize.
  const [resultsDock, setResultsDock] = useState(() => readLayout(connectionId).dock);
  const [resultsSize, setResultsSize] = useState(() => readLayout(connectionId).size);
  const splitRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    const l = readLayout(connectionId);
    setResultsDock(l.dock);
    setResultsSize(l.size);
  }, [connectionId]);

  useEffect(() => {
    writeLayout(connectionId, { dock: resultsDock, size: resultsSize });
  }, [connectionId, resultsDock, resultsSize]);

  // Drag the divider. Pointer capture keeps the gesture alive over the Monaco
  // iframe and past the window edge, and the listeners are torn down on the
  // same handler that installed them.
  const startResize = useCallback((e) => {
    e.preventDefault();
    const host = splitRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    dragRef.current = { box };

    const onMove = (ev) => {
      const { box: b } = dragRef.current || {};
      if (!b) return;
      const fraction = resultsDock === 'right'
        ? (b.right - ev.clientX) / b.width
        : (b.bottom - ev.clientY) / b.height;
      setResultsSize(Math.min(0.85, Math.max(0.15, fraction)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = resultsDock === 'right' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [resultsDock]);

  // ── chrome ───────────────────────────────────────────────────────────────
  const [panelHidden, setPanelHidden] = useState(false);
  const [toast, setToast] = useState(null);
  const editorRef = useRef(null);

  const activeSheet = useMemo(
    () => worksheets.find((w) => w.id === activeId) || worksheets[0] || null,
    [worksheets, activeId],
  );

  const isDocumentStore = Boolean(dialect && dialect.language === 'json');

  const ping = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 2600);
  }, []);

  // ── load dialect, schema, worksheets, history ────────────────────────────

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;

    (async () => {
      const res = await api.metadata(dbType);
      if (cancelled) return;
      setDialect(res.dialect);
      setConnectorMissing(res.installed === false);
    })();

    return () => { cancelled = true; };
  }, [api, dbType, isElectron]);

  const loadSchema = useCallback(async () => {
    if (!isElectron) return;
    setSchemaLoading(true);
    setSchemaError(null);

    const res = await api.schemaTree(dbType, config, connectionId);
    setSchemaLoading(false);

    if (!res.success) {
      setSchemaError(res.message || 'Could not load the schema.');
      setSchemas([]);
      return;
    }

    setSchemas(res.schemas);
    // Default the completion scope to the only schema, or the connection's
    // configured one, so unqualified names resolve straight away.
    setActiveSchema((current) => {
      if (current) return current;
      // Local files list every sibling file so they can be joined; the one the
      // user actually opened comes back flagged `primary` and is what gets
      // focus, so unqualified names still mean the file they clicked.
      const primary = res.schemas.find((s) => s.primary);
      if (primary) return primary.name;
      if (res.schemas.length === 1) return res.schemas[0].name;
      const configured = config && (config.schema || config.database);
      const hit = res.schemas.find((s) => s.name === configured);
      return hit ? hit.name : null;
    });
  }, [api, dbType, config, connectionId, isElectron]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  // Restore the notepad for this connection, or start a first worksheet.
  useEffect(() => {
    if (!isElectron || !connectionId) {
      setWorksheets([newWorksheet(connectionId, 1)]);
      return;
    }
    let cancelled = false;

    (async () => {
      const res = await api.worksheets.list(connectionId);
      if (cancelled) return;

      const restored = (res.worksheets || []).map((w) => ({ ...w, dirty: false }));
      const sheets = restored.length ? restored : [newWorksheet(connectionId, 1)];
      setWorksheets(sheets);
      setActiveId(sheets[0].id);
    })();

    return () => { cancelled = true; };
  }, [api, connectionId, isElectron]);

  const loadHistory = useCallback(async () => {
    if (!isElectron || !connectionId) return;
    const res = await api.history.list(connectionId, 100);
    if (res.success) setHistory(res.history);
  }, [api, connectionId, isElectron]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── column loading ───────────────────────────────────────────────────────

  const columnsFor = useCallback(
    (schema, table) => columnCache[`${schema}.${table}`] || null,
    [columnCache],
  );

  const loadColumns = useCallback(async (schema, table) => {
    if (!isElectron || !schema || !table) return;
    const key = `${schema}.${table}`;
    // One in-flight request per object, and never re-fetch a cached one.
    if (pendingColumns.current.has(key) || columnCache[key]) return;

    pendingColumns.current.add(key);
    const res = await api.columns(dbType, config, connectionId, schema, table);
    pendingColumns.current.delete(key);

    setColumnCache((prev) => ({ ...prev, [key]: res.success ? res.columns : [] }));
  }, [api, dbType, config, connectionId, isElectron, columnCache]);

  // ── worksheet editing + persistence ──────────────────────────────────────

  const patchSheet = useCallback((id, patch) => {
    setWorksheets((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const persistSheet = useCallback(async (sheet) => {
    if (!isElectron || !connectionId) return;
    const res = await api.worksheets.save({
      id: sheet.id,
      connectionId,
      name: sheet.name,
      sql: sheet.sql,
      createdAt: sheet.createdAt,
    });
    if (res.success) patchSheet(sheet.id, { dirty: false, createdAt: res.worksheet.createdAt });
  }, [api, connectionId, isElectron, patchSheet]);

  /** Debounced write-behind — the tab shows a dot until it lands. */
  const scheduleSave = useCallback((sheet) => {
    clearTimeout(saveTimers.current[sheet.id]);
    saveTimers.current[sheet.id] = setTimeout(() => persistSheet(sheet), SAVE_DEBOUNCE_MS);
  }, [persistSheet]);

  useEffect(() => () => {
    // Stop pending autosaves firing into a dead component; the unmount flush
    // below is what actually gets the text to disk.
    Object.values(saveTimers.current).forEach(clearTimeout);
  }, []);

  // Mirrors of state read inside timers and Monaco callbacks, which would
  // otherwise close over a stale render.
  const worksheetsRef = useRef([]);
  const activeIdRef = useRef(null);
  useEffect(() => { worksheetsRef.current = worksheets; }, [worksheets]);
  useEffect(() => { activeIdRef.current = activeSheet ? activeSheet.id : null; }, [activeSheet]);

  const draftRef = useRef({ id: null, text: null });
  const commitTimer = useRef(null);

  /** Move the pending buffer into state and queue it for persistence. */
  const commitDraft = useCallback(() => {
    clearTimeout(commitTimer.current);
    commitTimer.current = null;

    const { id, text } = draftRef.current;
    if (!id || text === null) return;

    const current = worksheetsRef.current.find((w) => w.id === id);
    if (!current || current.sql === text) return;

    patchSheet(id, { sql: text, dirty: true });
    scheduleSave({ ...current, sql: text });
  }, [patchSheet, scheduleSave]);

  const handleSqlChange = useCallback((text) => {
    const id = activeIdRef.current;
    if (!id) return;
    draftRef.current = { id, text };
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitDraft, EDIT_COMMIT_MS);
  }, [commitDraft]);

  /** Replace the buffer and commit at once — for Format and history loads. */
  const applyText = useCallback((text) => {
    const id = activeIdRef.current;
    if (!id) return;
    if (editorRef.current) editorRef.current.setValue(text);
    draftRef.current = { id, text };
    commitDraft();
  }, [commitDraft]);

  // Switching or closing a worksheet must not drop the last few hundred
  // milliseconds of typing.
  const selectWorksheet = useCallback((id) => {
    commitDraft();
    setActiveId(id);
  }, [commitDraft]);

  /**
   * Closing the explorer must not discard the last keystrokes. The commit and
   * save debounces are both still pending at that point, so write the buffer
   * straight to the store on the way out.
   */
  useEffect(() => () => {
    clearTimeout(commitTimer.current);

    const { id, text } = draftRef.current;
    if (!id || text === null || !isElectron || !connectionId) return;

    const current = worksheetsRef.current.find((w) => w.id === id);
    if (!current || current.sql === text) return;

    // Fire and forget — this component is unmounting, but the write is in the
    // main process and completes there.
    api.worksheets.save({
      id,
      connectionId,
      name: current.name,
      sql: text,
      createdAt: current.createdAt,
    });
  }, [api, connectionId, isElectron]);

  // ── validation (debounced, advisory) ─────────────────────────────────────

  useEffect(() => {
    if (!isElectron || !activeSheet) return undefined;
    const text = activeSheet.sql;

    if (!text.trim()) { setIssues([]); return undefined; }

    const timer = setTimeout(async () => {
      const statements = splitStatements(text).map((s) => ({
        text: s.text,
        startLine: s.startLine,
        startColumn: s.startColumn,
      }));
      if (!statements.length) { setIssues([]); return; }

      const res = await api.validate(dbType, statements);
      setIssues(res.success ? res.issues : []);
    }, VALIDATE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [api, dbType, isElectron, activeSheet]);

  // ── running ──────────────────────────────────────────────────────────────

  const runTarget = useCallback(async (target) => {
    if (!target || !target.text.trim() || !isElectron) return;

    setRunning(true);
    setRunError(null);
    setResultTab('results');
    setResultsMinimized(false);

    const res = await api.run(dbType, config, connectionId, target.text);
    setRunning(false);

    if (res.success) {
      // Carry the statement along: it is what a pinned result labels itself
      // with, and what the row-detail pane shows as provenance.
      setResult({ ...res, statement: target.text, summary: summarize(target.text) });
      setRunError(null);
      ping(
        `${res.rowCount != null ? res.rowCount : (res.rows || []).length} `
        + `${isDocumentStore ? 'doc' : 'row'}(s) · ${res.ms} ms`,
      );

      // A statement that changed a table leaves the tree, the column cache and
      // the completions built from it describing something that no longer
      // exists — an ALTER is the obvious case. Drop what it touched and reload.
      if (res.mutated) {
        setColumnCache((prev) => {
          const next = { ...prev };
          for (const m of res.mutated) delete next[`${m.schema}.${m.table}`];
          return next;
        });
        loadSchema();
      }
    } else {
      setResult(null);
      setRunError(res.message || 'The statement failed.');
    }

    // Record every run — a failure and its message is the most useful row in
    // the history list.
    if (connectionId) {
      await api.history.add({
        connectionId,
        sql: target.text,
        summary: summarize(target.text),
        ok: Boolean(res.success),
        ms: res.ms || 0,
        error: res.success ? null : (res.message || null),
      });
      loadHistory();
    }
  }, [api, dbType, config, connectionId, isElectron, isDocumentStore, ping, loadHistory, loadSchema]);

  const handleRunClick = useCallback(() => {
    const target = editorRef.current && editorRef.current.getRunTarget();
    if (!target) { ping('Nothing to run'); return; }
    runTarget(target);
  }, [runTarget, ping]);

  // ── object interaction ───────────────────────────────────────────────────

  const openObject = useCallback(async (schema, obj, kind, preview) => {
    setSelectedKey(`${schema}.${obj.name}`);
    loadColumns(schema, obj.name);

    if (!preview || !isElectron) return;

    // The preview statement is built by the connector — it owns the dialect's
    // quoting AND its row limit. There is deliberately no locally-assembled
    // fallback: the obvious one (`SELECT * FROM schema.table`) is unquoted and
    // unbounded, so on a big table it asks the engine for everything.
    const res = await api.previewQuery(dbType, schema, obj.name, PREVIEW_ROWS);
    if (!res.success || !res.query) {
      ping(res.message || `Could not build a preview for ${obj.name}`);
      return;
    }
    const sql = res.query;

    const sheet = newWorksheet(connectionId, worksheets.length + 1, { name: obj.name, sql, dirty: true });
    setWorksheets((prev) => [...prev, sheet]);
    setActiveId(sheet.id);
    scheduleSave(sheet);
    runTarget({ text: sql, source: 'statement' });
  }, [api, dbType, connectionId, isElectron, worksheets.length, loadColumns, scheduleSave, runTarget, ping]);

  const addWorksheet = useCallback(() => {
    const sheet = newWorksheet(connectionId, worksheets.length + 1);
    setWorksheets((prev) => [...prev, sheet]);
    setActiveId(sheet.id);
  }, [connectionId, worksheets.length]);

  const closeWorksheet = useCallback((id) => {
    setWorksheets((prev) => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex((w) => w.id === id);
      const next = prev.filter((w) => w.id !== id);
      if (id === activeId) setActiveId(next[Math.max(0, index - 1)].id);
      return next;
    });
    clearTimeout(saveTimers.current[id]);
    if (isElectron) api.worksheets.remove(id);
  }, [api, activeId, isElectron]);

  const renameWorksheet = useCallback((id, name) => {
    patchSheet(id, { name, dirty: true });
    const sheet = worksheets.find((w) => w.id === id);
    if (sheet) scheduleSave({ ...sheet, name });
  }, [patchSheet, worksheets, scheduleSave]);

  const toggleFavorite = useCallback((fav) => {
    setFavorites((prev) => (
      prev.some((f) => f.key === fav.key)
        ? prev.filter((f) => f.key !== fav.key)
        : [...prev, fav]
    ));
  }, []);

  // ── formatting ───────────────────────────────────────────────────────────

  // Whether Format is offered is the connector's call — it declares the
  // formatter it wants in its `explorer` block, or omits it.
  const canFormat = Boolean(dialect && dialect.formatter && activeSheet);

  const handleFormat = useCallback(async () => {
    if (!activeSheet || !canFormat) return;

    // Format what is in the editor right now, not the last committed state —
    // the two differ while the commit debounce is pending.
    const source = (editorRef.current && editorRef.current.getValue()) || activeSheet.sql;
    const res = await api.format(dbType, source);

    if (res.success) applyText(res.text);
    else ping('Could not format this statement');
  }, [api, dbType, activeSheet, canFormat, applyText, ping]);

  // ── chat context ─────────────────────────────────────────────────────────
  // The main assistant reads the worksheet the user is looking at. A selection
  // narrows it to just that fragment, which is usually the question being asked.

  useEffect(() => {
    if (!onContextChange) return;
    if (!activeSheet) { onContextChange(null); return; }

    const highlighted = selection.trim();
    onContextChange({
      worksheetName: activeSheet.name,
      language: dialect ? dialect.language : 'sql',
      schema: activeSchema || null,
      isSelection: Boolean(highlighted),
      query: highlighted || activeSheet.sql,
    });
  }, [onContextChange, activeSheet, selection, dialect, activeSchema]);

  // Clear the reported context when the explorer goes away.
  useEffect(() => () => { if (onContextChange) onContextChange(null); }, [onContextChange]);

  // ── autocomplete context ─────────────────────────────────────────────────

  const completionContext = useCallback(() => {
    if (!dialect || !activeSheet) return null;
    return {
      statementText: activeSheet.sql,
      dialect,
      schemas,
      activeSchema,
      columnsFor,
    };
  }, [dialect, activeSheet, schemas, activeSchema, columnsFor]);

  // ── render ───────────────────────────────────────────────────────────────

  if (!isElectron) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.bg, fontFamily: SANS, padding: 24, textAlign: 'center',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
            Desktop app required
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            Direct database connections run in the Ternlux desktop app.
          </div>
        </div>
      </div>
    );
  }

  const runScope = selection.trim()
    ? 'selection'
    : (activeSheet && splitStatements(activeSheet.sql).length > 1 ? 'statement at caret' : null);

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: C.bg, fontFamily: SANS, overflow: 'hidden',
    }}>
      {/* title bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 46, flexShrink: 0,
        padding: '0 10px 0 12px', background: C.bg, borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, flexShrink: 0,
          background: `${meta.color}14`, border: `1px solid ${meta.color}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {Icon('db', meta.color, 15)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            {connection.name}
          </div>
          <div style={{ fontSize: 9.5, fontFamily: MONO, color: C.muted, marginTop: 1, whiteSpace: 'nowrap' }}>
            {meta.label}
            {activeSchema ? ` · ${activeSchema}` : ''}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {toast && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20,
            background: C.greenD, border: '1px solid #a7f3d0',
            fontSize: 10.5, fontFamily: MONO, fontWeight: 600, color: C.green, whiteSpace: 'nowrap',
          }}>
            {Icon('check', C.green, 10)} {toast}
          </div>
        )}

        {onClose && (
          <button
            type="button"
            title="Close"
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: 5, border: 'none', background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {Icon('close', C.muted, 14)}
          </button>
        )}
      </div>

      {connectorMissing && (
        <div style={{
          padding: '8px 14px', background: C.amberD, borderBottom: `1px solid ${C.amberB}`,
          fontSize: 11.5, color: C.amber,
        }}>
          No connector plugin is installed for “{dbType}”. Browsing and running are unavailable.
        </div>
      )}

      {/* body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!panelHidden && (
          <ObjectPanel
            dbType={dbType}
            containerLabel={dialect ? dialect.container : 'Schema'}
            schemas={schemas}
            loading={schemaLoading}
            error={schemaError}
            onRefresh={loadSchema}
            activeSchema={activeSchema}
            onSelectSchema={setActiveSchema}
            onOpenObject={openObject}
            selectedKey={selectedKey}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            worksheets={worksheets}
            activeWorksheetId={activeSheet ? activeSheet.id : null}
            onSelectWorksheet={selectWorksheet}
            onNewWorksheet={addWorksheet}
            columnsFor={columnsFor}
            onLoadColumns={loadColumns}
            onCollapse={() => setPanelHidden(true)}
            historyOpen={resultTab === 'history'}
            historyCount={history.length}
            onOpenHistory={() => {
              setResultTab(resultTab === 'history' ? 'results' : 'history');
              setResultsMinimized(false);
            }}
          />
        )}

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <WorksheetTabs
            worksheets={worksheets}
            activeId={activeSheet ? activeSheet.id : null}
            onSelect={selectWorksheet}
            onNew={addWorksheet}
            onClose={closeWorksheet}
            onRename={renameWorksheet}
            panelHidden={panelHidden}
            onShowPanel={() => setPanelHidden(false)}
          />

          <Toolbar
            onRun={handleRunClick}
            running={running}
            canRun={Boolean(activeSheet && activeSheet.sql.trim() && !connectorMissing)}
            runScope={runScope}
            onFormat={handleFormat}
            canFormat={canFormat}
            onCopy={() => {
              if (!activeSheet) return;
              try {
                navigator.clipboard.writeText(activeSheet.sql);
                ping('Worksheet copied');
              } catch (_) { /* clipboard denied */ }
            }}
            issues={issues}
          />

          {/* Editor + results, split either horizontally or vertically. The
              divider between them is draggable; `resultsSize` is the share of
              this box the results take. */}
          <div
            ref={splitRef}
            style={{
              flex: 1, minHeight: 0, minWidth: 0, display: 'flex',
              flexDirection: resultsDock === 'right' ? 'row' : 'column',
            }}
          >
            <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {activeSheet && (
                <QueryEditor
                  key={activeSheet.id}
                  ref={editorRef}
                  value={activeSheet.sql}
                  onChange={handleSqlChange}
                  language={dialect ? dialect.language : 'sql'}
                  issues={issues}
                  onRun={runTarget}
                  onSelectionChange={setSelection}
                  getCompletionContext={completionContext}
                  onNeedColumns={({ schema, table }) => loadColumns(schema, table)}
                />
              )}
            </div>

            {/* Drag handle. A minimized panel has nothing to resize. */}
            {!resultsMinimized && (
              <div
                onPointerDown={startResize}
                onDoubleClick={() => setResultsSize(DEFAULT_LAYOUT.size)}
                title="Drag to resize · double-click to reset"
                style={{
                  flexShrink: 0,
                  ...(resultsDock === 'right'
                    ? { width: 5, cursor: 'col-resize' }
                    : { height: 5, cursor: 'row-resize' }),
                  background: 'transparent',
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = C.accent; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
              />
            )}

            <div style={{
              display: 'flex', minHeight: 0, minWidth: 0,
              ...(resultsMinimized
                ? { flex: '0 0 auto' }
                : {
                  flex: `0 0 ${(resultsSize * 100).toFixed(2)}%`,
                  ...(resultsDock === 'right' ? { maxWidth: '85%' } : { maxHeight: '85%' }),
                }),
            }}>
              <ResultsPanel
                result={result}
                error={runError}
                running={running}
                history={history}
                tab={resultTab}
                onTab={setResultTab}
                onLoadHistory={(sql) => {
                  applyText(sql);
                  setResultTab('results');
                  ping('Loaded into the worksheet');
                }}
                onClearHistory={async () => {
                  await api.history.clear(connectionId);
                  loadHistory();
                }}
                isDocumentStore={isDocumentStore}
                minimized={resultsMinimized}
                onMinimize={setResultsMinimized}
                dock={resultsDock}
                onDock={setResultsDock}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DatabaseExplorer;
