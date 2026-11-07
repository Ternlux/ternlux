/**
 * Turning bridge and assistant output into Slack mrkdwn.
 * https://docs.slack.dev/messaging/formatting-message-text
 *
 * Slack's markup is not Markdown: *bold*, _italic_, ~strike~, `code`,
 * ```blocks```, <url|text> links, and & < > must be escaped as entities.
 */

const SECTION_MAX = 2900; // Slack's section text limit is 3000

const escapeMrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Markdown inline syntax → mrkdwn, on text that is already escaped and has no code in it.
function inline(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '\u0000b$1\u0000b')
    .replace(/__([^_\n]+)__/g, '\u0000b$1\u0000b')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1_$2_')
    .replace(/\u0000b/g, '*')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
}

function markdownToMrkdwn(md) {
  const parts = String(md || '').split(/```[a-zA-Z0-9_-]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `\`\`\`${escapeMrkdwn(part.replace(/\n$/, ''))}\`\`\``;
    // Inline code is left exactly as written; everything around it converted.
    return part.split(/(`[^`\n]+`)/).map((seg) => {
      if (/^`[^`\n]+`$/.test(seg)) return `\`${escapeMrkdwn(seg.slice(1, -1))}\``;
      return escapeMrkdwn(seg).split('\n').map((line) => {
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) return `*${inline(heading[1])}*`;
        return inline(line.replace(/^(\s*)[-*]\s+/, '$1• '));
      }).join('\n');
    }).join('');
  }).join('');
}

// Lines of styled spans (see public/messaging/bridge.js) → mrkdwn.
function renderSpan(span) {
  if (typeof span === 'string') return escapeMrkdwn(span);
  if (span.b !== undefined) return `*${escapeMrkdwn(span.b)}*`;
  if (span.i !== undefined) return `_${escapeMrkdwn(span.i)}_`;
  if (span.code !== undefined) return `\`${escapeMrkdwn(span.code)}\``;
  return '';
}
const renderLines = (lines) => lines.map((l) => (Array.isArray(l) ? l.map(renderSpan).join('') : renderSpan(l))).join('\n');

// Split mrkdwn into section-sized pieces on line boundaries.
function splitForSections(text, max = SECTION_MAX) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

const sections = (text) => splitForSections(text).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));

module.exports = { escapeMrkdwn, markdownToMrkdwn, renderLines, splitForSections, sections, SECTION_MAX };
