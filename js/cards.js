// Flashcards: card files, unlocking by session progress, review state and rendering.
//
// Card files live in any "flashcards/" folder of the repository as Anki-compatible
// TSV (front \t back \t tags, with optional "#deck:..." header lines). Cards of a
// session file (e.g. S003.tsv) unlock when that session is ticked in the
// PROGRESS.md next to the folder; other files (ERR-..., HL-..., legacy EVID-...)
// are always on. Review state is stored in "<folder>/progress.json" and synced
// like annotations.

import { fsrs, generatorParameters, createEmptyCard, Rating, State } from '../vendor/ts-fsrs/ts-fsrs.mjs';
import { dirName, storage } from './util.js?v=424474b999d1';

export { Rating, State };

export const CARD_FILE_RE = /(^|\/)flashcards\/[^/]+\.tsv$/i;
const SESSION_STEM_RE = /^[A-Z]\d{2,4}$/;
export const NEW_PER_DAY = 20;
const LEARN_AHEAD_MS = 20 * 60 * 1000;
const DAY_ROLLOVER_HOURS = 4;
const AUTO_SYNC_DELAY_MS = 45000; // reviews are frequent: batch them into fewer commits

export const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));

// ------------------------------------------------------------------ parsing

/** 53-bit string hash (cyrb53), used for stable card ids. */
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function unquote(field) {
  const f = field.trim();
  return f.length >= 2 && f.startsWith('"') && f.endsWith('"') ? f.slice(1, -1).replace(/""/g, '"') : f;
}

export function stemOf(path) {
  return path.split('/').pop().replace(/\.tsv$/i, '');
}

/** Parse an Anki-style TSV card file. Untrusted input: fields are length-capped. */
export function parseCardFile(text, path) {
  const stem = stemOf(path);
  let deck = '';
  const cards = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    if (!raw.trim()) continue;
    if (raw.startsWith('#')) {
      const m = raw.match(/^#deck:(.*)$/i);
      if (m) deck = m[1].trim().split('::').pop().slice(0, 40);
      continue;
    }
    const cols = raw.split('\t').map(unquote);
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    const front = cols[0].slice(0, 4000);
    let id = `c${hash(`${stem}\u0000${front}`)}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    cards.push({ id, path, stem, deck, front, back: cols[1].slice(0, 8000), tags: (cols[2] || '').slice(0, 200) });
  }
  return cards;
}

/** Rows of a PROGRESS.md table: [{done, id, title, link, track}]. */
export function parseProgress(text) {
  const rows = [];
  const re = /^\|\s*\[( |x|X)\]\s*\|\s*(?:\[([A-Za-z]+\d+)\]\(([^)\s]+)\)|([A-Za-z]+\d+))\s*\|\s*([^|]*)\|\s*([^|]*)\|/;
  let block = '';
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) block = h[1];
    const m = line.match(re);
    if (m) rows.push({ done: m[1] !== ' ', id: m[2] || m[4], link: m[3] || null, track: m[5].trim(), title: m[6].trim(), block });
  }
  return rows;
}

/** Return PROGRESS.md text with one session marked done or not done (or null if not found). */
export function setSessionDone(text, id, done) {
  const lines = text.split('\n');
  const re = new RegExp(`^\\|\\s*\\[( |x|X)\\]\\s*\\|\\s*(\\[${id}\\]\\([^)]*\\)|${id})\\s*\\|`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  lines[i] = lines[i].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}

/** Return PROGRESS.md text with one session ticked (or null if not found). */
export function tickSession(text, id) {
  const lines = text.split('\n');
  const re = new RegExp(`^\\|\\s*\\[ \\]\\s*\\|\\s*(\\[${id}\\]\\([^)]*\\)|${id})\\s*\\|`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  lines[i] = lines[i].replace('[ ]', '[x]');
  return lines.join('\n');
}

// ------------------------------------------------------------------ review state (synced document)

export function progressPath(dir) {
  return `${dir}/progress.json`;
}

function emptyProgress(dir) {
  return { version: 1, dir, cards: {}, days: {} };
}

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function sanitizeState(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^c[a-z0-9]{1,16}x*$/.test(s.id)) return null;
  if (!num(s.due, 0, 1e14) || !num(s.state, 0, 3) || !num(s.updatedAt, 0, 1e14)) return null;
  return {
    id: s.id,
    due: s.due,
    stability: num(s.stability, 0, 1e7) ? s.stability : 0,
    difficulty: num(s.difficulty, 0, 11) ? s.difficulty : 0,
    elapsed_days: num(s.elapsed_days, 0, 1e6) ? s.elapsed_days : 0,
    scheduled_days: num(s.scheduled_days, 0, 1e6) ? s.scheduled_days : 0,
    learning_steps: num(s.learning_steps, 0, 100) ? s.learning_steps : 0,
    reps: num(s.reps, 0, 1e6) ? Math.round(s.reps) : 0,
    lapses: num(s.lapses, 0, 1e6) ? Math.round(s.lapses) : 0,
    state: Math.round(s.state),
    last_review: num(s.last_review, 0, 1e14) ? s.last_review : null,
    updatedAt: s.updatedAt,
  };
}

function reviveProgress(raw, dir) {
  const doc = emptyProgress(dir);
  if (!raw || typeof raw !== 'object') return doc;
  const list = Array.isArray(raw.cards) ? raw.cards : Object.values(raw.cards || {});
  for (const item of list.slice(0, 100000)) {
    const s = sanitizeState(item);
    if (s) doc.cards[s.id] = s;
  }
  if (raw.days && typeof raw.days === 'object') {
    for (const [day, perDevice] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !perDevice || typeof perDevice !== 'object') continue;
      for (const [device, c] of Object.entries(perDevice)) {
        if (!/^[a-z0-9]{1,16}$/.test(device) || !c) continue;
        doc.days[day] ??= {};
        doc.days[day][device] = { reviews: num(c.reviews, 0, 1e6) ? c.reviews : 0, new: num(c.new, 0, 1e6) ? c.new : 0 };
      }
    }
  }
  return doc;
}

function mergeProgress(local, remote) {
  const out = emptyProgress(local.dir || remote.dir);
  for (const id of new Set([...Object.keys(local.cards), ...Object.keys(remote.cards)])) {
    const a = local.cards[id];
    const b = remote.cards[id];
    out.cards[id] = !a ? b : !b ? a : a.updatedAt >= b.updatedAt ? a : b;
  }
  for (const day of new Set([...Object.keys(local.days), ...Object.keys(remote.days)])) {
    out.days[day] = {};
    for (const device of new Set([...Object.keys(local.days[day] || {}), ...Object.keys(remote.days[day] || {})])) {
      const a = local.days[day]?.[device] || { reviews: 0, new: 0 };
      const b = remote.days[day]?.[device] || { reviews: 0, new: 0 };
      out.days[day][device] = { reviews: Math.max(a.reviews, b.reviews), new: Math.max(a.new, b.new) };
    }
  }
  return out;
}

const STATE_KEYS = ['id', 'due', 'state', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'last_review', 'updatedAt'];

function serializeProgress(doc) {
  const cards = Object.values(doc.cards)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => `    ${JSON.stringify(Object.fromEntries(STATE_KEYS.map((k) => [k, c[k] ?? null])))}`);
  const days = Object.keys(doc.days).sort().slice(-400);
  const dayLines = days.map((d) => `    ${JSON.stringify(d)}: ${JSON.stringify(doc.days[d])}`);
  return `{\n  "version": 1,\n  "cards": [\n${cards.join(',\n')}\n  ],\n  "days": {\n${dayLines.join(',\n')}\n  }\n}\n`;
}

export const progressCodec = {
  namespace: 'cards',
  autoDelay: AUTO_SYNC_DELAY_MS,
  path: progressPath,
  empty: emptyProgress,
  revive: reviveProgress,
  merge: mergeProgress,
  serialize: serializeProgress,
  isEmpty: (doc) => Object.keys(doc.cards).length === 0,
  toStorage: (doc) => ({ ...doc, cards: Object.values(doc.cards) }),
  message: () => 'reader: flashcard review',
};

// ------------------------------------------------------------------ scheduling helpers

export function deviceId() {
  let id = storage.get('learnreader:device');
  if (!id || !/^[a-z0-9]{1,16}$/.test(id)) {
    id = Math.random().toString(36).slice(2, 12);
    storage.set('learnreader:device', id);
  }
  return id;
}

/** Study day (rolls over at 04:00 local time), as YYYY-MM-DD. */
export function dayKey(t = Date.now()) {
  const d = new Date(t - DAY_ROLLOVER_HOURS * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** End of the current study day (next 04:00 local), in ms. */
export function endOfStudyDay(t = Date.now()) {
  const d = new Date(t - DAY_ROLLOVER_HOURS * 3600 * 1000);
  d.setHours(24 + DAY_ROLLOVER_HOURS, 0, 0, 0);
  return d.getTime();
}

export function toFsrsCard(s, now = new Date()) {
  if (!s || s.state === State.New) return createEmptyCard(now);
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  };
}

export function fromFsrsCard(id, c) {
  return {
    id,
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.getTime() : null,
    updatedAt: Date.now(),
  };
}

export function isNew(s) {
  return !s || s.state === State.New;
}

/** Is a card due for review now? Learning cards may be shown slightly early. */
export function isDue(s, now = Date.now()) {
  if (isNew(s)) return false;
  if (s.state === State.Review) return s.due <= endOfStudyDay(now);
  return s.due <= now + LEARN_AHEAD_MS;
}

export function newIntroducedToday(doc, now = Date.now()) {
  const day = doc.days[dayKey(now)] || {};
  return Object.values(day).reduce((sum, c) => sum + (c.new || 0), 0);
}

export function reviewsToday(doc, now = Date.now()) {
  const day = doc.days[dayKey(now)] || {};
  return Object.values(day).reduce((sum, c) => sum + (c.reviews || 0), 0);
}

export function humanInterval(ms) {
  const min = ms / 60000;
  if (min < 1) return '<1 min';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1).replace('.0', '')} y`;
}

// ------------------------------------------------------------------ safe rich-text rendering

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
const ALLOWED = { b: 'strong', strong: 'strong', i: 'em', em: 'em', code: 'code', u: 'u' };

/** Text with a tiny whitelist of inline tags (<b>, <i>, <code>, <u>, <br>); everything else is literal text. */
function appendText(parent, text) {
  const stack = [parent];
  for (const part of text.split(/(<\/?[a-z]+\s*\/?>)/i)) {
    if (!part) continue;
    const m = part.match(/^<(\/)?([a-z]+)\s*(\/)?>$/i);
    const tag = m?.[2].toLowerCase();
    if (m && tag === 'br') {
      stack[stack.length - 1].append(document.createElement('br'));
    } else if (m && ALLOWED[tag]) {
      if (m[1]) {
        if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === ALLOWED[tag]) stack.pop();
      } else {
        const node = document.createElement(ALLOWED[tag]);
        stack[stack.length - 1].append(node);
        stack.push(node);
      }
    } else {
      stack[stack.length - 1].append(document.createTextNode(decodeEntities(part)));
    }
  }
}

let katex = null;

/** Load KaTeX on demand (600 KB): only when flashcards are actually shown. */
export async function loadMath() {
  katex ??= (await import('../vendor/katex/katex.mjs')).default;
}

/**
 * Render card text with LaTeX (call loadMath() first): \( inline \), \[ display \], $$ display $$.
 * KaTeX runs with trust: false (no \href, \url, \includegraphics or raw HTML).
 */
const KATEX_OPTIONS = { throwOnError: false, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml' };

/** A rendered formula (inline span or display div). Requires loadMath(). */
export function mathNode(tex, display) {
  const node = document.createElement(display ? 'div' : 'span');
  node.className = display ? 'math-display' : 'math-inline';
  if (!katex) {
    node.textContent = tex; // KaTeX not loaded: show the source rather than nothing
    return node;
  }
  katex.render(tex, node, { ...KATEX_OPTIONS, displayMode: display });
  return node;
}

export function renderRich(container, text) {
  container.replaceChildren();
  const re = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    appendText(container, text.slice(last, m.index));
    container.append(mathNode(decodeEntities(m[1] ?? m[2] ?? m[3]), m[1] === undefined));
    last = m.index + m[0].length;
  }
  appendText(container, text.slice(last));
}

// ------------------------------------------------------------------ loading decks from the repository

/**
 * Load all card files and session progress. Text of each file is cached by
 * blob sha, so only changed files are downloaded.
 * Returns {cards, locked, dirs: [{dir, progressFile, rows}]}.
 */
/** Text of a repository file, cached on the device by blob sha (only changed files are downloaded). */
export async function readText(gh, file) {
  const key = `learnreader:text:${file.sha}`;
  const cached = storage.get(key);
  if (typeof cached === 'string') return cached;
  const remote = await gh.getTextFile(file.path);
  const text = remote?.text ?? '';
  storage.set(key, text);
  return text;
}

export async function loadDecks(gh, allFiles) {
  const cardFiles = allFiles.filter((f) => CARD_FILE_RE.test(f.path));
  const dirs = [...new Set(cardFiles.map((f) => dirName(f.path)))];
  const readCached = (file) => readText(gh, file);
  const out = { cards: [], locked: 0, dirs: [] };
  for (const dir of dirs) {
    const parent = dirName(dir);
    const progressFile = allFiles.find((f) => f.path === (parent ? `${parent}/PROGRESS.md` : 'PROGRESS.md')) || null;
    const rows = progressFile ? parseProgress(await readCached(progressFile)) : [];
    const done = new Set(rows.filter((r) => r.done).map((r) => r.id));
    out.dirs.push({ dir, progressFile, rows });
    for (const file of cardFiles.filter((f) => dirName(f.path) === dir)) {
      const cards = parseCardFile(await readCached(file), file.path).map((c) => ({ ...c, dir }));
      const stem = stemOf(file.path);
      if (SESSION_STEM_RE.test(stem) && !done.has(stem)) out.locked += cards.length;
      else out.cards.push(...cards);
    }
  }
  return out;
}
