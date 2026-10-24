// Safe Markdown renderer for the study material (CommonMark/GFM subset).
//
// The output is built with DOM APIs only: text is never parsed as HTML, so a
// tampered file cannot inject markup or scripts. Math ($…$, $$…$$, \(…\), \[…\])
// is rendered with KaTeX (trust: false). Supported: headings, paragraphs,
// emphasis, inline code, fenced code, links, ordered/unordered nested lists,
// GFM tables, blockquotes, horizontal rules.

import { mathNode } from './cards.js?v=333a97a613c7';

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/**
 * @param {string} text  Markdown source
 * @param {object} opts
 *   resolveLink(href) -> {href, external} | null   (null: render as plain text)
 *   anchor(block) -> optional hook to decorate blocks (checklists): called with
 *     {type, node, text} for headings and paragraphs
 */
export function renderMarkdown(text, opts = {}) {
  const root = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  renderBlocks(lines, root, opts);
  return root;
}

// ------------------------------------------------------------------ blocks

const RE = {
  fence: /^\s*(```|~~~)\s*([\w+-]*)\s*$/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*>\s?(.*)$/,
  list: /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  mathOpen: /^\s*\$\$/,
};

function isBlockStart(line, next) {
  return (
    RE.fence.test(line) ||
    RE.heading.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    RE.list.test(line) ||
    (line.includes('|') && next !== undefined && RE.tableSep.test(next))
  );
}

function renderBlocks(lines, parent, opts) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    // fenced code
    if ((m = line.match(RE.fence))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      const code = document.createElement('code');
      if (m[2]) code.className = `lang-${m[2].replace(/[^\w-]/g, '')}`;
      code.textContent = body.join('\n');
      const pre = document.createElement('pre');
      pre.append(code);
      parent.append(pre);
      continue;
    }
    // heading
    if ((m = line.match(RE.heading))) {
      const h = document.createElement(`h${m[1].length}`);
      appendInline(h, m[2], opts);
      h.id = slug(h.textContent);
      parent.append(h);
      opts.anchor?.({ type: 'heading', level: m[1].length, node: h, text: m[2] });
      i++;
      continue;
    }
    // horizontal rule
    if (RE.hr.test(line)) {
      parent.append(document.createElement('hr'));
      i++;
      continue;
    }
    // display math block spanning lines: $$ ... $$
    if (RE.mathOpen.test(line) && !/\$\$.*\$\$/.test(line.trim())) {
      const body = [line.replace(/^\s*\$\$/, '')];
      i++;
      while (i < lines.length && !lines[i].includes('$$')) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i++].replace(/\$\$\s*$/, ''));
      parent.append(mathNode(body.join('\n'), true));
      continue;
    }
    // blockquote
    if (RE.quote.test(line)) {
      const inner = [];
      while (i < lines.length && RE.quote.test(lines[i])) inner.push(lines[i++].match(RE.quote)[1]);
      const bq = document.createElement('blockquote');
      renderBlocks(inner, bq, opts);
      parent.append(bq);
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      parent.append(renderTable(rows, opts));
      continue;
    }
    // list
    if (RE.list.test(line)) {
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // a blank line ends the list unless an indented continuation follows
          if (i + 1 < lines.length && (RE.list.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
            i++;
            continue;
          }
          break;
        }
        if (!RE.list.test(l) && !/^\s+/.test(l) && block.length && isBlockStart(l, lines[i + 1])) break;
        block.push(l);
        i++;
      }
      parent.append(renderList(block, opts));
      continue;
    }
    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++]);
    const p = document.createElement('p');
    const text = para.join('\n');
    appendInline(p, text, opts);
    parent.append(p);
    opts.anchor?.({ type: 'paragraph', node: p, text });
  }
}

function renderList(lines, opts) {
  // Build a tree from indentation.
  const items = [];
  for (const line of lines) {
    const m = line.match(RE.list);
    if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: [m[3]], children: [] });
    else if (items.length) items[items.length - 1].text.push(line.trim());
  }
  const build = (start, end, baseIndent) => {
    const ordered = items[start]?.ordered;
    const list = document.createElement(ordered ? 'ol' : 'ul');
    let k = start;
    while (k < end) {
      const item = items[k];
      let j = k + 1;
      while (j < end && items[j].indent > item.indent) j++;
      const li = document.createElement('li');
      appendInline(li, item.text.join('\n'), opts);
      if (j > k + 1) li.append(build(k + 1, j, items[k + 1].indent));
      list.append(li);
      k = j;
    }
    return list;
  };
  return build(0, items.length, items[0]?.indent ?? 0);
}

function splitRow(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  // split on pipes that are not escaped and not inside $…$ or `…`
  const cells = [];
  let cur = '';
  let inMath = false;
  let inCode = false;
  for (let k = 0; k < r.length; k++) {
    const ch = r[k];
    if (ch === '\\' && r[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '$' && !inCode) inMath = !inMath;
    if (ch === '|' && !inMath && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(rows, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    for (const cell of splitRow(row)) {
      const td = document.createElement(idx === 0 ? 'th' : 'td');
      appendInline(td, cell, opts);
      tr.append(td);
    }
    (idx === 0 ? thead : tbody).append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

// ------------------------------------------------------------------ inline

const INLINE = [
  { type: 'code', re: /`([^`]+)`/ },
  { type: 'dmath', re: /\$\$([\s\S]+?)\$\$/ },
  { type: 'dmath', re: /\\\[([\s\S]+?)\\\]/ },
  { type: 'imath', re: /\\\(([\s\S]+?)\\\)/ },
  { type: 'imath', re: /(?<![\\$\w])\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?![\w$])/ },
  { type: 'link', re: /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  { type: 'strong', re: /\*\*([\s\S]+?)\*\*/ },
  { type: 'em', re: /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/ },
  { type: 'br', re: / {2,}\n/ },
];

function appendInline(parent, text, opts) {
  let rest = text;
  while (rest) {
    let best = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { p, m };
    }
    if (!best) {
      parent.append(document.createTextNode(unescape(rest.replace(/\n/g, ' '))));
      break;
    }
    const { p, m } = best;
    if (m.index > 0) parent.append(document.createTextNode(unescape(rest.slice(0, m.index).replace(/\n/g, ' '))));
    switch (p.type) {
      case 'code': {
        const c = document.createElement('code');
        c.textContent = m[1];
        parent.append(c);
        break;
      }
      case 'dmath':
        parent.append(mathNode(m[1], true));
        break;
      case 'imath':
        parent.append(mathNode(m[1], false));
        break;
      case 'link': {
        const target = safeLink(m[2], opts);
        if (target) {
          const a = document.createElement('a');
          a.href = target.href;
          // Every content link opens in a new tab, so the page being studied stays open.
          a.target = '_blank';
          // App routes (same origin, always a "#..." hash) keep the opener: the browser then copies
          // sessionStorage, so a token kept only for this tab ("don't remember") works in the new tab.
          // Anything else is cut off from this window.
          a.rel = !target.external && target.href.startsWith('#') ? 'opener' : 'noopener noreferrer';
          appendInline(a, m[1], opts);
          parent.append(a);
        } else {
          const span = document.createElement('span');
          appendInline(span, m[1], opts);
          parent.append(span);
        }
        break;
      }
      case 'strong': {
        const s = document.createElement('strong');
        appendInline(s, m[1], opts);
        parent.append(s);
        break;
      }
      case 'em': {
        const e = document.createElement('em');
        appendInline(e, m[1], opts);
        parent.append(e);
        break;
      }
      case 'br':
        parent.append(document.createElement('br'));
        break;
    }
    rest = rest.slice(m.index + m[0].length);
  }
}

function unescape(s) {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!$|>])/g, '$1');
}

function safeLink(href, opts) {
  const resolved = opts.resolveLink ? opts.resolveLink(href) : null;
  if (resolved === null) return null;
  const candidate = resolved || { href, external: true };
  try {
    const url = new URL(candidate.href, location.href);
    if (candidate.href.startsWith('#')) return candidate;
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) return null;
    return { href: url.href, external: candidate.external !== false };
  } catch {
    return null;
  }
}

/** Inline Markdown (emphasis, code, math, links) as a fragment. */
export function renderInline(text, opts = {}) {
  const frag = document.createDocumentFragment();
  appendInline(frag, text, opts);
  return frag;
}

/** First sentence of a Markdown snippet, cut at most around `max` chars, never inside $…$ or `…`. */
export function summarizeMarkdown(text, max = 90) {
  const s = text.replace(/\s+/g, ' ').trim();
  let inMath = false;
  let inCode = false;
  let lastSpace = -1;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '`' && !inMath) inCode = !inCode;
    else if (ch === '$' && !inCode && s[k + 1] !== '$') inMath = !inMath;
    if (inMath || inCode) continue;
    if ((ch === '.' || ch === '?' || ch === ':') && (s[k + 1] === ' ' || k === s.length - 1) && k > 15) return s.slice(0, k + 1);
    if (ch === ' ') lastSpace = k;
    if (k >= max && lastSpace > 20) return `${s.slice(0, lastSpace)} …`;
  }
  return s;
}

export function slug(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Normalize "a/b/../c" paths (no leading slash). */
export function joinPath(base, rel) {
  const parts = (base ? `${base}/${rel}` : rel).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}
