/**
 * Turning chat-assistant output into Telegram messages.
 *
 * The assistant writes Markdown. Telegram's HTML mode is the forgiving one
 * (MarkdownV2 rejects a message over a single unescaped "."), so answers are
 * converted to the small HTML subset Telegram accepts: b, i, code, pre, a.
 */

const MAX_MESSAGE = 4096;
// Room for the HTML a chunk gains in conversion.
const CHUNK_SOURCE = 3500;

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline Markdown → Telegram HTML, on text that is already escaped.
function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToTelegramHtml(md) {
  const out = [];
  const parts = String(md || '').split(/```[a-zA-Z0-9_-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre>${escapeHtml(part.replace(/\n$/, ''))}</pre>`);
      return;
    }
    const lines = escapeHtml(part).split('\n').map((line) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return `<b>${inline(heading[1])}</b>`;
      return inline(line.replace(/^(\s*)[-*]\s+/, '$1• '));
    });
    out.push(lines.join('\n'));
  });
  return out.join('');
}

/**
 * Split Markdown into pieces that each fit one Telegram message after
 * conversion, preferring paragraph, then line, boundaries. A code fence is
 * never left open across a split.
 */
function chunkMarkdown(md, limit = CHUNK_SOURCE) {
  const text = String(md || '').trim();
  if (text.length <= limit) return text ? [text] : [];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    let piece = rest.slice(0, cut);
    // An odd number of fences means a code block is open: close it here and
    // reopen it in the next piece.
    const reopen = (piece.match(/```/g) || []).length % 2 === 1;
    if (reopen) piece += '\n```';
    chunks.push(piece.trim());
    rest = (reopen ? '```\n' : '') + rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A table visual ({ columns, data }) as CSV.
function tableToCsv(visual) {
  const columns = visual.columns || Object.keys((visual.data || [])[0] || {});
  const rows = (visual.data || []).map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [columns.map(csvCell).join(','), ...rows].join('\n');
}

// The first few rows of a table, as a monospace block for the chat itself.
function tablePreview(visual, maxRows = 8, maxWidth = 18) {
  const columns = (visual.columns || Object.keys((visual.data || [])[0] || {})).slice(0, 5);
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return s.length > maxWidth ? `${s.slice(0, maxWidth - 1)}…` : s;
  };
  const rows = (visual.data || []).slice(0, maxRows).map((r) => columns.map((c) => cell(r[c])));
  const widths = columns.map((c, i) => Math.max(cell(c).length, ...rows.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map(cell)), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

module.exports = {
  MAX_MESSAGE, escapeHtml, markdownToTelegramHtml, chunkMarkdown, tableToCsv, tablePreview,
};
