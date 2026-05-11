import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { C, SANS, MONO, I } from '../Workflows/_designShared';

const MAX_STEPS_PER_QUESTION = 8;

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
const blankConvo = () => ({ id: newConvoId(), title: 'New chat', messages: [], updatedAt: Date.now() });

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

// ── Inline markdown (bold + `code`) ────────────────────────────────────────
const Markdown = ({ text }) => {
  if (!text) return null;
  const blocks = String(text).split(/\n\n+/);
  return blocks.map((block, bi) => (
    <div key={bi} style={{ marginTop: bi === 0 ? 0 : 8 }}>
      {block.split('\n').map((line, li) => (
        <div key={li}>
          {line.split(/(\*\*.*?\*\*|`[^`]*`)/g).map((p, i) => {
            if (p.startsWith('**') && p.endsWith('**'))
              return <strong key={i} style={{ fontWeight: 700 }}>{p.slice(2, -2)}</strong>;
            if (p.startsWith('`') && p.endsWith('`'))
              return (
                <code key={i} style={{
                  fontFamily: MONO, fontSize: 11, background: C.s2,
                  padding: '1px 5px', borderRadius: 3, border: `1px solid ${C.border}`,
                }}>{p.slice(1, -1)}</code>
              );
            return <span key={i}>{p}</span>;
          })}
        </div>
      ))}
    </div>
  ));
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
          {action.error
            ? `ERROR: ${action.error}`
            : (typeof action.result === 'string'
                ? action.result
                : JSON.stringify(action.result, null, 2)).slice(0, 4000)}
        </pre>
      )}
    </div>
  );
};

// ── Chat bubble — user + final assistant + error ──────────────────────────
const Bubble = ({ m }) => {
  if (m.kind === 'step') return <StepBubble m={m} />;
  const isUser = m.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, flexDirection: isUser ? 'row-reverse' : 'row' }}>
      <div style={{
        width: 26, height: 26, borderRadius: 4, flexShrink: 0,
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
          {m.error ? <span style={{ color: C.red }}>{m.text}</span> : <Markdown text={m.text} />}
        </div>
        <div style={{
          marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO,
          textAlign: isUser ? 'right' : 'left',
        }}>{m.ts}</div>
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
const HistorySidebar = ({ conversations, activeId, onSelect, onNewChat }) => {
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
              }}
              onMouseOver={(e) => { if (!isActive) e.currentTarget.style.background = C.surface; }}
              onMouseOut={(e)  => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
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
          );
        })}
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────
const ChatAssistant = ({ activeContext: incomingContext = null }) => {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState('Thinking…');
  const [pinnedContext, setPinnedContext] = useState(null);

  // Multi-conversation state. New chat starts fresh; switching conversations
  // swaps in their messages. History sidebar (expanded mode) lists them all.
  const [conversations, setConversations] = useState(() => [blankConvo()]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const activeConvo = useMemo(
    () => conversations.find((c) => c.id === activeId) || conversations[0],
    [conversations, activeId],
  );
  const messages = activeConvo?.messages || [];

  const scrollRef = useRef(null);
  // Cancel flag — set when the user clicks Stop. Checked between steps;
  // cancellation just means "do not issue the next chat:step call". The
  // currently in-flight call still completes, but its result is discarded.
  const cancelledRef = useRef(false);

  const effectiveContext = useMemo(() => {
    if (pinnedContext === 'cleared') return null;
    return pinnedContext || incomingContext;
  }, [pinnedContext, incomingContext]);

  useEffect(() => { setPinnedContext(null); }, [incomingContext?.kind, incomingContext?.id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open, expanded, activeId]);

  const updateConvo = useCallback((id, patch) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)));
  }, []);

  const newChat = useCallback(() => {
    const fresh = blankConvo();
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setInput('');
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  // Append a message to the active conversation. Reads `prev` so it stays
  // safe under concurrent updates from inside the step loop.
  const appendMessage = useCallback((msg) => {
    setConversations((prev) => prev.map((c) => (
      c.id === activeId
        ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() }
        : c
    )));
  }, [activeId]);

  const send = useCallback(async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    if (!window.electronAPI?.chat?.step) {
      appendMessage({
        role: 'assistant', error: true, ts: nowTs(),
        text: 'Chat backend is not available. The Electron preload may be out of date — restart the app.',
      });
      return;
    }

    const userMsg = { role: 'user', text, ts: nowTs() };
    const titleUpdate = activeConvo?.messages?.length === 0
      ? { title: titleFromMessage(text) }
      : {};
    updateConvo(activeId, { messages: [...messages, userMsg], ...titleUpdate });
    setInput('');
    setLoading(true);
    setStage('Thinking…');
    cancelledRef.current = false;

    // Cross-turn history sent to the model is the chat BEFORE this question —
    // intermediate steps for this question live in the local scratchpad.
    const history = messages
      .filter((m) => m.kind !== 'step')          // don't replay tool turns
      .map((m) => ({ role: m.role, text: m.text }));
    const ctx = effectiveContext;
    const scratchpad = [];

    try {
      for (let i = 0; i < MAX_STEPS_PER_QUESTION; i++) {
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
          });
        } catch (err) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Error: ${err.message || String(err)}`,
          });
          break;
        }

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

        if (resp.done) {
          appendMessage({
            role: 'assistant', kind: 'final', text: resp.finalAnswer || '(no answer)', ts: nowTs(),
          });
          break;
        }

        // Stream the step into the chat AND record it for the next call.
        scratchpad.push(resp.step);
        appendMessage({
          role: 'assistant', kind: 'step', ts: nowTs(),
          stepIndex: resp.step?.index ?? scratchpad.length,
          thought: resp.thought,
          actions: resp.actions || [],
        });
        setStage(`Working… step ${scratchpad.length + 1}`);

        if (i === MAX_STEPS_PER_QUESTION - 1) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Reached the ${MAX_STEPS_PER_QUESTION}-step limit without a final answer. Ask a more specific follow-up.`,
          });
        }
      }
    } finally {
      setLoading(false);
      setStage('Thinking…');
      cancelledRef.current = false;
    }
  }, [input, loading, messages, effectiveContext, activeId, activeConvo, updateConvo, appendMessage]);

  // ── Floating launcher button ─────────────────────────────────────────────
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} title="Open Dagflux Assistant"
        style={{
          position: 'fixed', bottom: 24, right: 24, height: 46,
          padding: '0 16px 0 14px', borderRadius: 23,
          background: C.accent, border: 'none',
          boxShadow: '0 12px 32px rgba(37,99,235,0.32), 0 4px 12px rgba(0,0,0,0.08)',
          cursor: 'pointer', zIndex: 1100,
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: SANS, transition: 'transform 0.15s',
        }}
        onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}>
        {I('compass', '#fff', 16)}
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
          Ask Dagflux
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
          {activeConvo?.title || 'Dagflux Assistant'}
        </div>
        <div style={{
          fontSize: 9, fontFamily: MONO, color: C.muted, letterSpacing: '0.08em',
          textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5, marginTop: 1,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', background: C.green,
            boxShadow: `0 0 0 2px ${C.gB}`, display: 'inline-block',
          }} />
          {loading ? stage : 'Dagflux Assistant · ready'}
        </div>
      </div>
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
            <SugGrid onPick={(t) => send(t)} />
          </div>
        ) : (
          messages.map((m, i) => <Bubble key={i} m={m} />)
        )}
        {loading && <Typing stage={stage} />}
      </div>
      <Composer value={input} setValue={setInput} onSend={() => send()} onCancel={cancel} busy={loading} />
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
        zIndex: 1100, fontFamily: SANS,
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
        backdropFilter: 'blur(3px)', zIndex: 1000, padding: 24, display: 'flex',
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
        />
        {Body}
      </div>
    </div>
  );
};

export default ChatAssistant;
