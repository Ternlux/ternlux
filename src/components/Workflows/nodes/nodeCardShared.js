import React, { useState } from 'react';
import { CodeOutlined } from '@ant-design/icons';

const MONO = "'JetBrains Mono', monospace";
const MUTED = '#5a6678';
const DIM = '#9ca3af';
const BORDER = '#e2e6eb';
const SURFACE = '#f7f8fa';

// Fields on a chat bot message's `metadata` object that may contain a code
// string we want to surface on the node card. Order is "primary code first,
// supporting code after" since the first field present drives the default
// label shown collapsed.
const CODE_FIELDS = [
  { key: 'sql',                label: 'SQL',          lang: 'sql' },
  { key: 'joinSql',            label: 'JOIN SQL',     lang: 'sql' },
  { key: 'insertSql',          label: 'INSERT',       lang: 'sql' },
  { key: 'ddl',                label: 'DDL',          lang: 'sql' },
  { key: 'previewSql',         label: 'PREVIEW',      lang: 'sql' },
  { key: 'apiFetchCode',       label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'javascriptFunction', label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'transformFunction',  label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'validationFunction', label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'pythonCode',         label: 'PYTHON',       lang: 'python' },
  { key: 'nosqlOperation',     label: 'NOSQL',        lang: 'json' },
];

/**
 * Walk the chat backwards and return the codes carried by the most recent
 * bot message that has any. We stop at the first matching message so the
 * card reflects the *latest* state of the configuration, not stale earlier
 * drafts the user may have refined past.
 */
export const extractLatestCodes = (chat) => {
  if (!Array.isArray(chat) || chat.length === 0) return [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.sender !== 'bot' || !m.metadata) continue;
    const found = [];
    for (const f of CODE_FIELDS) {
      const raw = m.metadata[f.key];
      if (raw == null) continue;
      const str = typeof raw === 'string' ? raw : safeStringify(raw);
      if (!str || !str.trim()) continue;
      found.push({ type: f.label, lang: f.lang, content: str });
    }
    if (found.length > 0) return found;
  }
  return [];
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
};

// ── Node summaries ──────────────────────────────────────────────────────────
// The second line of a card answers "what does this node do?", and the only
// honest source for that is the node's own config — the same fields the Data
// Preview names in its header and Details tab. Cards used to fall back to the
// last message in the chat, which records what the user ASKED rather than what
// the node ended up configured to do, and goes stale the moment the config is
// changed from the form.

const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** "schema.table", or the bare table when the source has no schema. */
const qualified = (schema, name) => (nonEmpty(schema) ? `${schema}.${name}` : name);

/** The dataset a node reads. Same precedence as the Data Preview header. */
export const sourceDatasetOf = (config = {}) => {
  if (nonEmpty(config.sourceCollection)) return config.sourceCollection;
  if (nonEmpty(config.sourceTableName)) return qualified(config.sourceSchema, config.sourceTableName);
  if (nonEmpty(config.sourceIndexName)) return config.sourceIndexName;
  if (nonEmpty(config.table)) return config.table;
  if (nonEmpty(config.sourceDataset)) return config.sourceDataset;
  if (nonEmpty(config.dataset)) return config.dataset;
  return '';
};

/** The dataset a node writes. */
export const targetDatasetOf = (config = {}) => {
  if (nonEmpty(config.targetCollection)) return config.targetCollection;
  if (nonEmpty(config.targetTableName)) return qualified(config.targetSchema, config.targetTableName);
  return '';
};

const describeDataSource = (config) => {
  // A REST API source has no table to name — the endpoint identifies it, and
  // the collection it caches into is where downstream nodes read from.
  const api = config.apiConnectionPublicConfig;
  if (api || config.sourceConnectionType === 'api') {
    if (!nonEmpty(config.apiFetchCode)) return 'REST API — describe the request in the chat';
    const into = nonEmpty(config.sourceCollection) ? ` into ${config.sourceCollection}` : '';
    return `Fetches ${nonEmpty(api?.baseUrl) ? api.baseUrl : 'the API'}${into}`;
  }
  const dataset = sourceDatasetOf(config);
  return dataset ? `Reads ${dataset}` : '';
};

const describeTransformer = (config) => {
  const src = sourceDatasetOf(config);
  const target = targetDatasetOf(config);
  if (config.usesSkill && nonEmpty(config.skillId)) {
    return src ? `Runs ${config.skillId} on ${src}` : `Runs ${config.skillId}`;
  }
  if (config.transformationSettings?.operationMode === 'in_place' && src) {
    return `Updates ${src} in place`;
  }
  if (src && target) return `Transforms ${src} → ${target}`;
  if (target) return `Writes ${target}`;
  return src ? `Transforms ${src}` : '';
};

const describeJoin = (config) => {
  const names = Array.isArray(config.sources)
    ? config.sources
      .map((s) => s?.sourceTableName || s?.sourceCollection || s?.sourceNodeLabel || s?.sourceConnectionName)
      .filter(nonEmpty)
    : [];
  const target = targetDatasetOf(config);
  const into = target ? ` → ${target}` : '';
  if (names.length === 0) return target ? `Writes ${target}` : '';
  // Past three the names crowd out the target, which is the more useful half.
  const from = names.length > 3 ? `${names.length} sources` : names.join(' + ');
  return `Joins ${from}${into}`;
};

/**
 * One line naming what a node reads and writes, built from its config. Returns
 * '' when the config has nothing to identify yet, so callers can fall back to
 * an AI explanation or their own placeholder.
 */
export const describeNode = (type, config = {}) => {
  if (type === 'dataSource') return describeDataSource(config);
  if (type === 'transformer') return describeTransformer(config);
  if (type === 'join') return describeJoin(config);
  return '';
};

/** Card summaries are one clamped paragraph — keep prose from running away. */
export const truncate = (text, max = 100) => {
  const str = String(text || '').trim();
  return str.length > max ? `${str.slice(0, max)}...` : str;
};

// ── Syntax highlighting ─────────────────────────────────────────────────────
// Tokenizer shared by all supported languages. We keep the palette small and
// compatible with the dark editor background: strings green, numbers amber,
// keywords indigo, comments grey, builtins cyan.

const TOKEN_COLORS = {
  keyword: '#818cf8',
  string:  '#86efac',
  number:  '#fbbf24',
  comment: '#64748b',
  builtin: '#5eead4',
  punct:   '#cbd5e1',
  base:    '#e2e8f0',
};

const SQL_KEYWORDS = [
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL','AS','DISTINCT',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','USING','UNION','ALL',
  'GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','INSERT','INTO','VALUES',
  'UPDATE','SET','DELETE','CREATE','ALTER','DROP','TABLE','INDEX','VIEW',
  'IF','EXISTS','PRIMARY','KEY','FOREIGN','REFERENCES','DEFAULT','CASE',
  'WHEN','THEN','ELSE','END','WITH','CAST','BETWEEN','LIKE','ILIKE',
];

const JS_KEYWORDS = [
  'async','await','break','case','catch','class','const','continue','debugger',
  'default','delete','do','else','export','extends','finally','for','from',
  'function','if','import','in','instanceof','let','new','of','return',
  'switch','this','throw','try','typeof','var','void','while','with','yield',
  'true','false','null','undefined',
];

const JS_BUILTINS = [
  'axios','console','Math','JSON','Object','Array','Promise','Date','Number',
  'String','Boolean','Error','Map','Set','parseInt','parseFloat','fetch',
];

const PY_KEYWORDS = [
  'and','as','assert','async','await','break','class','continue','def','del',
  'elif','else','except','finally','for','from','global','if','import','in',
  'is','lambda','nonlocal','not','or','pass','raise','return','try','while',
  'with','yield','True','False','None',
];

const PY_BUILTINS = [
  'print','len','range','list','dict','tuple','set','str','int','float',
  'bool','open','enumerate','zip','map','filter','sorted','sum','min','max',
  'abs','any','all','isinstance','type','pd','np',
];

// Escape regex metacharacters in a string.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a tokenizer result from a pre-assembled list of patterns. Each
// pattern entry is { re, type }. The tokenizer scans left-to-right, taking
// the earliest match on each step; unmatched characters become `base` tokens.
const tokenize = (source, patterns) => {
  const out = [];
  let i = 0;
  const L = source.length;
  while (i < L) {
    let best = null;
    for (const p of patterns) {
      p.re.lastIndex = i;
      const m = p.re.exec(source);
      if (m && m.index === i && (best === null || m[0].length > best.match[0].length)) {
        best = { match: m, type: p.type };
      }
    }
    if (best) {
      out.push({ type: best.type, text: best.match[0] });
      i += best.match[0].length;
    } else {
      // No pattern matched — capture a single character as base text and
      // merge it with the previous base run to keep the node count low.
      const ch = source[i++];
      if (out.length && out[out.length - 1].type === 'base') {
        out[out.length - 1].text += ch;
      } else {
        out.push({ type: 'base', text: ch });
      }
    }
  }
  return out;
};

const buildPatterns = ({ keywords = [], builtins = [], comments = [] }) => {
  const pats = [];
  // Comments first so `--` / `//` / `#` beat operators.
  for (const c of comments) pats.push({ re: c, type: 'comment' });
  // Strings: single, double, and (for JS) template literals. Allow escapes.
  pats.push({ re: /'(?:\\.|[^'\\])*'/gy, type: 'string' });
  pats.push({ re: /"(?:\\.|[^"\\])*"/gy, type: 'string' });
  pats.push({ re: /`(?:\\.|[^`\\])*`/gy, type: 'string' });
  // Numbers (int, float, scientific, hex).
  pats.push({ re: /0x[0-9a-fA-F]+|\d+\.\d+(?:[eE][+-]?\d+)?|\d+/gy, type: 'number' });
  // Keywords — longest first so multi-word SQL (e.g. GROUP BY) beats GROUP.
  const kwSorted = [...keywords].sort((a, b) => b.length - a.length);
  if (kwSorted.length) {
    const kwRx = new RegExp(`(?:${kwSorted.map(rx).join('|')})\\b`, 'giy');
    pats.push({ re: kwRx, type: 'keyword' });
  }
  if (builtins.length) {
    const biRx = new RegExp(`(?:${builtins.map(rx).join('|')})\\b`, 'gy');
    pats.push({ re: biRx, type: 'builtin' });
  }
  // Punctuation / operators — a short set, to give punctuation a slightly
  // dimmer shade than base text.
  pats.push({ re: /[{}()\[\];,.:<>=!+\-*/%&|^~?]/gy, type: 'punct' });
  return pats;
};

const PATTERNS_BY_LANG = {
  sql: buildPatterns({
    keywords: SQL_KEYWORDS,
    comments: [/--[^\n]*/gy, /\/\*[\s\S]*?\*\//gy],
  }),
  javascript: buildPatterns({
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    comments: [/\/\/[^\n]*/gy, /\/\*[\s\S]*?\*\//gy],
  }),
  python: buildPatterns({
    keywords: PY_KEYWORDS,
    builtins: PY_BUILTINS,
    comments: [/#[^\n]*/gy],
  }),
  json: buildPatterns({
    keywords: ['true', 'false', 'null'],
  }),
};

const highlight = (code, lang) => {
  const patterns = PATTERNS_BY_LANG[lang];
  if (!patterns) return [{ type: 'base', text: code }];
  return tokenize(code, patterns);
};

/**
 * Dark-themed code block. Keeps formatting intact and scrolls horizontally
 * on long lines rather than wrapping, which preserves readability for SQL
 * and JS.
 */
export const CodeBlock = ({ code, lang = 'text' }) => {
  const tokens = highlight(String(code ?? ''), lang);
  return (
    <div
      style={{
        background: '#0f172a',
        borderRadius: 5,
        padding: '10px 12px',
        fontFamily: MONO,
        fontSize: 10.5,
        color: TOKEN_COLORS.base,
        lineHeight: 1.7,
        overflowX: 'auto',
        whiteSpace: 'pre',
        maxHeight: 220,
        overflowY: 'auto',
      }}
      data-lang={lang}
    >
      {tokens.map((t, i) => (
        <span key={i} style={{ color: TOKEN_COLORS[t.type] || TOKEN_COLORS.base }}>
          {t.text}
        </span>
      ))}
    </div>
  );
};

/**
 * Expandable "View/Hide CODE" rows that slot in at the bottom of a node
 * card. Mirrors the redesign NodeCard pattern: one collapsed row per code
 * type, each independently toggleable.
 */
export const ExpandableCodes = ({ codes }) => {

  const [open, setOpen] = useState({});
  if (!codes || codes.length === 0) return null;

  return (
    <div>
      {codes.map((c, ci) => {
        const isOpen = !!open[c.type];
        return (
          <div
            key={`${c.type}-${ci}`}
            style={{ borderTop: '1px solid #f0f2f5' }}
          >
            <div
              onClick={(e) => {
                e.stopPropagation();
                setOpen((p) => ({ ...p, [c.type]: !p[c.type] }));
              }}
              className="nodrag"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                cursor: 'pointer',
                background: isOpen ? SURFACE : 'transparent',
                transition: 'background 0.15s',
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: SURFACE,
                  border: `1px solid ${BORDER}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <CodeOutlined style={{ fontSize: 8 }} />
              </div>
              <span
                style={{
                  fontSize: 9,
                  fontFamily: MONO,
                  fontWeight: 700,
                  letterSpacing: '0.07em',
                  color: MUTED,
                  textTransform: 'uppercase',
                }}
              >
                {c.type}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: DIM,
                  display: 'inline-block',
                  transform: isOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s',
                }}
              >
                ▾
              </span>
            </div>
            {isOpen && (
              <div
                style={{ padding: '0 6px 6px' }}
                onClick={(e) => e.stopPropagation()}
                className="nodrag nowheel"
              >
                <CodeBlock code={c.content} lang={c.lang} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
