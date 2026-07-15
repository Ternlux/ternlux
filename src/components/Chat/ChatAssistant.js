import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { C, SANS, MONO, I, MoreMenu } from '../Workflows/_designShared';
import DataVisualization from './DataVisualization';

const MAX_STEPS_PER_QUESTION = 8;

// NeDB refuses any field whose key starts with `$` (it reserves them for
// update operators). Tool results occasionally include such keys — Mongo
// Extended JSON markers like `$oid` / `$date` are the usual offenders, but
// it can be anything a connector hands back. Rewrite `$foo` to `_$foo`
// recursively before persisting so the chat history can always be saved.
// We keep the original key inside the new name so it's recoverable on
// inspection.
function sanitizeForNedb(value) {
  if (Array.isArray(value)) return value.map(sanitizeForNedb);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const safeKey = (typeof k === 'string' && k.startsWith('$')) ? `_${k}` : k;
      out[safeKey] = sanitizeForNedb(v);
    }
    return out;
  }
  return value;
}

// Concrete default suggestions — phrased so the agent has enough to act on
// without the user having to think. Each one names a real surface in the app.
const SUGGESTIONS_EMPTY = [
  { title: 'List my workflows',          sub: 'Names, types, and node counts' },
  { title: 'List my saved connections',  sub: 'Grouped by database / file / API' },
  { title: 'Show my last 5 executions',  sub: 'Status, trigger, and duration' },
  { title: 'Why did my last run fail?',  sub: 'Inspect the latest failed execution' },
];

const KIND_LABEL = { workflow: 'Workflow', connection: 'Connection', execution: 'Execution' };

const nowTs = () => new Date().toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
const newConvoId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const newMsgId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const blankConvo = () => {
  const now = Date.now();
  return {
    id: newConvoId(),
    title: 'New chat',
    messages: [],
    agentMode: 'main',
    workflowSession: null,
    pendingBuild: null,
    activeSkill: null,
    createdAt: now,
    updatedAt: now,
  };
};

// Pick the first 7-or-so words of the user's first message to title the chat.
const titleFromMessage = (text) => {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'New chat';
  const words = t.split(' ').slice(0, 8).join(' ');
  return words.length < t.length ? `${words}…` : words;
};

// ── Windows-style maximize / restore icons ─────────────────────────────────
const IconMaximize = ({ color = C.muted, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="9" height="9" />
  </svg>
);
const IconRestore = ({ color = C.muted, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4">
    <rect x="3" y="3" width="7" height="7" />
    <path d="M3 5 V2 H10 V9 H7" />
  </svg>
);

// ── Lightweight markdown (fenced code, ## headers, bold + `code`) ──────────
const MdInline = ({ line }) => (
  <>
    {line.split(/(\*\*.*?\*\*|`[^`]*`)/g).map((p, i) => {
      if (p.startsWith('**') && p.endsWith('**') && p.length >= 4)
        return <strong key={i} style={{ fontWeight: 700 }}>{p.slice(2, -2)}</strong>;
      if (p.startsWith('`') && p.endsWith('`') && p.length >= 2)
        return (
          <code key={i} style={{
            fontFamily: MONO, fontSize: 11, background: C.s2,
            padding: '1px 5px', borderRadius: 3, border: `1px solid ${C.border}`,
          }}>{p.slice(1, -1)}</code>
        );
      return <span key={i}>{p}</span>;
    })}
  </>
);

const MdProse = ({ text, first }) => {
  const blocks = String(text).replace(/^\n+|\n+$/g, '').split(/\n\n+/).filter(Boolean);
  return blocks.map((block, bi) => (
    <div key={bi} style={{ marginTop: bi === 0 && first ? 0 : 8 }}>
      {block.split('\n').map((line, li) => {
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          return (
            <div key={li} style={{
              fontWeight: 700, fontSize: h[1].length <= 2 ? 13 : 12,
              marginTop: li === 0 ? 0 : 6,
            }}>
              <MdInline line={h[2]} />
            </div>
          );
        }
        return <div key={li}><MdInline line={line} /></div>;
      })}
    </div>
  ));
};

const Markdown = ({ text }) => {
  if (!text) return null;
  // Pull fenced ```lang blocks out FIRST so their content is rendered
  // verbatim in a <pre> and never hits the inline bold/backtick rules.
  // split with one capture group alternates [prose, code, prose, code, …].
  const parts = String(text).split(/```[^\n`]*\n?([\s\S]*?)```/g);
  return parts.map((part, pi) => {
    if (pi % 2 === 1) {
      return (
        <pre key={pi} style={{
          margin: '8px 0', padding: '8px 10px',
          background: C.s2, border: `1px solid ${C.border}`, borderRadius: 4,
          fontFamily: MONO, fontSize: 11, color: C.text,
          overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{part.replace(/\n$/, '')}</pre>
      );
    }
    if (!part.trim()) return null;
    return <MdProse key={pi} text={part} first={pi === 0} />;
  });
};

// Workflow plans no longer ride inside finalAnswer as a fenced markdown
// block. The backend's `chat:step` IPC sets `workflowPlan` as a top-level
// field on its response; the renderer attaches it directly to the
// finalAnswer message so PlanCard can render it.

const STEP_BADGE = {
  start:       { label: 'START',      color: '#0f766e', bg: '#ccfbf1' },
  dataSource:  { label: 'DATA SRC',   color: '#1e40af', bg: '#dbeafe' },
  transformer: { label: 'TRANSFORM',  color: '#7c2d12', bg: '#fed7aa' },
  join:        { label: 'JOIN',       color: '#6b21a8', bg: '#e9d5ff' },
  output:      { label: 'OUTPUT',     color: '#166534', bg: '#bbf7d0' },
};

// ── Workflow plan card — shown when an assistant message carries a
// `workflowPlan` field (set by the backend's short-circuited propose_plan
// turn). The Accept button calls the executor IPC directly
// (workflow:executeBuild), bypassing the AI; the Cancel button just locks
// the card. Once the user has either accepted or cancelled, the buttons
// are replaced with a status line so they cannot fire twice.
const PlanCard = ({ plan, status, onAccept, onCancel }) => {
  const settled = status && status.kind !== 'idle';
  return (
    <div style={{
      marginTop: 10, padding: 12, borderRadius: 6,
      border: `1px solid ${C.border}`, background: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
          color: C.dim, textTransform: 'uppercase',
        }}>Build plan</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
          {plan.mode === 'modify' ? 'Modify workflow' : plan.name || 'New workflow'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>
          {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
        </span>
      </div>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {plan.steps.map((raw, i) => {
          // Each step entry is either a string (id of an existing node to
          // keep as-is) or an object (modify when it has existingNodeId,
          // add otherwise). Normalize before rendering.
          const isShorthand = typeof raw === 'string';
          const stepType = isShorthand ? null : raw.stepType;
          const badge = stepType
            ? (STEP_BADGE[stepType] || { label: String(stepType).toUpperCase(), color: C.muted, bg: C.s2 })
            : { label: 'KEEP', color: C.muted, bg: C.s2 };
          const titleSuffix = isShorthand
            ? `Keep ${raw}`
            : (raw.existingNodeId ? `Modify ${raw.existingNodeId}` : (raw.label || stepType));
          const sources = !isShorthand && Array.isArray(raw.sources) ? raw.sources : null;
          const prompt = isShorthand ? null : (raw.prompt || '');
          return (
            <li key={i} style={{
              padding: '8px 10px', borderRadius: 4,
              border: `1px solid ${C.border}`, background: C.bg,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: prompt ? 4 : 0 }}>
                <span style={{
                  fontSize: 8, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
                  padding: '2px 6px', borderRadius: 3,
                  color: badge.color, background: badge.bg,
                }}>{badge.label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
                  {i + 1}. {titleSuffix}
                </span>
                {sources && sources.length > 0 && (
                  <span style={{ fontSize: 9, fontFamily: MONO, color: C.muted }}>
                    ← {sources.map(String).join(', ')}
                  </span>
                )}
              </div>
              {prompt && (
                <div style={{ fontSize: 11, lineHeight: 1.5, color: C.muted, whiteSpace: 'pre-wrap' }}>
                  {prompt}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {plan.mode === 'modify' && Array.isArray(plan.deletedNodes) && plan.deletedNodes.length > 0 && (
        <div style={{
          marginTop: 8, padding: '6px 10px', borderRadius: 4,
          fontSize: 10, fontFamily: MONO, color: C.red,
          background: C.rD, border: '1px solid #fecaca',
        }}>
          Deletes: {plan.deletedNodes.join(', ')}
        </div>
      )}
      {settled ? (
        <div style={{
          marginTop: 10, padding: '6px 10px', borderRadius: 4,
          fontSize: 11, fontFamily: SANS, fontWeight: 600,
          background: status.kind === 'error' ? C.rD : (status.kind === 'success' ? C.gD : C.s2),
          color:      status.kind === 'error' ? C.red : (status.kind === 'success' ? C.green : C.muted),
          border: `1px solid ${status.kind === 'error' ? '#fecaca' : status.kind === 'success' ? '#bbf7d0' : C.border}`,
        }}>
          {status.message}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={status?.kind === 'running'}
            style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 600,
              borderRadius: 4, border: `1px solid ${C.border}`, background: '#fff',
              color: C.muted, cursor: status?.kind === 'running' ? 'default' : 'pointer',
              fontFamily: SANS, opacity: status?.kind === 'running' ? 0.6 : 1,
            }}>
            Cancel
          </button>
          <button type="button" onClick={onAccept} disabled={status?.kind === 'running'}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 600,
              borderRadius: 4, border: 'none', background: C.accent,
              color: '#fff', cursor: status?.kind === 'running' ? 'default' : 'pointer',
              fontFamily: SANS, opacity: status?.kind === 'running' ? 0.7 : 1,
            }}>
            {status?.kind === 'running' ? 'Building…' : 'Accept plan'}
          </button>
        </div>
      )}
    </div>
  );
};

// ── Active-context chip ────────────────────────────────────────────────────
const ContextChip = ({ ctx, onClear }) => {
  if (!ctx || !ctx.kind) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px 4px 9px', borderRadius: 4,
      background: C.aD, border: '1px solid #bfdbfe',
      fontSize: 11, color: C.accent, fontFamily: SANS,
    }}>
      <span style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: C.accent,
      }}>{KIND_LABEL[ctx.kind] || ctx.kind}</span>
      <span style={{ fontWeight: 600, color: C.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ctx.name || ctx.id || 'unknown'}
      </span>
      {onClear && (
        <button type="button" onClick={onClear} aria-label="Clear context"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', color: C.muted }}>
          {I('x', C.muted, 11)}
        </button>
      )}
    </div>
  );
};

// ── Step bubble — streamed "thought + tool calls" turn ────────────────────
const StepBubble = ({ m }) => (
  <div style={{ display: 'flex', gap: 10 }}>
    <div style={{
      width: 26, height: 26, borderRadius: 4, flexShrink: 0,
      background: C.s2, border: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
    }}>
      {I('compass', C.muted, 12)}
    </div>
    <div style={{ maxWidth: '90%', minWidth: 80 }}>
      <div style={{
        padding: '8px 11px', borderRadius: 6, borderTopLeftRadius: 2,
        background: C.surface, border: `1px solid ${C.border}`,
        fontSize: 11, color: C.muted, lineHeight: 1.6,
      }}>
        <div style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
          color: C.dim, textTransform: 'uppercase', marginBottom: 4,
        }}>
          Step {m.stepIndex}
        </div>
        {m.thought && (
          <div style={{ color: C.text, fontSize: 12, marginBottom: m.actions?.length ? 6 : 0 }}>
            {m.thought}
          </div>
        )}
        {Array.isArray(m.actions) && m.actions.map((a, i) => (
          <ActionLine key={i} action={a} />
        ))}
      </div>
      <div style={{ marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
    </div>
  </div>
);

// ── Build log — a live, compact list of build steps (NOT chat bubbles). ───
// Each line flips from a spinner to a ✓ as the main process streams progress.
const BUILD_STEP_LABEL = {
  start: 'Start', dataSource: 'Data source', transformer: 'Transformer',
  join: 'Join', output: 'Output', branch: 'Branch',
};
const BuildLogBubble = ({ m }) => {
  const logs = Array.isArray(m.logs) ? m.logs : [];
  const done = !!m.done;
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <div style={{
        width: 26, height: 26, borderRadius: 4, flexShrink: 0,
        background: C.s2, border: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
      }}>
        {I('compass', C.muted, 12)}
      </div>
      <div style={{ maxWidth: '90%', minWidth: 200 }}>
        <div style={{
          padding: '8px 11px', borderRadius: 6, borderTopLeftRadius: 2,
          background: C.surface, border: `1px solid ${C.border}`,
        }}>
          <div style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
            color: C.dim, textTransform: 'uppercase', marginBottom: 6,
          }}>
            {done ? (m.summary ? 'Build log' : 'Build paused') : 'Building…'}
          </div>
          {logs.length === 0 && (
            <div style={{ fontSize: 11, color: C.dim, fontFamily: SANS }}>Preparing…</div>
          )}
          {logs.map((l) => {
            const isDone = l.status === 'done';
            return (
              <div key={l.stepIndex} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0',
                fontSize: 11, fontFamily: SANS, color: isDone ? C.text : C.muted,
              }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 13, height: 13, borderRadius: 2, flexShrink: 0,
                  background: isDone ? C.gD : C.s2,
                  color: isDone ? C.green : C.dim, fontSize: 9, fontWeight: 700,
                }}>{isDone ? '✓' : '·'}</span>
                <span style={{ fontWeight: 600 }}>{BUILD_STEP_LABEL[l.stepType] || l.stepType}</span>
                {l.label && l.label !== (BUILD_STEP_LABEL[l.stepType] || l.stepType) && (
                  <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    — {l.label}
                  </span>
                )}
                {!isDone && (
                  <span style={{ color: C.dim, fontSize: 10, fontStyle: 'italic' }}>working…</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
      </div>
    </div>
  );
};

const ActionLine = ({ action }) => {
  const [open, setOpen] = useState(false);
  const ok = action.ok;
  const argsStr = (() => {
    try {
      const s = JSON.stringify(action.args || {});
      return s.length > 80 ? s.slice(0, 78) + '…' : s;
    } catch { return ''; }
  })();
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 0, color: ok ? C.accent : C.red,
          fontFamily: MONO, fontSize: 11, fontWeight: 600,
        }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 12, height: 12, borderRadius: 2,
          background: ok ? C.gD : C.rD,
          color: ok ? C.green : C.red, fontSize: 9,
        }}>{ok ? '✓' : '✗'}</span>
        <span style={{ color: C.text }}>{action.tool}</span>
        <span style={{ color: C.dim, fontWeight: 400 }}>{argsStr}</span>
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 0 18px', padding: '6px 8px',
          background: '#fff', border: `1px solid ${C.border}`, borderRadius: 4,
          fontFamily: MONO, fontSize: 10, color: C.muted,
          maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {(() => {
            // Full call args first (the header line truncates them), then the
            // full error or the (capped) result.
            let fullArgs = '';
            try { fullArgs = JSON.stringify(action.args || {}, null, 2); } catch { fullArgs = ''; }
            const body = action.error
              ? `ERROR: ${action.error}`
              : (typeof action.result === 'string'
                  ? action.result
                  : JSON.stringify(action.result, null, 2)).slice(0, 4000);
            return `ARGS:\n${fullArgs}\n\n${body}`;
          })()}
        </pre>
      )}
    </div>
  );
};

// Reload arrow used for the Retry action under bot bubbles.
const ReloadIcon = ({ color = C.muted, size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

// ── Inline action button shown below user/bot bubbles (edit / retry) ─────
// `icon` accepts either a string name (looked up in the shared icon set)
// or a React element so callers can pass a custom svg like ReloadIcon.
const InlineAction = ({ icon, label, onClick, color = C.muted, disabled = false }) => {
  const iconEl = typeof icon === 'string' ? I(icon, disabled ? C.dim : color, 11) : icon;
  return (
    <button type="button" onClick={onClick} title={label} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 6px', borderRadius: 4,
        background: 'transparent', border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 10, fontFamily: SANS, color: disabled ? C.dim : color,
      }}
      onMouseOver={(e) => { if (!disabled) e.currentTarget.style.background = C.s2; }}
      onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent'; }}>
      {iconEl} {label}
    </button>
  );
};

// ── Tabbed, collapsible visuals panel ──────────────────────────────────────
// Mirrors design/Chat Visual Sample.html. A bot message's visuals are folded
// into ONE collapsible panel pinned at the bottom of the bubble, with a tab
// per visual, instead of stacked inline boxes. The chart body reuses
// DataVisualization in `bare` mode — the panel supplies the framing, the
// uppercase title, and the footer.
const vizTabLabel = (v, i) => {
  const t = (v && typeof v.title === 'string') ? v.title.trim() : '';
  if (t) return t.length > 22 ? `${t.slice(0, 21)}…` : t;
  const byType = {
    bar: 'Bar', line: 'Line', pie: 'Pie', table: 'Table',
    box: 'Metric', scatter: 'Scatter', kpi: 'Overview',
  };
  return byType[v?.type] || `View ${i + 1}`;
};

const VisualsPanel = ({ visuals }) => {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState(0);
  if (!Array.isArray(visuals) || visuals.length === 0) return null;
  // Guard the active index against a visuals array that shrank between renders.
  const idx = Math.min(tab, visuals.length - 1);
  const active = visuals[idx];

  return (
    <div style={{
      marginTop: 10, background: '#fff', border: `1px solid ${C.border}`,
      borderRadius: 6, overflow: 'hidden',
    }}>
      {/* Header — click to collapse / expand the whole panel */}
      <div onClick={() => setOpen((o) => !o)}
        style={{
          padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', userSelect: 'none',
          background: open ? '#fff' : C.surface,
          borderBottom: open ? `1px solid ${C.border}` : 'none',
        }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Visualizations</span>
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, color: C.accent,
          background: C.aD, border: '1px solid #bfdbfe', padding: '1px 6px', borderRadius: 10,
        }}>{visuals.length}</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
          color: C.muted, textTransform: 'uppercase',
        }}>
          {open ? 'Collapse' : `Show ${visuals.length} view${visuals.length === 1 ? '' : 's'}`}
        </span>
        <span style={{
          display: 'flex', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
        }}>
          {I('chevron', C.muted, 14)}
        </span>
      </div>

      {open && (
        <>
          {/* Tab strip — text labels only, one tab per visual */}
          {visuals.length > 1 && (
            <div style={{
              display: 'flex', borderBottom: `1px solid ${C.border}`,
              overflowX: 'auto', background: C.surface, paddingLeft: 4,
            }}>
              {visuals.map((v, i) => {
                const on = i === idx;
                return (
                  <button key={i} type="button" onClick={() => setTab(i)}
                    style={{
                      padding: '9px 14px', border: 'none',
                      background: on ? '#fff' : 'transparent', cursor: 'pointer',
                      borderBottom: on ? `2px solid ${C.accent}` : '2px solid transparent',
                      marginBottom: -1, color: on ? C.accent : C.muted,
                      fontWeight: on ? 700 : 500, fontSize: 11, fontFamily: SANS, whiteSpace: 'nowrap',
                    }}>
                    {vizTabLabel(v, i)}
                  </button>
                );
              })}
            </div>
          )}

          {/* Active visual — fixed height, scrolls when the visual is taller */}
          <div style={{ height: 380, overflowY: 'auto', padding: '12px 14px' }}>
            {active.title && (
              <div style={{
                fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
                color: C.muted, textTransform: 'uppercase', marginBottom: 10,
              }}>{active.title}</div>
            )}
            <DataVisualization visualizationData={active} onSaveToMain={null} hideMenu bare compact />
          </div>

          {/* Footer */}
          <div style={{
            padding: '8px 14px', borderTop: `1px solid ${C.border}`, background: C.surface,
            fontSize: 9, fontFamily: MONO, color: C.dim, letterSpacing: '0.04em',
          }}>
            View {idx + 1} of {visuals.length} · {active.type}
          </div>
        </>
      )}
    </div>
  );
};

// ── Chat bubble — user + final assistant + error ──────────────────────────
// `isEditing` flips the user bubble into an inline editor (ChatGPT-style):
// the message body becomes a textarea with Save/Cancel. Saving truncates
// the conversation from this point and re-sends the edited text via the
// parent's onSaveEdit handler; Cancel just discards the draft.
const Bubble = ({ m, onAction, onEdit, onRetry, isEditing, onSaveEdit, onCancelEdit, busy = false }) => {
  const isUser = m.role === 'user';
  const plan = !isUser && !m.error && m.workflowPlan && Array.isArray(m.workflowPlan.steps)
    ? m.workflowPlan
    : null;
  const bodyText = m.text;
  const canEdit  = isUser && typeof onEdit === 'function';
  const canRetry = !isUser && !m.error && m.kind === 'final' && typeof onRetry === 'function';

  // Local draft state — lives in the bubble so cancelling restores the
  // original text without touching parent state. Hooks must run on every
  // render path (rules-of-hooks), so they're declared BEFORE any early
  // return like the step-bubble passthrough below.
  const [draft, setDraft] = useState(bodyText || '');
  useEffect(() => { if (isEditing) setDraft(bodyText || ''); }, [isEditing, bodyText]);

  if (m.kind === 'step') return <StepBubble m={m} />;
  if (m.kind === 'buildLog') return <BuildLogBubble m={m} />;

  if (isUser && isEditing) {
    const saveDisabled = !draft.trim() || busy;
    return (
      <div style={{ display: 'flex', gap: 10, flexDirection: 'row-reverse' }}>
        <div style={{
          width: 26, height: 26, borderRadius: 4, flexShrink: 0,
          background: C.aD, border: '1px solid #bfdbfe',
          display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
        }}>
          {I('user', C.accent, 12)}
        </div>
        <div style={{ maxWidth: '82%', minWidth: 240, width: '82%' }}>
          <div style={{
            padding: '8px 10px', borderRadius: 6,
            border: `1px solid ${C.border2}`, background: '#fff',
          }}>
            <textarea
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!saveDisabled) onSaveEdit(m.id, draft);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancelEdit?.();
                }
              }}
              rows={Math.max(2, Math.min(8, (draft.match(/\n/g) || []).length + 2))}
              style={{
                width: '100%', border: 'none', outline: 'none', resize: 'vertical',
                fontFamily: SANS, fontSize: 12, lineHeight: 1.6, color: C.text,
                background: 'transparent', padding: 0,
              }}
            />
            <div style={{
              display: 'flex', gap: 6, justifyContent: 'flex-end',
              marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`,
            }}>
              <button type="button" onClick={onCancelEdit}
                style={{
                  padding: '4px 10px', borderRadius: 4,
                  border: `1px solid ${C.border}`, background: '#fff',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  color: C.muted, fontFamily: SANS,
                }}>Cancel</button>
              <button type="button" onClick={() => onSaveEdit(m.id, draft)}
                disabled={saveDisabled}
                style={{
                  padding: '4px 12px', borderRadius: 4, border: 'none',
                  background: saveDisabled ? C.s2 : C.accent,
                  cursor: saveDisabled ? 'default' : 'pointer',
                  fontSize: 11, fontWeight: 600,
                  color: saveDisabled ? C.dim : '#fff', fontFamily: SANS,
                }}>Save & submit</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, flexDirection: isUser ? 'row-reverse' : 'row' }}>
      <div style={{
        width: 26, height: 26, borderRadius: 4, flexShrink: 0, marginBottom: 3,
        background: isUser ? C.aD : C.s2,
        border: `1px solid ${isUser ? '#bfdbfe' : C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
      }}>
        {I(isUser ? 'user' : 'compass', isUser ? C.accent : C.muted, 12)}
      </div>
      <div style={{ maxWidth: '82%', minWidth: 80 }}>
        <div style={{
          padding: '10px 13px', borderRadius: 6,
          background: isUser ? C.accent : C.bg,
          border: isUser ? 'none' : `1px solid ${C.border}`,
          color: isUser ? '#fff' : C.text,
          borderTopLeftRadius:  isUser ? 6 : 2,
          borderTopRightRadius: isUser ? 2 : 6,
          fontSize: 12, lineHeight: 1.65, wordBreak: 'break-word',
          boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          {m.error
            ? <span style={{ color: C.red }}>{m.text}</span>
            : <Markdown text={bodyText} />}
          {plan && (
            <PlanCard
              plan={plan}
              status={m.planStatus || { kind: 'idle' }}
              onAccept={() => onAction && onAction('accept-plan', plan, m.id)}
              onCancel={() => onAction && onAction('cancel-plan', plan, m.id)}
            />
          )}
          {!isUser && !m.error && Array.isArray(m.visuals) && m.visuals.length > 0 && (
            <VisualsPanel visuals={m.visuals} />
          )}
        </div>
        <div style={{
          marginTop: 4, display: 'flex',
          alignItems: 'center', gap: 4,
          flexDirection: isUser ? 'row-reverse' : 'row',
        }}>
          <div style={{ fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
          {canEdit && (
            <InlineAction icon="edit" label="Edit"
              onClick={() => onEdit(m.id)}
              disabled={busy} />
          )}
          {canRetry && (
            <InlineAction icon={<ReloadIcon color={busy ? C.dim : C.muted} />} label="Retry"
              onClick={() => onRetry(m.id)}
              disabled={busy} />
          )}
        </div>
      </div>
    </div>
  );
};

// ── Typing indicator ───────────────────────────────────────────────────────
const Typing = ({ stage }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
    <div style={{
      width: 26, height: 26, borderRadius: 4, background: C.s2,
      border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{I('compass', C.muted, 12)}</div>
    <div style={{
      padding: '10px 14px', background: C.bg, border: `1px solid ${C.border}`,
      borderRadius: '6px 6px 6px 2px', display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11, color: C.muted, fontFamily: SANS,
    }}>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        {[0, 1, 2].map((n) => (
          <span key={n} style={{
            width: 5, height: 5, borderRadius: '50%', background: C.dim,
            animation: 'dgblink 1.4s ease infinite',
            animationDelay: `${n * 0.2}s`,
          }} />
        ))}
      </span>
      {stage}
    </div>
    <style>{`@keyframes dgblink { 0%,80%,100% { opacity: 0.3 } 40% { opacity: 1 } }`}</style>
  </div>
);

// ── Suggestion grid (empty state) ──────────────────────────────────────────
const SugGrid = ({ onPick }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, width: '100%', maxWidth: 480 }}>
    {SUGGESTIONS_EMPTY.map((s) => (
      <button key={s.title} type="button" onClick={() => onPick(s.title)}
        style={{
          textAlign: 'left', padding: '10px 12px', borderRadius: 6,
          border: `1px solid ${C.border}`, background: '#fff',
          cursor: 'pointer', fontFamily: SANS,
        }}
        onMouseOver={(e) => { e.currentTarget.style.background = C.aD; e.currentTarget.style.borderColor = '#bfdbfe'; }}
        onMouseOut={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = C.border; }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 2, letterSpacing: '-0.01em' }}>{s.title}</div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>{s.sub}</div>
      </button>
    ))}
  </div>
);

// ── Composer ───────────────────────────────────────────────────────────────
const Composer = ({ value, setValue, onSend, onCancel, busy }) => {
  const sendDisabled = busy || !value.trim();
  return (
    <div style={{ padding: '12px 14px', borderTop: `1px solid ${C.border}`, background: C.bg, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{
          flex: 1, position: 'relative', background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: 6,
        }}>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendDisabled) onSend(); }
            }}
            placeholder="Ask about workflows, connections, or your data…"
            rows={2}
            disabled={busy}
            style={{
              width: '100%', border: 'none', padding: '10px 12px',
              fontSize: 12, fontFamily: SANS, color: C.text,
              resize: 'none', outline: 'none', lineHeight: 1.6,
              background: 'transparent', display: 'block',
            }}
          />
        </div>
        {busy ? (
          <button type="button" onClick={onCancel} title="Stop the assistant"
            style={{
              width: 38, height: 38, borderRadius: 5, background: C.red,
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
            {/* stop square */}
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2" y="2" width="8" height="8" rx="1" fill="#fff" />
            </svg>
          </button>
        ) : (
          <button type="button" onClick={onSend} disabled={sendDisabled} title="Send (Enter)"
            style={{
              width: 38, height: 38, borderRadius: 5,
              background: sendDisabled ? C.s2 : C.accent,
              border: 'none', cursor: sendDisabled ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 0.15s',
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke={sendDisabled ? C.dim : '#fff'} strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

// ── Conversation history sidebar (expanded mode only) ──────────────────────
// Each row carries a 3-dots menu (Delete / Export). Export downloads the
// conversation as a JSON file; Delete removes it from both in-memory state
// and the chatSessions NeDB collection via the parent's callbacks.
const HistorySidebar = ({ conversations, activeId, onSelect, onNewChat, onDeleteConvo, onExportConvo }) => {
  // Newest first.
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [conversations],
  );
  return (
    <div style={{
      width: 260, borderRight: `1px solid ${C.border}`, background: C.bg,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${C.border}` }}>
        <button type="button" onClick={onNewChat}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 10px', borderRadius: 5,
            background: C.accent, border: `1px solid ${C.accent}`, cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: '#fff', fontFamily: SANS,
          }}>
          {I('plus', '#fff', 12)} New chat
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
        <div style={{
          padding: '4px 8px 6px', fontSize: 9, fontFamily: MONO, fontWeight: 700,
          letterSpacing: '0.1em', color: C.dim, textTransform: 'uppercase',
        }}>
          History · {sorted.length}
        </div>
        {sorted.map((c) => {
          const isActive = c.id === activeId;
          const last = c.messages[c.messages.length - 1];
          const preview = last?.text?.slice(0, 80) || 'No messages yet';
          return (
            <div key={c.id} onClick={() => onSelect(c.id)}
              style={{
                padding: '9px 10px', borderRadius: 5, cursor: 'pointer', marginBottom: 1,
                background: isActive ? C.aD : 'transparent',
                border: `1px solid ${isActive ? '#bfdbfe' : 'transparent'}`,
                transition: 'all 0.12s',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              onMouseOver={(e) => { if (!isActive) e.currentTarget.style.background = C.surface; }}
              onMouseOut={(e)  => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: C.text, letterSpacing: '-0.01em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {c.title}
                </div>
                <div style={{
                  fontSize: 10, color: C.muted, marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {preview}
                </div>
              </div>
              <MoreMenu items={[
                { label: 'Export Chat', icon: 'edit', onClick: () => onExportConvo?.(c.id) },
                { label: 'Delete',      icon: 'trash', danger: true, onClick: () => onDeleteConvo?.(c.id) },
              ]} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────
const ChatAssistant = ({ activeContext: incomingContext = null, onWorkflowBuilt = null, hidden = false }) => {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState('Thinking…');
  const [pinnedContext, setPinnedContext] = useState(null);

  // Multi-conversation state. New chat starts fresh; switching conversations
  // swaps in their messages. History sidebar (expanded mode) lists them all.
  // The initial in-memory list is replaced by whatever load-on-mount finds
  // in the `chatSessions` NeDB collection (see useEffect below).
  const [conversations, setConversations] = useState(() => [blankConvo()]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  // Which user message (if any) is currently being edited inline.
  const [editingMsgId, setEditingMsgId] = useState(null);
  // Conversation ids whose view has been "soft restarted" — the messages
  // array on disk is unchanged, but we show an empty chat. Switching away
  // or closing the panel drops the override; sending a new message commits
  // it by wiping the stored conversation. See `restartChat` and `send`.
  const [restartedConvoIds, setRestartedConvoIds] = useState(() => new Set());
  // Track which conversation ids have been seeded from disk so the
  // save-on-change effect doesn't overwrite real history with placeholder
  // state during the initial render.
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const activeConvo = useMemo(
    () => conversations.find((c) => c.id === activeId) || conversations[0],
    [conversations, activeId],
  );
  const isRestarted = restartedConvoIds.has(activeId);
  const messages = (isRestarted ? [] : activeConvo?.messages) || [];

  const scrollRef = useRef(null);
  // Cancel flag — set when the user clicks Stop. Checked between steps;
  // cancellation just means "do not issue the next chat:step call". The
  // currently in-flight call still completes, but its result is discarded.
  const cancelledRef = useRef(false);
  // Id of the in-flight build's "build log" message, so progress events
  // streamed from the main process know which message to append to. Null when
  // no build is running.
  const buildLogRef = useRef(null);

  const effectiveContext = useMemo(() => {
    if (pinnedContext === 'cleared') return null;
    return pinnedContext || incomingContext;
  }, [pinnedContext, incomingContext]);

  useEffect(() => { setPinnedContext(null); }, [incomingContext?.kind, incomingContext?.id]);

  // Drop edit-mode and any soft-restart override whenever the user switches
  // conversations so the textarea doesn't follow them to a different chat
  // and a previously-restarted view reverts to its stored messages.
  useEffect(() => {
    setEditingMsgId(null);
    setRestartedConvoIds(new Set());
  }, [activeId]);

  // Closing the panel also discards the soft-restart override so reopening
  // shows the persisted conversation, not a transient empty view.
  useEffect(() => {
    if (!open) {
      setRestartedConvoIds(new Set());
      setEditingMsgId(null);
    }
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open, expanded, activeId]);

  // ── Persistence: chatSessions NeDB collection ──────────────────────────
  // Conversations live in the same kind of NeDB store as workflows/connections.
  // On mount we load everything (newest first); on subsequent state changes a
  // debounced upsert writes each conversation back so refreshes don't lose
  // history. Each row's _id is the in-memory conversation id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.electronAPI?.db?.find) {
        hydratedRef.current = true;
        return;
      }
      try {
        const rows = await window.electronAPI.db.find(
          'chatSessions', {}, { updatedAt: -1 }, 0, 0,
        );
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length > 0) {
          const restored = rows.map((r) => ({
            id: r.id || r._id,
            title: r.title || 'New chat',
            messages: Array.isArray(r.messages)
              ? r.messages.map((mm) => (mm && mm.id ? mm : { ...mm, id: newMsgId() }))
              : [],
            agentMode: r.agentMode || 'main',
            workflowSession: r.workflowSession || null,
            pendingBuild: r.pendingBuild || null,
            activeSkill: r.activeSkill || null,
            updatedAt: r.updatedAt || Date.now(),
            createdAt: r.createdAt || Date.now(),
          }));
          setConversations(restored);
          setActiveId(restored[0].id);
        }
      } catch (err) {
        console.warn('[ChatAssistant] failed to load chat history:', err.message);
      } finally {
        hydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced upsert of the ACTIVE conversation only — the user can only
  // modify one chat at a time, and writing the whole list back on every
  // keystroke is wasted I/O. Switching chats causes activeConvo's reference
  // to change, which fires the effect for the newly-focused chat (so even
  // a brand-new chat created via "+ New chat" gets persisted as soon as
  // it's selected).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!window.electronAPI?.db?.update) return;
    if (!activeConvo) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const c = activeConvo;
        const doc = {
          id: c.id,
          title: c.title || 'New chat',
          messages: c.messages || [],
          agentMode: c.agentMode || 'main',
          workflowSession: c.workflowSession || null,
          pendingBuild: c.pendingBuild || null,
          activeSkill: c.activeSkill || null,
          updatedAt: c.updatedAt || Date.now(),
          createdAt: c.createdAt || Date.now(),
        };
        await window.electronAPI.db.update(
          'chatSessions',
          { id: c.id },
          { $set: sanitizeForNedb(doc) },
          { upsert: true },
        );
      } catch (err) {
        console.warn('[ChatAssistant] failed to persist chat history:', err.message);
      }
    }, 400);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [activeConvo]);

  const updateConvo = useCallback((id, patch) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)));
  }, []);

  const newChat = useCallback(() => {
    const fresh = blankConvo();
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setInput('');
  }, []);

  // Mark the focused conversation as "soft restarted" — the stored messages
  // are left alone, but the view shows an empty chat. Switching conversations
  // or closing the panel reverts to the persisted messages; sending a new
  // message (see `send`) commits the wipe.
  const restartChat = useCallback(() => {
    if (!activeId) return;
    setRestartedConvoIds((prev) => {
      if (prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
    setEditingMsgId(null);
    setInput('');
  }, [activeId]);

  // Delete a conversation. Removes from in-memory state, the chatSessions
  // NeDB collection, and ensures we always have at least one convo open.
  const deleteConvo = useCallback(async (convoId) => {
    if (!convoId) return;
    try {
      if (window.electronAPI?.db?.remove) {
        await window.electronAPI.db.remove('chatSessions', { id: convoId }, {});
      }
    } catch (err) {
      console.warn('[ChatAssistant] failed to remove convo from db:', err.message);
    }
    setConversations((prev) => {
      const remaining = prev.filter((c) => c.id !== convoId);
      if (remaining.length === 0) {
        const fresh = blankConvo();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (convoId === activeId) {
        setActiveId(remaining[0].id);
      }
      return remaining;
    });
  }, [activeId]);

  // Export the conversation as a JSON file download. The blob is built and
  // released immediately after the click — no need to keep object URLs.
  const exportConvo = useCallback((convoId) => {
    const target = conversations.find((c) => c.id === convoId);
    if (!target) return;
    try {
      const payload = JSON.stringify({
        id: target.id,
        title: target.title,
        agentMode: target.agentMode || 'main',
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        messages: target.messages,
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const safeTitle = String(target.title || 'chat').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ternlux-chat-${safeTitle}-${target.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.warn('[ChatAssistant] export failed:', err.message);
    }
  }, [conversations]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  // Append a message to the active conversation. Reads `prev` so it stays
  // safe under concurrent updates from inside the step loop. Every message
  // gets a stable id so per-message UI (e.g. plan-card status) can target it.
  const appendMessage = useCallback((msg) => {
    const stamped = msg.id ? msg : { ...msg, id: newMsgId() };
    setConversations((prev) => prev.map((c) => (
      c.id === activeId
        ? { ...c, messages: [...c.messages, stamped], updatedAt: Date.now() }
        : c
    )));
    return stamped.id;
  }, [activeId]);

  // Patch fields on a specific message by id (used by the plan card to
  // record accept/cancel status without re-running the agent).
  const patchMessage = useCallback((msgId, patch) => {
    setConversations((prev) => prev.map((c) => (
      c.id === activeId
        ? {
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
            updatedAt: Date.now(),
          }
        : c
    )));
  }, [activeId]);

  // Fold one build-progress event into the build-log message's `logs` array.
  // Searches every conversation by id (the build runs on the active one, but a
  // late event mustn't get lost if the user switched away). A 'running' event
  // appends a new line; the matching 'done' event flips that line's status.
  const applyBuildProgress = useCallback((msgId, evt) => {
    if (!msgId || !evt || evt.phase !== 'step') return;
    setConversations((prev) => prev.map((c) => {
      if (!c.messages.some((m) => m.id === msgId)) return c;
      return {
        ...c,
        messages: c.messages.map((m) => {
          if (m.id !== msgId) return m;
          const logs = Array.isArray(m.logs) ? m.logs.slice() : [];
          const idx = logs.findIndex((l) => l.stepIndex === evt.stepIndex);
          const line = {
            stepIndex: evt.stepIndex,
            stepType: evt.stepType,
            label: evt.label,
            action: evt.action,
            status: evt.status,
          };
          if (idx >= 0) logs[idx] = { ...logs[idx], ...line };
          else logs.push(line);
          return { ...m, logs };
        }),
        updatedAt: Date.now(),
      };
    }));
  }, []);

  // Subscribe once to the main process's build-progress stream. Events are
  // routed to whichever build-log message is currently in flight (buildLogRef).
  useEffect(() => {
    const api = window.electronAPI?.workflow;
    if (!api?.onBuildProgress) return undefined;
    const unsub = api.onBuildProgress((evt) => {
      applyBuildProgress(buildLogRef.current, evt);
    });
    return () => { try { unsub && unsub(); } catch (_) { /* ignore */ } };
  }, [applyBuildProgress]);

  // Run executeBuild and handle all three terminal cases: success, error,
  // and "the builder needs more info from the user". For the third case we
  // append the question to the chat and park a pendingBuild marker on the
  // conversation; the next user message is routed back here with the
  // answer appended to plan.clarifications and we retry the build.
  const runBuild = useCallback(async (plan, msgId) => {
    if (!window.electronAPI?.workflow?.executeBuild) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: 'Build IPC unavailable — restart the app to pick up the latest preload.' } });
      return;
    }
    patchMessage(msgId, { planStatus: { kind: 'running', message: 'Building workflow…' } });
    // Fresh build-log message for this run; progress events stream into it.
    // A re-run after a clarification gets its own log so partial prior logs
    // stay visible as history.
    const logMsgId = appendMessage({ role: 'assistant', kind: 'buildLog', ts: nowTs(), logs: [] });
    buildLogRef.current = logMsgId;
    try {
      const resp = await window.electronAPI.workflow.executeBuild({ plan });
      // Carry already-built nodes forward so the resumed build (after the user
      // answers) skips them instead of rebuilding the whole plan from step 0.
      const planForResume = resp?.builtSteps
        ? { ...plan, builtSteps: { ...(plan.builtSteps || {}), ...resp.builtSteps } }
        : plan;
      if (resp?.needsClarification) {
        // Park the build, ask the user, keep the plan card in "running"
        // state with a clarifying-message status.
        updateConvo(activeId, { pendingBuild: { msgId, plan: planForResume } });
        patchMessage(msgId, { planStatus: { kind: 'running', message: `Waiting for your answer: ${resp.question}` } });
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: resp.question,
          buildClarification: true,
        });
        return;
      }
      if (resp?.needsSkillSubagent) {
        // A node builder paused on a skill that needs more user input.
        // Park the build + activate the skill subagent. Subsequent user
        // messages route through chat.skillStep until the skill returns
        // `execute` (re-run executeBuild with plan.skillResults) or the
        // user closes out (re-run with plan.skipSkills).
        const activeSkill = {
          msgId,
          plan: planForResume,
          skillId:   resp.skillId,
          nodeId:    resp.nodeId,
          stepIndex: resp.stepIndex,
          state:     resp.state || {},
          context:   resp.context || {},
        };
        updateConvo(activeId, { pendingBuild: { msgId, plan: planForResume }, activeSkill });
        patchMessage(msgId, { planStatus: { kind: 'running', message: `Skill "${resp.skillId}" is asking for input…` } });
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: resp.question || resp.directAnswer || `Skill "${resp.skillId}" needs more input.`,
          skillSubagent: { active: true, skillId: resp.skillId, action: resp.action },
          buildClarification: resp.action === 'ask_questions',
        });
        return;
      }
      if (!resp?.success) {
        patchMessage(msgId, { planStatus: { kind: 'error', message: resp?.message || 'Build failed.' } });
        updateConvo(activeId, { pendingBuild: null, activeSkill: null });
        return;
      }
      const summary = `Built "${resp.workflowName}" — ${resp.nodeCount} node${resp.nodeCount === 1 ? '' : 's'}, ${resp.edgeCount} edge${resp.edgeCount === 1 ? '' : 's'}.`;
      patchMessage(msgId, { planStatus: { kind: 'success', message: summary } });
      // Cap the build log so it renders as a finished list, not mid-build.
      if (logMsgId) patchMessage(logMsgId, { done: true, summary });
      // Append a confirmation bubble so there's a visible response anchored
      // below the user's last message (a clarification answer typed at the
      // bottom otherwise only flips the plan-card status far up the thread,
      // which reads as "no response").
      appendMessage({
        role: 'assistant', kind: 'final', ts: nowTs(),
        text: `✓ ${summary}`,
      });
      // The workflow session is done — drop it so the next user message
      // lands on the main agent, not the workflow sub-agent.
      updateConvo(activeId, { agentMode: 'main', workflowSession: null, pendingBuild: null, activeSkill: null });
      // Tell the parent (Workflows.js) so it can switch to the Workflows
      // tab and hand the id to WorkflowsTab for refresh + auto-open.
      if (typeof onWorkflowBuilt === 'function') {
        try {
          onWorkflowBuilt({
            workflowId: resp.workflowId,
            workflowName: resp.workflowName,
            mode: resp.mode || 'new',
          });
        } catch (_) { /* parent handler shouldn't break the build flow */ }
      }
      const warnings = Array.isArray(resp.warnings) ? resp.warnings.filter(Boolean) : [];
      if (warnings.length) {
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: `**Build warnings (${warnings.length}):**\n\n${warnings.map((w) => `- ${w}`).join('\n')}`,
        });
      }
    } catch (err) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: `Build failed: ${err.message || String(err)}` } });
      updateConvo(activeId, { pendingBuild: null, activeSkill: null });
    } finally {
      // Stop streaming into this log and freeze its last line (no perpetual
      // spinner if the build paused for a clarification or errored).
      if (logMsgId) patchMessage(logMsgId, { done: true });
      buildLogRef.current = null;
    }
  }, [appendMessage, patchMessage, updateConvo, activeId, onWorkflowBuilt]);

  // User clicked the skill subagent's "close" button: treat it like the
  // skill itself returned `unrelateSkill` — re-run executeBuild with
  // plan.skipSkills set so the next pass takes the standard SQL/NoSQL
  // route.
  const closeSkillSubagent = useCallback(async () => {
    const activeSkill = activeConvo?.activeSkill;
    if (!activeSkill || !activeSkill.skillId) return;
    const plan = activeSkill.plan || {};
    const nextSkipSkills = {
      ...(plan.skipSkills || {}),
      [activeSkill.stepIndex]: true,
    };
    const nextPlan = { ...plan, skipSkills: nextSkipSkills };
    updateConvo(activeId, { activeSkill: null });
    appendMessage({
      role: 'assistant', kind: 'final', ts: nowTs(),
      text: `Closed the ${activeSkill.skillId} skill subagent. Continuing with the standard build.`,
    });
    await runBuild(nextPlan, activeSkill.msgId);
  }, [activeConvo, activeId, appendMessage, runBuild, updateConvo]);

  // Plan-card actions. Accept calls runBuild directly so the AI doesn't
  // have to re-interpret a "Confirm build" text turn; Cancel just locks
  // the card in place.
  const handlePlanAction = useCallback(async (action, plan, msgId) => {
    if (!msgId) return;
    if (action === 'cancel-plan') {
      patchMessage(msgId, { planStatus: { kind: 'cancelled', message: 'Plan discarded.' } });
      updateConvo(activeId, { pendingBuild: null });
      return;
    }
    if (action !== 'accept-plan') return;
    if (!plan || !Array.isArray(plan.steps)) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: 'Plan is malformed; nothing to build.' } });
      return;
    }
    await runBuild(plan, msgId);
  }, [patchMessage, updateConvo, activeId, runBuild]);

  // Build a fresh user message with the workflow tag stamped in. `mode`
  // controls routing on the next chat:step turn (Edit/Retry pass it from
  // the original message's tag; new sends pass the convo's current mode).
  // `session` lets callers stamp a specific workflowSession on the message
  // (used by Edit/Retry so the re-run resumes from the session that was
  // active when the target message was originally sent — not the convo's
  // current session). Passing `undefined` falls back to the live convo.
  const makeUserMsg = useCallback((text, mode = null, session = undefined) => {
    const m = mode || activeConvo?.agentMode || 'main';
    const ws = session === undefined ? (activeConvo?.workflowSession || null) : session;
    return {
      id: newMsgId(),
      role: 'user',
      text,
      ts: nowTs(),
      agentMode: m,
      workflowSession: ws,
      ...(m === 'workflow' ? { workflowBuilder: true } : {}),
    };
  }, [activeConvo]);

  // ChatGPT-style in-place edit. Click Edit on a user message → the bubble
  // flips to a textarea. Save & submit truncates the conversation up to
  // (but not including) the edited message, appends a fresh user message
  // with the edited text in its place, and passes the rebuilt array to
  // send(). Cancel → just exit edit mode.
  const handleEditMessage = useCallback((msgId) => {
    setEditingMsgId(msgId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMsgId(null);
  }, []);

  const handleSaveEdit = useCallback((msgId, newText) => {
    if (!activeConvo || !newText || !newText.trim()) return;
    const msgs = activeConvo.messages;
    const idx = msgs.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const target = msgs[idx];
    if (target?.role !== 'user') return;
    const trimmed = msgs.slice(0, idx);
    const tagMode = target.agentMode === 'workflow' ? 'workflow' : 'main';
    // Restore the workflowSession that was active when this message was
    // originally sent. Pre-fix messages may not carry one — fall back to the
    // legacy behavior so we don't strip a still-live session.
    const targetSession = 'workflowSession' in target
      ? target.workflowSession
      : (tagMode === 'workflow' ? (activeConvo.workflowSession || null) : null);
    const userMsg = makeUserMsg(newText.trim(), tagMode, targetSession);
    // Reset transient session state tied to messages that no longer exist.
    updateConvo(activeConvo.id, {
      agentMode: tagMode,
      workflowSession: targetSession,
      pendingBuild: null,
      activeSkill: null,
    });
    setEditingMsgId(null);
    send([...trimmed, userMsg]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvo, makeUserMsg, updateConvo]);

  // Retry handler — finds the most recent user message at-or-before the
  // clicked bot message, trims the tail, and re-sends with that user
  // message's text. Routing (main vs workflow sub-agent) honours the
  // user message's `agentMode` tag, copied onto the fresh user turn.
  const handleRetryMessage = useCallback((botMsgId) => {
    if (!activeConvo) return;
    const msgs = activeConvo.messages;
    const botIdx = msgs.findIndex((m) => m.id === botMsgId);
    if (botIdx < 0) return;
    let userIdx = -1;
    for (let i = botIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const target = msgs[userIdx];
    const trimmed = msgs.slice(0, userIdx);
    const tagMode = target.agentMode === 'workflow' ? 'workflow' : 'main';
    // Same snapshot rule as edit — resume from the session that was active
    // when the target message was sent.
    const targetSession = 'workflowSession' in target
      ? target.workflowSession
      : (tagMode === 'workflow' ? (activeConvo.workflowSession || null) : null);
    const userMsg = makeUserMsg(target.text || '', tagMode, targetSession);
    updateConvo(activeConvo.id, {
      agentMode: tagMode,
      workflowSession: targetSession,
      pendingBuild: null,
    });
    send([...trimmed, userMsg]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvo, makeUserMsg, updateConvo]);

  // send() takes the full conversation as an array; the last element is the
  // new user message (the one being processed). Callers are responsible
  // for any trim + rebuild — see handleRetryMessage / handleSaveEdit. From
  // send()'s point of view every call is identical: write the array as the
  // conversation's messages, then run the chat:step loop using everything
  // before the last element as cross-turn history.
  const send = useCallback(async (historyArray) => {
    if (loading) return;
    if (!Array.isArray(historyArray) || historyArray.length === 0) return;
    let userMsg = historyArray[historyArray.length - 1];
    const text = (userMsg?.text || '').trim();
    if (!text || userMsg?.role !== 'user') return;
    if (!window.electronAPI?.chat?.step) {
      appendMessage({
        role: 'assistant', error: true, ts: nowTs(),
        text: 'Chat backend is not available. The Electron preload may be out of date — restart the app.',
      });
      return;
    }

    // Sending commits a pending soft-restart: the stored conversation gets
    // wiped, the user msg's agentMode tag is normalized to 'main' (so the
    // workflow sub-agent doesn't resume on top of a "new" chat), and we
    // drop any in-flight build/session state on the convo.
    const wasRestarted = restartedConvoIds.has(activeId);
    let effHistory = historyArray;
    if (wasRestarted) {
      setRestartedConvoIds((prev) => {
        if (!prev.has(activeId)) return prev;
        const next = new Set(prev);
        next.delete(activeId);
        return next;
      });
      const { workflowBuilder: _wb, ...rest } = userMsg;
      userMsg = { ...rest, agentMode: 'main', workflowSession: null };
      effHistory = [userMsg];
    }

    const isFirstMessage = effHistory.length === 1;
    // Seed an immediate placeholder title from the user's text so the chat
    // sidebar shows something useful right away; the AI-generated title
    // replaces it below once the call returns.
    const titleUpdate = isFirstMessage ? { title: titleFromMessage(text) } : {};
    const restartUpdate = wasRestarted
      ? { agentMode: 'main', workflowSession: null, pendingBuild: null }
      : {};
    updateConvo(activeId, { messages: effHistory, ...titleUpdate, ...restartUpdate });
    setInput('');

    // First user message → ask the AI for a 3-5 word topic title and patch
    // the conversation when it returns. Fire-and-forget; failures fall back
    // to the synchronous placeholder set above.
    if (isFirstMessage && window.electronAPI?.chat?.generateTitle) {
      const convoToTitle = activeId;
      (async () => {
        try {
          const resp = await window.electronAPI.chat.generateTitle({ message: text });
          if (resp?.success && resp.title) {
            updateConvo(convoToTitle, { title: resp.title });
          }
        } catch (_) { /* keep the placeholder title */ }
      })();
    }

    // If we're waiting on an answer from the user for an in-flight workflow
    // build (a builder threw ClarificationNeeded), the user's reply isn't
    // a new chat turn — it's the answer. Re-run executeBuild with the
    // accumulated clarifications instead of hitting chat:step. A restart
    // commit drops pendingBuild entirely so we never resume it.
    const pendingBuild = wasRestarted ? null : (activeConvo?.pendingBuild || null);
    const pendingClarMsg = pendingBuild
      ? effHistory.slice(0, -1).find((m) => m.buildClarification && !m.answered)
      : null;
    const activeSkill = wasRestarted ? null : (activeConvo?.activeSkill || null);

    // Skill subagent active: route the user's reply through chat.skillStep
    // and react to the four-action contract. Loops via chat history — each
    // ask_questions / answer_directly response adds a chat message; the
    // user's next reply re-enters this branch.
    if (activeSkill && activeSkill.skillId && !wasRestarted) {
      if (pendingClarMsg) patchMessage(pendingClarMsg.id, { answered: true });
      try {
        const resp = await window.electronAPI.chat.skillStep({
          skillId:      activeSkill.skillId,
          userMessage:  text,
          currentState: activeSkill.state || {},
          context:      activeSkill.context || {},
        });
        if (!resp?.success) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Skill "${activeSkill.skillId}" errored: ${resp?.message || 'unknown error'}`,
          });
          return;
        }
        if (resp.action === 'ask_questions' || resp.action === 'answer_directly') {
          // Stay in the skill — update state, surface the next message.
          updateConvo(activeId, {
            activeSkill: { ...activeSkill, state: resp.state || activeSkill.state },
          });
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: resp.question || resp.directAnswer || `Skill "${activeSkill.skillId}" responded.`,
            skillSubagent: { active: true, skillId: activeSkill.skillId, action: resp.action },
            buildClarification: resp.action === 'ask_questions',
          });
          return;
        }
        if (resp.action === 'execute') {
          // Skill produced execution params — re-run executeBuild with
          // them stashed in plan.skillResults so the dispatcher routes
          // that node through applySkillResult{Transformer|Join}.
          const plan = activeSkill.plan || {};
          const nextSkillResults = {
            ...(plan.skillResults || {}),
            [activeSkill.stepIndex]: {
              skillId:          activeSkill.skillId,
              executionParams:  resp.executionParams || {},
              explanation:      resp.explanation || null,
            },
          };
          const nextPlan = { ...plan, skillResults: nextSkillResults };
          updateConvo(activeId, { activeSkill: null });
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: `✓ Skill "${activeSkill.skillId}" finished. Continuing the build…`,
          });
          await runBuild(nextPlan, activeSkill.msgId);
          return;
        }
        if (resp.action === 'unrelateSkill') {
          // Skill bows out — re-run executeBuild with plan.skipSkills so
          // the analyser takes the standard SQL/NoSQL path.
          const plan = activeSkill.plan || {};
          const nextSkipSkills = {
            ...(plan.skipSkills || {}),
            [activeSkill.stepIndex]: true,
          };
          const nextPlan = { ...plan, skipSkills: nextSkipSkills };
          updateConvo(activeId, { activeSkill: null });
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: resp.explanation || `Skill "${activeSkill.skillId}" said this isn't its territory — switching to the standard flow.`,
          });
          await runBuild(nextPlan, activeSkill.msgId);
          return;
        }
        appendMessage({
          role: 'assistant', error: true, ts: nowTs(),
          text: `Skill "${activeSkill.skillId}" returned unknown action "${resp.action}".`,
        });
        return;
      } catch (err) {
        appendMessage({
          role: 'assistant', error: true, ts: nowTs(),
          text: `Skill step failed: ${err.message || String(err)}`,
        });
        return;
      }
    }

    if (pendingBuild && pendingClarMsg) {
      patchMessage(pendingClarMsg.id, { answered: true });
      const plan = pendingBuild.plan || {};
      const prevClar = Array.isArray(plan.clarifications) ? plan.clarifications : [];
      const nextPlan = {
        ...plan,
        clarifications: [
          ...prevClar,
          { question: pendingClarMsg.text, answer: text },
        ],
      };
      // Show a conversation-level "thinking" indicator while the build
      // resumes — answering a clarification otherwise looked unresponsive
      // because runBuild only updates the plan card far up the thread.
      setLoading(true);
      setStage('Building workflow…');
      try {
        await runBuild(nextPlan, pendingBuild.msgId);
      } finally {
        setLoading(false);
        setStage('Thinking…');
      }
      return;
    }

    setLoading(true);
    setStage('Thinking…');
    cancelledRef.current = false;

    // Cross-turn history sent to the model is the chat BEFORE the new user
    // turn — intermediate steps for this question live in the local
    // scratchpad. The `clarification` flag is what the backend uses to
    // derive the workflow-builder's Q/A trail (paired with the next user
    // message).
    const history = effHistory.slice(0, -1)
      .filter((m) => m.kind !== 'step' && m.kind !== 'buildLog')  // don't replay tool/log turns
      .map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.clarification ? { clarification: true } : {}),
      }));
    const ctx = effectiveContext;
    const scratchpad = [];
    // Seed the agent mode + session from the user message's own stamps —
    // Edit/Retry pass the target message's session so the re-run resumes
    // from where it was originally sent. Falls back to the convo's live
    // session for pre-fix messages that don't carry one.
    // A restart commit forces 'main' and drops any prior workflow session.
    let agentMode       = wasRestarted ? 'main' : (userMsg.agentMode || activeConvo?.agentMode || 'main');
    let workflowSession = wasRestarted
      ? null
      : ('workflowSession' in userMsg
          ? userMsg.workflowSession
          : (activeConvo?.workflowSession || null));

    // When the AI batches plan_workflow_build with other tools, the backend
    // defers it and returns the args here. We stash them so the loop can
    // restart with `triggerPlanWorkflowBuild` once the current finalAnswer
    // lands — the user sees the ordinary tools' result first, then the
    // workflow build kicks off.
    let triggerPlanWorkflowBuild = null;
    let pendingPlanArgs = null;

    try {
      let i = 0;
      while (i < MAX_STEPS_PER_QUESTION) {
        if (cancelledRef.current) {
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: '_Stopped by user._',
          });
          break;
        }

        let resp;
        try {
          resp = await window.electronAPI.chat.step({
            message: text,
            history,
            scratchpad,
            activeContext: ctx,
            agentMode,
            workflowSession,
            triggerPlanWorkflowBuild,
          });
        } catch (err) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Error: ${err.message || String(err)}`,
          });
          break;
        }
        triggerPlanWorkflowBuild = null; // single-use per turn

        // Discard the result silently if the user cancelled while it was in
        // flight — the final "stopped" message was already appended above.
        if (cancelledRef.current) break;

        if (!resp?.success) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: resp?.message || 'The assistant could not answer that. Check that an AI provider key is configured in Settings.',
          });
          break;
        }

        // Track mode + session moves across the step loop. The sub-agent
        // may flip these mid-question (main → workflow on a
        // plan_workflow_build trigger; workflow → main on
        // exit_workflow_mode).
        if (resp.nextAgentMode)               agentMode       = resp.nextAgentMode;
        if ('workflowSession' in resp)        workflowSession = resp.workflowSession || null;
        if (resp.pendingPlanWorkflowBuild)    pendingPlanArgs = resp.pendingPlanWorkflowBuild.args || {};
        setStage(agentMode === 'workflow' ? 'Workflow builder…' : 'Thinking…');

        // A short-circuit turn (propose_plan) returns BOTH a tool step
        // AND a finalAnswer in the same response — render the step
        // bubble first so the user sees the planner ran, then the
        // final bubble with the plan card or clarification.
        if (resp.step) scratchpad.push(resp.step);
        const hasActions = Array.isArray(resp.actions) && resp.actions.length > 0;
        if (hasActions) {
          appendMessage({
            role: 'assistant', kind: 'step', ts: nowTs(),
            stepIndex: resp.step?.index ?? scratchpad.length,
            thought: resp.thought,
            actions: resp.actions,
          });
        }

        if (resp.done) {
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: resp.finalAnswer || '(no answer)',
            workflowPlan: resp.workflowPlan || null,
            visuals: Array.isArray(resp.visuals) ? resp.visuals : null,
            clarification: !!resp.clarification,
          });
          // A plan card (propose_plan) is a HARD STOP: applying the plan is
          // the user's Accept click (handlePlanAction → runBuild), not
          // something the agent can do. Return control to the user and drop
          // any deferred build so we don't re-enter the workflow and re-plan
          // the same thing in a loop.
          if (resp.workflowPlan) {
            pendingPlanArgs = null;
            break;
          }
          // If the AI batched plan_workflow_build with this turn's tools,
          // restart the loop with triggerPlanWorkflowBuild — the workflow
          // build runs after the user sees the finalAnswer.
          if (pendingPlanArgs) {
            triggerPlanWorkflowBuild = pendingPlanArgs;
            pendingPlanArgs = null;
            i = 0;
            continue;
          }
          break;
        }

        if (i === MAX_STEPS_PER_QUESTION - 1) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Reached the ${MAX_STEPS_PER_QUESTION}-step limit without a final answer. Ask a more specific follow-up.`,
          });
        }

        i++;
      }
    } finally {
      // Persist whatever mode/session the conversation ended on so the
      // NEXT user message resumes in the right agent.
      updateConvo(activeId, { agentMode, workflowSession });
      setLoading(false);
      setStage('Thinking…');
      cancelledRef.current = false;
    }
  }, [input, loading, messages, effectiveContext, activeId, activeConvo, restartedConvoIds, updateConvo, appendMessage, patchMessage, runBuild]);

  // Parent (Workflows.js) hides the assistant entirely when a node-config
  // chat panel is open, since the two would compete for the same corner.
  if (hidden) return null;

  // ── Floating launcher button ─────────────────────────────────────────────
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} title="Open Ternlux Assistant"
        style={{
          position: 'fixed', bottom: 24, right: 24, height: 46,
          padding: '0 16px 0 14px', borderRadius: 23,
          background: C.accent, border: 'none',
          boxShadow: '0 12px 32px rgba(37,99,235,0.32), 0 4px 12px rgba(0,0,0,0.08)',
          cursor: 'pointer', zIndex: 1020,
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: SANS, transition: 'transform 0.15s',
        }}
        onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}>
        {I('compass', '#fff', 16)}
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
          Ask Ternlux
        </span>
      </button>
    );
  }

  // ── Header ───────────────────────────────────────────────────────────────
  const Header = (
    <div style={{
      padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
      background: C.bg, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 5, background: C.aD,
        border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {I('compass', C.accent, 14)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.01em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isRestarted ? 'New chat' : (activeConvo?.title || 'Ternlux Assistant')}
        </div>
        <div style={{
          fontSize: 9, fontFamily: MONO, color: C.muted, letterSpacing: '0.08em',
          textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5, marginTop: 1,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: !isRestarted && activeConvo?.agentMode === 'workflow' ? '#7c3aed' : C.green,
            boxShadow: `0 0 0 2px ${!isRestarted && activeConvo?.agentMode === 'workflow' ? '#ede9fe' : C.gB}`,
            display: 'inline-block',
          }} />
          {loading
            ? stage
            : (!isRestarted && activeConvo?.agentMode === 'workflow'
                ? 'Workflow builder · gathering details'
                : 'Ternlux Assistant · ready')}
        </div>
      </div>
      <button type="button" onClick={restartChat}
        title="Restart current chat"
        disabled={!messages.length}
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: messages.length ? 'pointer' : 'default',
          color: messages.length ? C.muted : C.dim, display: 'flex',
          opacity: messages.length ? 1 : 0.5,
        }}>
        {/* refresh / counter-clockwise rotation icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      {!expanded && (
        <button type="button" onClick={newChat} title="Start a new chat"
          style={{
            padding: 6, borderRadius: 4, background: 'transparent',
            border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
          }}>
          {I('plus', C.muted, 14)}
        </button>
      )}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Restore' : 'Maximize'}
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
        }}>
        {expanded ? <IconRestore color={C.muted} size={12} /> : <IconMaximize color={C.muted} size={12} />}
      </button>
      <button type="button" onClick={() => setOpen(false)} title="Close"
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
        }}>
        {I('x', C.muted, 14)}
      </button>
    </div>
  );

  // ── Body ─────────────────────────────────────────────────────────────────
  const Body = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>
      {Header}
      {effectiveContext && (
        <div style={{
          padding: '8px 14px', borderBottom: `1px solid ${C.border}`, background: '#fff',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
            color: C.dim, textTransform: 'uppercase',
          }}>Focused on</span>
          <ContextChip ctx={effectiveContext} onClear={() => setPinnedContext('cleared')} />
        </div>
      )}
      <div ref={scrollRef} style={{
        flex: 1, overflowY: 'auto', padding: 14, background: C.surface,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {messages.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 14, padding: '12px 4px',
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 8, background: C.aD,
              border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{I('compass', C.accent, 22)}</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: '-0.02em', marginBottom: 3 }}>
                How can I help?
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>
                Ask about your workflows, connections, executions, or query your data.
              </div>
            </div>
            <SugGrid onPick={(t) => send([...messages, makeUserMsg(t)])} />
          </div>
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={m.id || i}
              m={m}
              onAction={handlePlanAction}
              onEdit={handleEditMessage}
              onRetry={handleRetryMessage}
              isEditing={editingMsgId === m.id}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              busy={loading}
            />
          ))
        )}
        {loading && <Typing stage={stage} />}
      </div>
      {activeConvo?.activeSkill?.skillId && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', borderTop: `1px solid ${C.border}`,
          background: '#fef3c7', color: '#92400e', fontSize: 12, fontFamily: SANS,
        }}>
          <span>
            <strong>Skill subagent active:</strong> {activeConvo.activeSkill.skillId} — your replies route to this skill.
          </span>
          <button
            type="button"
            onClick={closeSkillSubagent}
            style={{
              border: '1px solid #92400e', background: 'transparent', color: '#92400e',
              padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            }}>
            Close skill
          </button>
        </div>
      )}
      <Composer value={input} setValue={setInput}
        onSend={() => {
          const text = input.trim();
          if (!text) return;
          send([...messages, makeUserMsg(text)]);
        }}
        onCancel={cancel} busy={loading} />
    </div>
  );

  // ── Popup mode ───────────────────────────────────────────────────────────
  if (!expanded) {
    return (
      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        width: 440, height: 620, borderRadius: 10, background: '#fff',
        boxShadow: '0 24px 64px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.06)',
        border: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        zIndex: 1020, fontFamily: SANS,
      }}>
        {Body}
      </div>
    );
  }

  // ── Expanded mode (with history sidebar) ─────────────────────────────────
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)',
        backdropFilter: 'blur(3px)', zIndex: 1020, padding: 24, display: 'flex',
        fontFamily: SANS,
      }}>
      <div style={{
        margin: 'auto', width: '100%', maxWidth: 1100, height: '100%',
        background: '#fff', borderRadius: 12,
        boxShadow: '0 32px 80px rgba(0,0,0,0.32)',
        display: 'flex', overflow: 'hidden',
        border: `1px solid ${C.border}`,
      }}>
        <HistorySidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => setActiveId(id)}
          onNewChat={newChat}
          onDeleteConvo={deleteConvo}
          onExportConvo={exportConvo}
        />
        {Body}
      </div>
    </div>
  );
};

export default ChatAssistant;
