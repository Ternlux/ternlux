/**
 * Data Explorer — result panel.
 *
 * Shows the result of the last run — or, once pinned, the result that was on
 * screen when the pin went in, held there while later runs happen behind it.
 * Query history opens here too, from the sidebar, as a second tab.
 *
 * Tabular results render as a grid; document results (or rows holding nested
 * objects) render as JSON. Statements that return no rows get a message pane.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, MONO, SANS, Icon } from './theme';

// ── value formatting ───────────────────────────────────────────────────────

const formatCell = (value, column) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (column && column.numeric && typeof value === 'number') {
    return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  return String(value);
};

const toCsv = (columns, rows) => {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => esc(c.name)).join(','),
    ...rows.map((r) => columns.map((c) => esc(r[c.name])).join(',')),
  ].join('\n');
};

const download = (filename, text, mime) => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Give the click a tick to start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── grid ───────────────────────────────────────────────────────────────────
//
// The grid renders only the rows in view. Everything below exists to keep that
// cheap, because the old version paid for the whole result on EVERY render:
// selecting one cell re-rendered every cell in the table, and at a thousand
// rows that is tens of thousands of DOM nodes, inline style objects and event
// closures rebuilt per click.
//
// Four things keep it fast now:
//   * windowing — only the visible slice is in the DOM;
//   * `table-layout: fixed` with measured column widths, so the browser never
//     re-measures cell content (and columns don't jitter as you scroll);
//   * a memoised Row, so changing the selection re-renders the rows that
//     changed rather than all of them;
//   * static styles hoisted out of render.

const ROW_H = 26;          // must match the td height exactly — windowing maths
const HEAD_H = 28;
const OVERSCAN = 8;        // rows rendered off-screen each way, to hide scroll
const GUTTER_W = 46;
const COL_MIN = 90;
const COL_MAX = 420;
const CHAR_W = 6.7;        // ~1ch at 11.5px in this monospace face
const WIDTH_SAMPLE = 150;  // rows sampled to size columns

const gridStyles = {
  scroller: { flex: 1, overflow: 'auto', background: C.bg, minHeight: 0, position: 'relative' },
  gutterHead: {
    position: 'sticky', top: 0, left: 0, zIndex: 4, width: GUTTER_W, height: HEAD_H,
    background: C.s3, borderBottom: `1px solid ${C.border2}`, borderRight: `1px solid ${C.border2}`,
  },
  fillerHead: {
    position: 'sticky', top: 0, zIndex: 2,
    background: C.s2, borderBottom: `1px solid ${C.border2}`,
  },
  headInner: { display: 'flex', alignItems: 'center', gap: 5 },
  colType: { fontSize: 9, color: C.dim },
  nullCell: { fontSize: 10.5, color: C.dim, fontStyle: 'italic' },
  spacerCell: { padding: 0, border: 0 },
};

/** Column pixel widths, measured once per result from a sample of its rows. */
function measureWidths(columns, rows) {
  const sample = Math.min(rows.length, WIDTH_SAMPLE);
  return columns.map((col) => {
    // header text + type label + sort caret
    let widest = String(col.name).length + String(col.type || '').length + 4;
    for (let i = 0; i < sample; i++) {
      const v = rows[i] ? rows[i][col.name] : null;
      if (v === null || v === undefined) { if (widest < 4) widest = 4; continue; }
      const len = typeof v === 'object' ? JSON.stringify(v).length : String(v).length;
      if (len > widest) widest = len;
    }
    return Math.round(Math.min(COL_MAX, Math.max(COL_MIN, widest * CHAR_W + 20)));
  });
}

const Row = React.memo(function Row({
  row, rowIndex, displayIndex, columns, widths, isOpen, selected, selectedColumn,
  onOpenRow, onCellDown, onRowEnter,
}) {
  const zebra = displayIndex % 2 ? C.surface : C.bg;
  const background = selected ? C.aS : zebra;

  return (
    <tr onPointerEnter={() => onRowEnter(rowIndex)}>
      <td
        onClick={() => onOpenRow(isOpen ? null : rowIndex)}
        title="Show row detail"
        style={{
          position: 'sticky', left: 0, zIndex: 1, width: GUTTER_W, height: ROW_H,
          background: isOpen ? C.aD : selected ? C.aS : C.s2,
          borderBottom: `1px solid ${C.border}`, borderRight: `2px solid ${C.border2}`,
          padding: '0 6px', textAlign: 'right', cursor: 'pointer',
          fontSize: 10, color: isOpen ? C.accent : selected ? C.accent : C.dim,
        }}
      >
        {displayIndex + 1}
      </td>

      {columns.map((col, ci) => {
        const value = row[col.name];
        const isCell = selectedColumn === col.name;
        return (
          <td
            key={col.name}
            onPointerDown={(e) => onCellDown(e, rowIndex, col.name, value)}
            style={{
              height: ROW_H, padding: '0 9px', width: widths[ci],
              borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`,
              textAlign: col.numeric ? 'right' : 'left',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              background,
              boxShadow: isCell ? `inset 0 0 0 2px ${C.accent}` : 'none',
              cursor: 'default',
            }}
          >
            {value === null || value === undefined
              ? <span style={gridStyles.nullCell}>NULL</span>
              : <span style={{ color: typeof value === 'object' ? C.cyan : C.text }}>
                  {formatCell(value, col)}
                </span>}
          </td>
        );
      })}

      <td style={{ borderBottom: `1px solid ${C.border}`, background }} />
    </tr>
  );
});

const Grid = ({
  result, onOpenRow, openRow, onSelectCell, selectedCell,
  selectedRows, onSelectRows,
}) => {
  const [sort, setSort] = useState(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scrollerRef = useRef(null);
  // Live drag state. A ref, not state: it changes on every pointermove and
  // nothing about it needs to trigger a render on its own.
  const drag = useRef(null);

  // Memoised so the sort and width computations below keep a stable identity —
  // a bare `result.rows || []` mints a new array whenever rows are absent, and
  // that alone would re-sort and re-measure on every render.
  const allRows = useMemo(() => result.rows || [], [result.rows]);
  const columns = useMemo(() => result.columns || [], [result.columns]);

  // Sorting reorders INDICES. The rows themselves are never copied or spread,
  // so sorting a large result costs one integer array, not a second copy of
  // the data.
  const order = useMemo(() => {
    const idx = allRows.map((_, i) => i);
    if (!sort) return idx;
    const { column, direction } = sort;
    const dir = direction === 'asc' ? 1 : -1;
    return idx.sort((a, b) => {
      const x = allRows[a][column];
      const y = allRows[b][column];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y));
      return cmp * dir;
    });
  }, [allRows, sort]);

  // Reverse lookup: row index -> its position in the display order. Drag
  // selection needs this on every pointer move, and scanning `order` each time
  // would be O(rows) per mouse event.
  const positions = useMemo(() => {
    const m = new Int32Array(allRows.length);
    for (let d = 0; d < order.length; d++) m[order[d]] = d;
    return m;
  }, [order, allRows.length]);

  const widths = useMemo(() => measureWidths(columns, allRows), [columns, allRows]);
  const totalWidth = useMemo(
    () => widths.reduce((n, w) => n + w, GUTTER_W), [widths],
  );

  // Visible slice.
  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewport.height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(order.length, first + visibleCount);
  const padTop = first * ROW_H;
  const padBottom = Math.max(0, (order.length - last) * ROW_H);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setViewport((prev) => (
      // Only re-render when the slice could actually change.
      Math.abs(prev.top - el.scrollTop) >= ROW_H || prev.height !== el.clientHeight
        ? { top: el.scrollTop, height: el.clientHeight }
        : prev
    ));
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const sync = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cycleSort = (name) => setSort((prev) => {
    if (!prev || prev.column !== name) return { column: name, direction: 'asc' };
    if (prev.direction === 'asc') return { column: name, direction: 'desc' };
    return null;
  });

  // ── selection ────────────────────────────────────────────────────────────
  //
  // Press and drag across rows to select them. The grid sets `user-select:
  // none`, so a drag extends the row selection instead of smearing a text
  // highlight across the cells. A press that never leaves its row is treated
  // as an ordinary cell click, so inspecting a single value still works.
  const applyRange = useCallback((anchor, focus, base) => {
    const lo = Math.min(anchor, focus);
    const hi = Math.max(anchor, focus);
    const next = new Set(base);
    for (let d = lo; d <= hi; d++) next.add(order[d]);
    onSelectRows(next);
  }, [order, onSelectRows]);

  const onCellDown = useCallback((e, rowIndex, column, value) => {
    if (e.button !== 0) return;
    const displayIndex = positions[rowIndex];
    const additive = e.metaKey || e.ctrlKey;
    // What the selection builds on top of: existing rows when the modifier is
    // held, nothing otherwise.
    const base = additive ? new Set(selectedRows) : [];

    if (e.shiftKey && selectedRows.size) {
      // Extend from the previous anchor rather than starting over.
      const anchor = drag.current && drag.current.anchor != null
        ? drag.current.anchor
        : displayIndex;
      drag.current = { anchor, base, additive, moved: true, column, value, rowIndex };
      applyRange(anchor, displayIndex, base);
      return;
    }

    drag.current = { anchor: displayIndex, base, additive, moved: false, column, value, rowIndex };

    if (additive) {
      const next = new Set(selectedRows);
      if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex);
      onSelectRows(next);
    }
  }, [positions, selectedRows, onSelectRows, applyRange]);

  const onRowEnter = useCallback((rowIndex) => {
    const d = drag.current;
    if (!d) return;
    const displayIndex = positions[rowIndex];
    if (displayIndex === d.anchor && !d.moved) return;
    d.moved = true;
    applyRange(d.anchor, displayIndex, d.base);
  }, [positions, applyRange]);

  useEffect(() => {
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      // A press that never crossed a row boundary is an ordinary cell click.
      if (!d.moved) {
        onSelectCell({ row: d.rowIndex, column: d.column, value: d.value });
        if (!d.additive) onSelectRows(new Set([d.rowIndex]));
      }
      drag.current = null;
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [onSelectCell, onSelectRows]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      style={{ ...gridStyles.scroller, userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <table style={{
        borderCollapse: 'separate', borderSpacing: 0,
        fontFamily: MONO, fontSize: 11.5,
        // Fixed layout is what stops the browser measuring every cell — and
        // what keeps column widths steady while rows scroll in and out.
        tableLayout: 'fixed', width: Math.max(totalWidth, 0),
        minWidth: '100%',
      }}>
        <colgroup>
          <col style={{ width: GUTTER_W }} />
          {columns.map((col, i) => <col key={col.name} style={{ width: widths[i] }} />)}
          <col />
        </colgroup>

        <thead>
          <tr>
            <th style={gridStyles.gutterHead} />
            {columns.map((col) => {
              const active = sort && sort.column === col.name;
              return (
                <th
                  key={col.name}
                  onClick={() => cycleSort(col.name)}
                  title={`${col.name} · ${col.type}`}
                  style={{
                    position: 'sticky', top: 0, zIndex: 2, height: HEAD_H,
                    background: C.s2, borderBottom: `2px solid ${active ? C.accent : C.border2}`,
                    borderRight: `1px solid ${C.border}`, padding: '0 8px',
                    textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <div style={gridStyles.headInner}>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, color: active ? C.accent : C.text,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {col.name}
                    </span>
                    <span style={gridStyles.colType}>{col.type}</span>
                    {active && Icon(sort.direction === 'asc' ? 'up' : 'down', C.accent, 11)}
                  </div>
                </th>
              );
            })}
            <th style={gridStyles.fillerHead} />
          </tr>
        </thead>

        <tbody>
          {/* Spacers stand in for the rows that aren't rendered, so the
              scrollbar reflects the whole result. */}
          {padTop > 0 && (
            <tr aria-hidden="true" style={{ height: padTop }}>
              <td colSpan={columns.length + 2} style={gridStyles.spacerCell} />
            </tr>
          )}

          {order.slice(first, last).map((rowIndex, n) => (
            <Row
              key={rowIndex}
              row={allRows[rowIndex]}
              rowIndex={rowIndex}
              displayIndex={first + n}
              columns={columns}
              widths={widths}
              isOpen={openRow === rowIndex}
              selected={selectedRows.has(rowIndex)}
              selectedColumn={
                selectedCell && selectedCell.row === rowIndex ? selectedCell.column : null
              }
              onOpenRow={onOpenRow}
              onCellDown={onCellDown}
              onRowEnter={onRowEnter}
            />
          ))}

          {padBottom > 0 && (
            <tr aria-hidden="true" style={{ height: padBottom }}>
              <td colSpan={columns.length + 2} style={gridStyles.spacerCell} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// ── JSON view ──────────────────────────────────────────────────────────────

// Cards are expensive enough that toggling one used to re-render all of them.
// Memoised, a toggle now costs exactly the card that changed.
const DocCard = React.memo(function DocCard({ doc, index, isOpen, onToggle }) {
  const id = doc._id || doc.id || `document ${index + 1}`;
  return (
    <div style={{
      margin: '0 12px 7px', borderRadius: 6, overflow: 'hidden',
      border: `1px solid ${isOpen ? C.aB : C.border}`,
      background: isOpen ? C.bg : C.surface,
    }}>
      <div
        onClick={() => onToggle(index)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer',
          background: isOpen ? C.aD : 'transparent',
          borderBottom: isOpen ? `1px solid ${C.border}` : 'none',
        }}
      >
        <span style={{ display: 'flex', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
          {Icon('caret', isOpen ? C.accent : C.dim, 11)}
        </span>
        <span style={{ fontSize: 9.5, fontFamily: MONO, fontWeight: 700, color: C.dim }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <span style={{
          fontSize: 11, fontFamily: MONO, fontWeight: 600,
          color: isOpen ? C.accent : C.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {typeof id === 'object' ? JSON.stringify(id) : String(id)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 10, fontFamily: MONO, color: C.dim,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {Object.keys(doc).filter((k) => k !== '_id').slice(0, 5).join(' · ')}
        </span>
        <button
          type="button"
          title="Copy document"
          onClick={(e) => {
            e.stopPropagation();
            try { navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); } catch (_) { /* clipboard denied */ }
          }}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex' }}
        >
          {Icon('copy', C.muted, 11)}
        </button>
      </div>
      {isOpen && (
        <pre style={{
          margin: 0, padding: '9px 14px 12px', overflowX: 'auto',
          fontFamily: MONO, fontSize: 11, lineHeight: 1.65, color: C.text,
        }}>
          {JSON.stringify(doc, null, 2)}
        </pre>
      )}
    </div>
  );
});

// Cards vary in height once expanded, so this pages rather than windows:
// render a chunk, and let the user ask for the next one. Same effect on the
// symptom — a thousand documents never hit the DOM at once.
const JSON_CHUNK = 150;

const JsonView = ({ result }) => {
  const [open, setOpen] = useState(() => new Set([0]));
  const [shown, setShown] = useState(JSON_CHUNK);
  const rows = result.rows || [];

  // A new result starts from the top again.
  useEffect(() => { setShown(JSON_CHUNK); setOpen(new Set([0])); }, [result]);

  const toggle = useCallback((i) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  }), []);

  const remaining = rows.length - shown;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: C.bg, minHeight: 0, padding: '8px 0 14px' }}>
      {rows.slice(0, shown).map((doc, i) => (
        <DocCard key={i} doc={doc} index={i} isOpen={open.has(i)} onToggle={toggle} />
      ))}

      {remaining > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 12px 2px' }}>
          <button
            type="button"
            onClick={() => setShown((n) => n + JSON_CHUNK)}
            style={{
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${C.border2}`, background: C.surface, color: C.text,
              fontFamily: MONO, fontSize: 10.5,
            }}
          >
            Show {Math.min(JSON_CHUNK, remaining)} more · {remaining} left
          </button>
        </div>
      )}
    </div>
  );
};

// ── row detail ─────────────────────────────────────────────────────────────

const RowDetail = ({ result, index, onClose }) => {
  const row = (result.rows || [])[index];
  if (!row) return null;
  return (
    <div style={{
      width: 300, flexShrink: 0, minHeight: 0,
      borderLeft: `1px solid ${C.border}`, background: C.bg,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
            color: C.muted, textTransform: 'uppercase',
          }}>
            Row detail
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>
            {index + 1} of {result.rows.length}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, display: 'flex' }}
        >
          {Icon('close', C.muted, 13)}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {result.columns.map((col) => {
          const value = row[col.name];
          return (
            <div key={col.name} style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontFamily: MONO, fontWeight: 700, color: C.muted }}>{col.name}</span>
                <span style={{ fontSize: 9, fontFamily: MONO, color: C.dim }}>{col.type}</span>
              </div>
              <div style={{
                fontSize: 12, fontFamily: MONO, color: C.text,
                wordBreak: 'break-word', lineHeight: 1.5,
              }}>
                {value === null || value === undefined
                  ? <em style={{ color: C.dim }}>NULL</em>
                  : formatCell(value, col)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── history ────────────────────────────────────────────────────────────────

const HistoryTab = ({ history, onLoad, onClear }) => (
  <div style={{ flex: 1, overflow: 'auto', background: C.bg, minHeight: 0 }}>
    {history.length === 0 ? (
      <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12, color: C.muted }}>
        Nothing has been run against this connection yet.
      </div>
    ) : (
      <>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '6px 14px',
          borderBottom: `1px solid ${C.border}`, background: C.surface,
        }}>
          <span style={{ flex: 1, fontSize: 9.5, fontFamily: MONO, color: C.dim, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {history.length} run{history.length === 1 ? '' : 's'} · click to load into the worksheet
          </span>
          <button
            type="button"
            onClick={onClear}
            style={{
              border: `1px solid ${C.border}`, background: C.bg, borderRadius: 4,
              padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontFamily: MONO, color: C.muted,
            }}
          >
            Clear
          </button>
        </div>
        {history.map((h) => (
          <div
            key={h.id}
            onClick={() => onLoad(h.sql)}
            style={{
              display: 'flex', gap: 10, padding: '9px 14px', alignItems: 'flex-start',
              borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.surface; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ marginTop: 3, flexShrink: 0, display: 'flex' }}>
              {h.ok ? Icon('check', C.green, 11) : Icon('alert', C.red, 11)}
            </span>
            <span style={{ fontSize: 10.5, fontFamily: MONO, color: C.dim, flexShrink: 0, width: 46, paddingTop: 1 }}>
              {h.ranAt ? new Date(h.ranAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) : ''}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 11.5, fontFamily: MONO, color: C.text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {h.summary || h.sql}
              </div>
              {h.error && (
                <div style={{ fontSize: 10.5, fontFamily: MONO, color: C.red, marginTop: 3 }}>{h.error}</div>
              )}
            </div>
            <span style={{
              fontSize: 10, fontFamily: MONO, flexShrink: 0, paddingTop: 1,
              color: h.ms > 1000 ? C.amber : C.muted,
            }}>
              {h.ms} ms
            </span>
          </div>
        ))}
      </>
    )}
  </div>
);

// ── shell ──────────────────────────────────────────────────────────────────

const ResultsPanel = ({
  result,
  error,
  running,
  history = [],
  tab,
  onTab,
  onLoadHistory,
  onClearHistory,
  isDocumentStore,
  minimized,
  onMinimize,
  dock = 'bottom',
  onDock,
}) => {
  const [openRow, setOpenRow] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [viewOverride, setViewOverride] = useState(null);
  const panelRef = useRef(null);

  // Result tabs. Runs land in the one unpinned tab — the live one — so the
  // strip stays a single "Results" until something is pinned. A pinned tab is
  // out of that rotation: with no live tab left, the next run opens a new tab
  // beside it and the pinned rows stay where they are. They hold whole row
  // sets, so pins live in memory for the session rather than being persisted.
  const [sheets, setSheets] = useState([]);
  const [activeSheetId, setActiveSheetId] = useState(null);

  // A fresh outcome from the parent replaces the live tab, or opens one, and is
  // brought to the front — you ran it, so you get to see it. A failure is an
  // outcome like any other and lands the same way: it has to, because with
  // everything pinned there is no live tab, and a message with nowhere to go
  // leaves the pinned rows on screen and the error unseen.
  //
  // This adjusts state during render off `prevRun`, rather than off a ref:
  // StrictMode renders twice, and everything here has to come out the same
  // both times or the second pass drops the tab the first one opened. So no
  // ref bumping, and the new tab's number is derived from the tabs on hand.
  const [prevRun, setPrevRun] = useState({ result: null, error: null });
  if (result !== prevRun.result || error !== prevRun.error) {
    setPrevRun({ result, error });
    // Starting a run clears the error before anything replaces it; only an
    // outcome claims a tab, so nothing moves in between.
    if (result || error) {
      if (openRow !== null) setOpenRow(null);
      if (selectedCell !== null) setSelectedCell(null);
      if (selectedRows.size) setSelectedRows(new Set());
      if (viewOverride !== null) setViewOverride(null);

      // One or the other: rows the statement returned, or why it returned none.
      const landed = { result: result || null, error: result ? null : error };
      const live = sheets.find((s) => !s.pinned);
      if (live) {
        setSheets(sheets.map((s) => (s === live ? { ...s, ...landed, rev: s.rev + 1 } : s)));
        setActiveSheetId(live.id);
      } else {
        const n = sheets.reduce((max, s) => Math.max(max, s.n), 0) + 1;
        setSheets([...sheets, { id: `r${n}`, n, rev: 0, pinned: false, ...landed }]);
        setActiveSheetId(`r${n}`);
      }
    }
  }

  // History opens from the sidebar and borrows this panel; it shows as a tab
  // only while it is open, so closing it returns to the results.
  const showHistory = tab === 'history';

  // Before the first run there is nothing to tab between, but the strip still
  // needs its Results tab to hang the empty state off.
  const sheetTabs = sheets.length
    ? sheets
    : [{ id: 'r0', n: 1, rev: 0, pinned: false, result: null, placeholder: true }];

  const activeSheet = sheets.find((s) => s.id === activeSheetId)
    || sheets[sheets.length - 1]
    || sheetTabs[0];

  const shown = activeSheet.result;
  const hasRows = Boolean(shown && shown.rows && shown.rows.length);
  const onPinnedTab = Boolean(activeSheet.pinned);

  // What is on screen belongs to the tab, not to the last run: a pinned tab
  // keeps its own rows or its own error while later runs go on elsewhere, and
  // the stats bar says what became of them.
  const shownError = activeSheet.error || null;
  const busy = running && !onPinnedTab;
  const failed = Boolean(shownError);

  const togglePin = (sheet) => {
    if (!sheet.pinned) {
      setSheets((prev) => prev.map((s) => (s.id === sheet.id ? { ...s, pinned: true } : s)));
      return;
    }
    // Unpinning releases the snapshot. With no live tab it goes back to taking
    // new results; otherwise it closes, since only one tab can be live.
    const live = sheets.find((s) => !s.pinned);
    if (!live) {
      setSheets((prev) => prev.map((s) => (s.id === sheet.id ? { ...s, pinned: false } : s)));
      return;
    }
    setSheets((prev) => prev.filter((s) => s.id !== sheet.id));
    if (activeSheet.id === sheet.id) setActiveSheetId(live.id);
  };

  // Nested values read far better as JSON than truncated in a cell.
  const autoView = useMemo(() => {
    if (!hasRows) return 'grid';
    if (isDocumentStore) return 'json';
    const sample = shown.rows[0];
    return Object.values(sample).some((v) => v && typeof v === 'object') ? 'json' : 'grid';
  }, [shown, hasRows, isDocumentStore]);

  const view = viewOverride || autoView;

  const exportAs = (format) => {
    if (!hasRows) return;
    if (format === 'CSV') {
      download('query-result.csv', toCsv(shown.columns, shown.rows), 'text/csv');
    } else {
      download('query-result.json', JSON.stringify(shown.rows, null, 2), 'application/json');
    }
  };

  // Copy the selected rows as TSV — the format that pastes into a spreadsheet
  // as cells. Scoped to this panel so it never steals Cmd-C from the editor,
  // and it replaces the browser's copy-the-text-selection that the grid gives
  // up by disabling text selection.
  useEffect(() => {
    if (!selectedRows.size) return undefined;
    const onCopy = (e) => {
      const host = panelRef.current;
      if (!host || !host.contains(document.activeElement || e.target)) return;
      const cols = shown.columns || [];
      const picked = (shown.rows || [])
        .map((row, i) => (selectedRows.has(i) ? row : null))
        .filter(Boolean);
      if (!picked.length) return;
      const cell = (v) => (v === null || v === undefined ? ''
        : typeof v === 'object' ? JSON.stringify(v) : String(v));
      const tsv = [
        cols.map((c) => c.name).join('\t'),
        ...picked.map((r) => cols.map((c) => cell(r[c.name])).join('\t')),
      ].join('\n');
      e.clipboardData.setData('text/plain', tsv);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [selectedRows, shown]);

  return (
    <div ref={panelRef} tabIndex={-1} style={{
      flex: minimized ? '0 0 auto' : '1 1 0', minHeight: 0, minWidth: 0,
      display: 'flex', flexDirection: 'column', outline: 'none',
      // The panel docks below the editor or beside it. The divider that resizes
      // it belongs to the parent, so only the closing border moves with it.
      ...(dock === 'right'
        ? { borderLeft: `1px solid ${C.border}` }
        : { borderTop: `1px solid ${C.border}` }),
      background: C.bg,
    }}>
      {/* tab strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, flexShrink: 0,
        padding: '0 7px 0 4px', background: C.surface, borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {sheetTabs.map((s) => {
            const on = !showHistory && activeSheet.id === s.id && !minimized;
            const label = s.n === 1 ? 'Results' : `Result ${s.n}`;
            const count = s.result && s.result.rows ? s.result.rows.length : null;
            return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', flexShrink: 0, marginBottom: -1,
                borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
                background: on ? C.bg : 'transparent',
              }}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSheetId(s.id);
                    if (showHistory) onTab('results');
                    if (minimized) onMinimize(false);
                  }}
                  title={s.error || (s.result && s.result.statement) || label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, height: 32,
                    padding: s.placeholder ? '0 11px' : '0 5px 0 11px',
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    fontFamily: SANS, fontSize: 11.5, fontWeight: on ? 600 : 500,
                    color: on ? C.accent : C.muted, whiteSpace: 'nowrap',
                  }}
                >
                  {Icon('grid', s.error ? C.red : on ? C.accent : C.dim, 12)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  {/* A failed tab wears its outcome, so a run that went wrong
                      behind a pinned one reads as such from the strip. */}
                  {s.error ? (
                    <span style={{
                      fontSize: 9, fontFamily: MONO, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                      letterSpacing: '0.04em', textTransform: 'uppercase',
                      color: C.red, background: C.redD, border: `1px solid ${C.redB}`,
                    }}>
                      error
                    </span>
                  ) : count != null && (
                    <span style={{
                      fontSize: 9, fontFamily: MONO, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                      color: on ? C.accent : C.dim,
                      background: on ? C.aD : C.s2,
                      border: `1px solid ${on ? C.aB : C.border}`,
                    }}>
                      {count}
                    </span>
                  )}
                </button>

                {/* Pin, on the tab it belongs to. Pinning keeps this tab's rows
                    and pushes the next run into a tab of its own. */}
                {!s.placeholder && (
                  <button
                    type="button"
                    title={s.pinned
                      ? (sheets.some((o) => !o.pinned)
                        ? 'Unpin — lets go of this result and closes the tab'
                        : 'Unpin — this tab takes the next run again')
                      : 'Pin this result — the next run opens a new tab'}
                    onClick={() => togglePin(s)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      padding: '0 8px 0 2px', height: 32, display: 'flex', alignItems: 'center',
                      opacity: s.pinned ? 1 : 0.45,
                    }}
                  >
                    {Icon('pin', s.pinned ? C.accent : C.dim, 11, s.pinned)}
                  </button>
                )}
              </div>
            );
          })}

          {showHistory && (
            <div style={{
              display: 'flex', alignItems: 'center', flexShrink: 0, marginBottom: -1,
              borderBottom: `2px solid ${minimized ? 'transparent' : C.accent}`,
              background: minimized ? 'transparent' : C.bg,
            }}>
              <button
                type="button"
                onClick={() => { if (minimized) onMinimize(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 4px 0 11px',
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: SANS, fontSize: 11.5, fontWeight: minimized ? 500 : 600,
                  color: minimized ? C.muted : C.accent, whiteSpace: 'nowrap',
                }}
              >
                {Icon('history', minimized ? C.dim : C.accent, 12)}
                History
              </button>
              <button
                type="button"
                title="Close"
                onClick={() => onTab('results')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: '0 7px 0 2px', height: 32, display: 'flex', alignItems: 'center',
                }}
              >
                {Icon('close', C.dim, 10)}
              </button>
            </div>
          )}
        </div>

        {hasRows && !minimized && (
          <div style={{
            display: 'flex', gap: 2, padding: 2, borderRadius: 5, flexShrink: 0,
            background: C.s2, border: `1px solid ${C.border}`,
          }}>
            {[['grid', 'Table'], ['json', 'JSON']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setViewOverride(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 3,
                  border: 'none', cursor: 'pointer',
                  fontSize: 9.5, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                  background: view === key ? C.bg : 'transparent',
                  color: view === key ? C.accent : C.muted,
                }}
              >
                {Icon(key === 'grid' ? 'grid' : 'json', view === key ? C.accent : C.muted, 10)}
                {label}
              </button>
            ))}
          </div>
        )}

        {typeof onDock === 'function' && (
          <button
            type="button"
            title={dock === 'right' ? 'Dock results to the bottom' : 'Dock results to the right'}
            onClick={() => onDock(dock === 'right' ? 'bottom' : 'right')}
            style={{
              width: 24, height: 24, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${C.border}`, background: C.bg, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {/* Two panes, filled on the side the results currently occupy. */}
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke={C.muted} />
              {dock === 'right'
                ? <rect x="7" y="1" width="4" height="10" fill={C.muted} />
                : <rect x="1" y="7" width="10" height="4" fill={C.muted} />}
            </svg>
          </button>
        )}

        <button
          type="button"
          title={minimized ? 'Expand results' : 'Minimize results'}
          onClick={() => onMinimize(!minimized)}
          style={{
            width: 24, height: 24, borderRadius: 5, flexShrink: 0,
            border: `1px solid ${C.border}`, background: C.bg, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {Icon(minimized ? 'up' : 'minus', C.muted, 12)}
        </button>
      </div>

      {!minimized && (
        <>
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {showHistory && (
              <HistoryTab history={history} onLoad={onLoadHistory} onClear={onClearHistory} />
            )}

            {!showHistory && (
              <>
                {busy && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: C.muted }}>
                    Running…
                  </div>
                )}

                {!busy && failed && (
                  <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                    <div style={{
                      padding: '12px 14px', borderRadius: 6,
                      background: C.redD, border: `1px solid ${C.redB}`,
                      fontFamily: MONO, fontSize: 12, color: C.red, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    }}>
                      {shownError}
                    </div>
                  </div>
                )}

                {!busy && !failed && !shown && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: C.muted }}>No results yet.</span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: C.dim }}>
                      ⌘↵ runs the selection, or the statement at the caret
                    </span>
                  </div>
                )}

                {!busy && !failed && shown && !hasRows && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: C.text }}>
                      {shown.message || 'Statement completed.'}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: C.dim }}>
                      {shown.rowCount != null ? `${shown.rowCount} row(s) affected · ` : ''}{shown.ms} ms
                    </span>
                  </div>
                )}

                {!busy && !failed && hasRows && view === 'grid' && (
                  <Grid
                    key={`${activeSheet.id}-${activeSheet.rev}`}
                    result={shown}
                    openRow={openRow}
                    onOpenRow={setOpenRow}
                    selectedCell={selectedCell}
                    onSelectCell={setSelectedCell}
                    selectedRows={selectedRows}
                    onSelectRows={setSelectedRows}
                  />
                )}
                {!busy && !failed && hasRows && view === 'json' && <JsonView key={`${activeSheet.id}-${activeSheet.rev}`} result={shown} />}
                {!busy && !failed && hasRows && view === 'grid' && openRow !== null && (
                  <RowDetail result={shown} index={openRow} onClose={() => setOpenRow(null)} />
                )}
              </>
            )}
          </div>

          {/* stats bar */}
          {!showHistory && shown && !failed && !busy && (
            <div style={{
              display: 'flex', alignItems: 'center', height: 30, padding: '0 10px', flexShrink: 0,
              borderTop: `1px solid ${C.border}`, background: C.surface, overflowX: 'auto',
            }}>
              {/* A capped read stops the engine early, so there is no true
                  total to report — say "first N" rather than implying N is all
                  there was. */}
              {[
                shown.truncated
                  ? `first ${(shown.rows || []).length} ${isDocumentStore ? 'docs' : 'rows'}`
                  : `${shown.rowCount != null ? shown.rowCount : (shown.rows || []).length} ${isDocumentStore ? 'docs' : 'rows'}`,
                `${shown.ms} ms`,
                shown.truncated
                  ? `capped at ${shown.rowCap || (shown.rows || []).length} — narrow the query for more`
                  : null,
                // A pinned tab shows none of what happens after it — say so
                // here, so a run failing behind it is never silent.
                onPinnedTab
                  ? (running ? 'pinned — a run is in progress'
                    : error ? 'pinned — the last run failed'
                      : 'pinned — later runs open a new tab')
                  : null,
                selectedRows.size
                  ? `${selectedRows.size} selected — ⌘C to copy`
                  : null,
              ].filter(Boolean).map((text, i) => (
                <span key={i} style={{
                  fontSize: 10.5, fontFamily: MONO, whiteSpace: 'nowrap',
                  color: text.startsWith('capped') ? C.amber
                    : text.includes('failed') ? C.red
                      : text.startsWith('pinned') ? C.accent
                        : text.includes('selected') ? C.accent
                          : i < 2 ? C.text : C.muted,
                  paddingRight: 10, marginRight: 10, borderRight: `1px solid ${C.border}`,
                }}>
                  {text}
                </span>
              ))}

              <span style={{
                flex: 1, minWidth: 12, fontSize: 10.5, fontFamily: MONO, color: C.dim,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {selectedCell
                  ? `${selectedCell.column} = ${formatCell(selectedCell.value, null) ?? 'NULL'}`
                  : 'click a cell to inspect · click a row number for detail'}
              </span>

              {selectedCell && (
                <button
                  type="button"
                  title="Copy cell"
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(String(formatCell(selectedCell.value, null) ?? ''));
                    } catch (_) { /* clipboard denied */ }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, marginRight: 6, flexShrink: 0,
                    padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}`,
                    background: C.bg, cursor: 'pointer', fontSize: 10, fontFamily: MONO, color: C.muted,
                  }}
                >
                  {Icon('copy', C.muted, 10)} Copy
                </button>
              )}

              {hasRows && ['CSV', 'JSON'].map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => exportAs(format)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4, flexShrink: 0,
                    padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}`,
                    background: C.bg, cursor: 'pointer',
                    fontSize: 10, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.05em', color: C.muted,
                  }}
                >
                  {Icon('download', C.muted, 10)} {format}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ResultsPanel;
