// Study path inside the app: progress overview, session pages with checklists,
// solutions on demand, error log. Nothing here requires opening GitHub.
//
// Progress of sessions is PROGRESSI.md (ticked rows). Checklists, custom items
// and the error log are stored in "<base>/stato.json" (synced like annotations).

import { el, dirName, storage, toast, uid } from './util.js';
import { loadMath, parseProgress, readText, setSessionDone } from './cards.js';
import { joinPath, renderInline, renderMarkdown, summarizeMarkdown } from './markdown.js';

const SESSION_ID = /^[A-Z]\d{2,4}$/;
const KEY_RE = /^[A-Za-z0-9-]{1,24}$/;
const ID_RE = /^[a-z0-9]{4,24}$/;
const APP_BASES = [
  `${location.origin}${location.pathname}`,
  'https://perruccio-learn.github.io/Learn-app/',
  'https://perruccio.github.io/Learn-app/',
];

// ------------------------------------------------------------------ synced state document

const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e14;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function emptyState(base) {
  return { version: 1, base, sessions: {}, errors: {} };
}

function reviveState(raw, base) {
  const doc = emptyState(base);
  if (!raw || typeof raw !== 'object') return doc;
  for (const [sid, s] of Object.entries(raw.sessions || {})) {
    if (!SESSION_ID.test(sid) || !s || typeof s !== 'object') continue;
    const out = { checks: {}, custom: {} };
    for (const [k, c] of Object.entries(s.checks || {})) {
      if (KEY_RE.test(k) && c && num(c.updatedAt)) out.checks[k] = { done: c.done === true, updatedAt: c.updatedAt };
    }
    for (const [id, c] of Object.entries(s.custom || {})) {
      if (!ID_RE.test(id) || !c || !num(c.updatedAt)) continue;
      out.custom[id] = c.deleted === true
        ? { deleted: true, updatedAt: c.updatedAt }
        : { text: str(c.text, 300), done: c.done === true, createdAt: num(c.createdAt) ? c.createdAt : 0, updatedAt: c.updatedAt };
    }
    doc.sessions[sid] = out;
  }
  for (const [id, e] of Object.entries(raw.errors || {})) {
    if (!ID_RE.test(id) || !e || !num(e.updatedAt)) continue;
    doc.errors[id] = e.deleted === true
      ? { deleted: true, updatedAt: e.updatedAt }
      : {
          session: SESSION_ID.test(e.session) ? e.session : '',
          text: str(e.text, 2000),
          fix: str(e.fix, 2000),
          card: e.card === true,
          createdAt: num(e.createdAt) ? e.createdAt : 0,
          updatedAt: e.updatedAt,
        };
  }
  return doc;
}

const newer = (a, b) => (!a ? b : !b ? a : a.updatedAt >= b.updatedAt ? a : b);

function mergeState(a, b) {
  const out = emptyState(a.base || b.base);
  for (const sid of new Set([...Object.keys(a.sessions), ...Object.keys(b.sessions)])) {
    const x = a.sessions[sid] || { checks: {}, custom: {} };
    const y = b.sessions[sid] || { checks: {}, custom: {} };
    const s = { checks: {}, custom: {} };
    for (const k of new Set([...Object.keys(x.checks), ...Object.keys(y.checks)])) s.checks[k] = newer(x.checks[k], y.checks[k]);
    for (const k of new Set([...Object.keys(x.custom), ...Object.keys(y.custom)])) s.custom[k] = newer(x.custom[k], y.custom[k]);
    out.sessions[sid] = s;
  }
  for (const k of new Set([...Object.keys(a.errors), ...Object.keys(b.errors)])) out.errors[k] = newer(a.errors[k], b.errors[k]);
  return out;
}

function sortKeys(value) {
  if (Array.isArray(value) || !value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

export const stateCodec = {
  namespace: 'state',
  autoDelay: 6000,
  path: (base) => (base ? `${base}/stato.json` : 'stato.json'),
  empty: emptyState,
  revive: reviveState,
  merge: mergeState,
  serialize: (doc) => `${JSON.stringify(sortKeys({ version: 1, sessions: doc.sessions, errors: doc.errors }), null, 2)}\n`,
  isEmpty: (doc) => !Object.keys(doc.sessions).length && !Object.keys(doc.errors).length,
  toStorage: (doc) => doc,
  message: () => 'reader: avanzamento sessioni',
};

// ------------------------------------------------------------------ helpers

function plain(markdown) {
  return markdown
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')
    .replace(/\*\*|`|\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function progressBar(fraction, label) {
  return el(
    'div',
    { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(fraction * 100)), 'aria-label': label },
    el('span', { style: { width: `${Math.round(fraction * 100)}%` } }),
  );
}

function checkbox(checked, label, onToggle) {
  return el(
    'button',
    {
      type: 'button',
      class: 'chk',
      role: 'checkbox',
      'aria-checked': String(checked),
      'aria-label': label,
      title: checked ? 'Fatto' : 'Da fare',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      },
    },
  );
}

// ------------------------------------------------------------------ the course controller

export class Course {
  constructor({ gh, cfg, state, onChanged }) {
    this.gh = gh;
    this.cfg = cfg;
    this.state = state; // SyncManager with stateCodec
    this.onChanged = onChanged;
    this.allFiles = [];
    this.view = null; // {path, sid, base, items, ...}
    state.addEventListener('change', (e) => {
      if (this.view && e.detail.book === this.view.base) this._refreshChecks();
    });
  }

  setFiles(allFiles) {
    this.allFiles = allFiles || [];
  }

  file(path) {
    return this.allFiles.find((f) => f.path === path) || null;
  }

  /** All progress tables: [{base, path, rows}]. */
  async tables() {
    const out = [];
    for (const f of this.allFiles.filter((x) => /(^|\/)PROGRESSI\.md$/.test(x.path))) {
      out.push({ base: dirName(f.path), path: f.path, rows: parseProgress(await readText(this.gh, f)) });
    }
    return out;
  }

  sessionStats(base, sid, total = null) {
    const s = this.state.load(base).doc.sessions[sid];
    if (!s) return { done: 0, total: total ?? 0 };
    const customs = Object.values(s.custom).filter((c) => !c.deleted);
    const doneChecks = Object.values(s.checks).filter((c) => c.done).length;
    return { done: doneChecks + customs.filter((c) => c.done).length, customTotal: customs.length };
  }

  appLink(href) {
    for (const baseUrl of APP_BASES) if (href.startsWith(baseUrl)) return href.slice(baseUrl.length) || '#';
    return null;
  }

  resolver(currentPath) {
    const dir = dirName(currentPath);
    const { owner, repo, branch } = this.cfg;
    return (href) => {
      if (/^https?:/i.test(href)) {
        const internal = this.appLink(href);
        return internal ? { href: internal.startsWith('#') ? internal : `#${internal}`, external: false } : { href, external: true };
      }
      if (/^mailto:/i.test(href)) return { href, external: true };
      if (href.startsWith('#')) return { href: `#doc=${encodeURIComponent(currentPath)}`, external: false };
      if (/^[a-z]+:/i.test(href)) return null; // any other scheme: plain text
      const path = joinPath(dir, href.split('#')[0]);
      if (/\.md$/i.test(path)) return { href: `#doc=${path}`, external: false };
      if (/\.pdf$/i.test(path)) return { href: `#read=${path}`, external: false };
      if (/\.ipynb$/i.test(path)) return { href: `https://colab.research.google.com/github/${owner}/${repo}/blob/${branch}/${path}`, external: true };
      return null;
    };
  }

  // ------------------------------------------------------------------ progress view

  async renderProgress(container) {
    container.replaceChildren(el('p', { class: 'muted' }, 'Carico il percorso…'));
    const tables = await this.tables();
    if (!tables.length) {
      container.replaceChildren(el('p', { class: 'muted' }, 'Nessun PROGRESSI.md nel repository.'));
      return;
    }
    const nodes = [];
    for (const t of tables) {
      const rows = t.rows;
      const done = rows.filter((r) => r.done).length;
      const tracks = {};
      for (const r of rows) {
        const k = (r.track.match(/^[A-Z]{2}/) || ['Misto'])[0];
        tracks[k] ??= { done: 0, total: 0 };
        tracks[k].total++;
        if (r.done) tracks[k].done++;
      }
      const state = this.state.load(t.base).doc;
      const errorsOpen = Object.values(state.errors).filter((e) => !e.deleted && !e.card).length;
      nodes.push(
        el(
          'section',
          { class: 'panel-card progress-summary' },
          el('div', { class: 'panel-card-head' }, el('span', { class: 'eyebrow' }, t.base || 'Percorso')),
          el('p', { class: 'review-counts' }, el('span', { class: 'big' }, String(done)), ` di ${rows.length} sessioni completate`),
          progressBar(rows.length ? done / rows.length : 0, 'Avanzamento totale'),
          el(
            'div',
            { class: 'track-bars' },
            Object.entries(tracks).map(([k, v]) =>
              el('div', { class: 'track-row' }, el('span', { class: 'track-name' }, k), progressBar(v.done / v.total, k), el('span', { class: 'track-num' }, `${v.done}/${v.total}`)),
            ),
          ),
          errorsOpen ? el('p', { class: 'muted small' }, `${errorsOpen} errori annotati da trasformare in flashcard: chiedi a Claude «fammi le flashcard dagli errori».`) : null,
        ),
      );
      const blocks = [...new Set(rows.map((r) => r.block))];
      for (const b of blocks) {
        nodes.push(
          el(
            'section',
            { class: 'block' },
            el('h2', { class: 'lib-group-title' }, b || 'Sessioni'),
            el(
              'ul',
              { class: 'session-list' },
              rows
                .filter((r) => r.block === b)
                .map((r) => {
                  const path = r.link ? joinPath(t.base, r.link) : null;
                  const available = path && this.file(path);
                  const st = this.state.load(t.base).doc.sessions[r.id];
                  const started = st && (Object.values(st.checks).some((c) => c.done) || Object.values(st.custom).some((c) => c.done && !c.deleted));
                  const status = r.done ? 'done' : started ? 'started' : 'todo';
                  const label = { done: 'Completata', started: 'In corso', todo: available ? 'Da fare' : 'In preparazione' }[status];
                  const inner = [
                    el('span', { class: `status-dot s-${status}`, title: label, 'aria-label': label }),
                    el('span', { class: 'session-id' }, r.id),
                    el('span', { class: 'session-title' }, r.title, el('span', { class: 'session-track' }, r.track)),
                    el('span', { class: 'session-state' }, label),
                  ];
                  return el('li', {}, available ? el('a', { class: 'session-row', href: `#doc=${path}` }, inner) : el('div', { class: 'session-row is-disabled' }, inner));
                }),
            ),
          ),
        );
      }
      const docs = [
        ['Metodo di studio', 'metodo/metodo.md'],
        ['Setup e strumenti', 'metodo/setup.md'],
        ['Risorse', 'metodo/risorse.md'],
        ['Roadmap · Algebra lineare', 'roadmap/LA-algebra-lineare.md'],
        ['Roadmap · Probabilità e processi', 'roadmap/PP-probabilita-processi.md'],
        ['Roadmap · Analisi funzionale', 'roadmap/AF-analisi-funzionale.md'],
        ['Roadmap · Statistica', 'roadmap/ST-statistica.md'],
      ].filter(([, p]) => this.file(joinPath(t.base, p)));
      if (docs.length) {
        nodes.push(
          el(
            'section',
            { class: 'block' },
            el('h2', { class: 'lib-group-title' }, 'Documenti'),
            el('ul', { class: 'doc-links' }, docs.map(([label, p]) => el('li', {}, el('a', { href: `#doc=${joinPath(t.base, p)}` }, label)))),
          ),
        );
      }
    }
    container.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------------ document / session view

  async renderDoc(container, path, { title }) {
    const file = this.file(path);
    if (!file) {
      container.replaceChildren(el('p', { class: 'form-error' }, `File non trovato: ${path}`));
      return;
    }
    container.replaceChildren(el('p', { class: 'muted' }, 'Carico…'));
    const [text] = await Promise.all([readText(this.gh, file), loadMath()]);
    const m = path.match(/(?:^|\/)sessioni\/([A-Z]\d{2,4})\.md$/);
    const sid = m ? m[1] : null;
    const base = sid ? dirName(dirName(path)) : null;
    const items = [];
    const anchors = new Map();

    const anchor = sid
      ? (block) => {
          let key = null;
          let label = null;
          let plainLabel = null;
          if (block.type === 'heading' && block.level === 2) {
            const h = block.text.match(/^(\d+)\s*·\s*(.+?)\s*(?:\((\d+)'\))?$/);
            if (h && !/esercizi/i.test(h[2])) {
              key = `H${h[1]}`;
              label = `${h[2]}${h[3] ? ` (${h[3]}')` : ''}`;
            }
          } else if (block.type === 'paragraph') {
            const t = block.text.trim();
            let x;
            if ((x = t.match(/^\*\*\[([A-Z]\d{0,2})\]\*\*\s*(.*)/s))) {
              key = x[1];
              label = `**[${x[1]}]** ${summarizeMarkdown(x[2])}`;
              plainLabel = `[${x[1]}] ${plain(x[2]).slice(0, 80)}`;
            } else if (/^\*\*Spiegati una dimostrazione/.test(t)) {
              key = 'SPIEGA';
              label = 'Dimostrazione spiegata riga per riga';
            } else if (/^\*\*A libro chiuso/.test(t)) {
              key = 'MEM';
              label = 'Definizioni ed enunciati riscritti a memoria';
            } else if (/^\*\*Dopo la sessione/.test(t)) {
              key = 'FINE';
              label = 'Errori annotati nel registro';
            }
          }
          if (!key || anchors.has(key)) return;
          items.push({ key, label, plainLabel: plainLabel || plain(label), node: block.node });
          anchors.set(key, block.node);
          block.node.classList.add('has-check');
          block.node.dataset.check = key;
        }
      : null;

    const body = el('article', { class: 'md' });
    body.append(renderMarkdown(text, { resolveLink: this.resolver(path), anchor }));
    const heading = body.querySelector('h1');
    title(heading ? heading.textContent : path.split('/').pop());

    if (!sid) {
      container.replaceChildren(body);
      this.view = null;
      return;
    }

    // Session page: header, checklist, content, end-of-session panel.
    this.view = { path, sid, base, items, body };
    const progressFile = this.file(base ? `${base}/PROGRESSI.md` : 'PROGRESSI.md');
    const row = progressFile ? parseProgress(await readText(this.gh, progressFile)).find((r) => r.id === sid) : null;
    this.view.row = row;
    this.view.progressPath = progressFile?.path;

    for (const it of items) it.node.prepend(checkbox(false, it.plainLabel, () => this.toggle(it.key)));

    const checklist = el('details', { class: 'panel-card checklist', id: 'checklist' });
    const remembered = storage.get('learnreader:checklistOpen');
    checklist.open = typeof remembered === 'boolean' ? remembered : window.matchMedia('(min-width: 900px)').matches;
    checklist.addEventListener('toggle', () => storage.set('learnreader:checklistOpen', checklist.open));
    const end = el('section', { class: 'panel-card session-end' });
    const solutionsPath = joinPath(dirName(dirName(path)), `soluzioni/${sid}.md`);
    const solutions = el('section', { class: 'solutions', hidden: true });
    container.replaceChildren(checklist, body, end, solutions);
    this.view.checklist = checklist;
    this.view.end = end;
    this.view.solutions = solutions;
    this.view.solutionsPath = this.file(solutionsPath) ? solutionsPath : null;
    this._refreshChecks();
  }

  toggle(key) {
    const v = this.view;
    if (!v) return;
    this.state.mutate(v.base, (d) => {
      const s = (d.sessions[v.sid] ??= { checks: {}, custom: {} });
      const cur = s.checks[key]?.done === true;
      s.checks[key] = { done: !cur, updatedAt: Date.now() };
    });
  }

  _custom(mutator) {
    const v = this.view;
    if (!v) return;
    this.state.mutate(v.base, (d) => {
      const s = (d.sessions[v.sid] ??= { checks: {}, custom: {} });
      mutator(s, d);
    });
  }

  /** Re-render every state-dependent part of the session page. */
  _refreshChecks() {
    const v = this.view;
    if (!v || !v.checklist?.isConnected) return;
    const doc = this.state.load(v.base).doc;
    const s = doc.sessions[v.sid] || { checks: {}, custom: {} };
    const isDone = (k) => s.checks[k]?.done === true;
    for (const it of v.items) {
      const box = it.node.querySelector(':scope > .chk');
      box?.setAttribute('aria-checked', String(isDone(it.key)));
      it.node.classList.toggle('is-checked', isDone(it.key));
    }
    // Keep what the user is typing across re-renders (e.g. when a sync brings remote changes).
    const typed = {
      add: v.checklist.querySelector('.add-input')?.value || '',
      what: v.end.querySelector('textarea[data-field="what"]')?.value || '',
      fix: v.end.querySelector('textarea[data-field="fix"]')?.value || '',
    };
    const customs = Object.entries(s.custom)
      .filter(([, c]) => !c.deleted)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const total = v.items.length + customs.length;
    const done = v.items.filter((it) => isDone(it.key)).length + customs.filter(([, c]) => c.done).length;

    // Checklist card
    const input = el('input', { type: 'text', class: 'add-input', placeholder: 'Aggiungi una voce (es. «rifare T3 domani»)', maxlength: '300', 'aria-label': 'Nuova voce' });
    input.value = typed.add;
    const add = () => {
      const text = input.value.trim();
      if (!text) return;
      const id = uid().replace(/[^a-z0-9]/g, '').slice(0, 20);
      input.value = '';
      this._custom((sess) => (sess.custom[id] = { text, done: false, createdAt: Date.now(), updatedAt: Date.now() }));
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
    v.checklist.replaceChildren(
      el(
        'summary',
        { class: 'checklist-summary' },
        el('div', { class: 'panel-card-head' }, el('span', { class: 'eyebrow' }, `Checklist · ${v.sid}`), el('span', { class: 'check-count' }, `${done}/${total}`)),
        progressBar(total ? done / total : 0, 'Avanzamento della sessione'),
      ),
      el(
        'ul',
        { class: 'check-list' },
        v.items.map((it) =>
          el(
            'li',
            { class: isDone(it.key) ? 'is-checked' : '' },
            checkbox(isDone(it.key), it.plainLabel, () => this.toggle(it.key)),
            el('a', { href: '#', class: 'check-label', onclick: (e) => (e.preventDefault(), it.node.scrollIntoView({ behavior: 'smooth', block: 'start' })) }, renderInline(it.label)),
          ),
        ),
        customs.map(([id, c]) =>
          el(
            'li',
            { class: `custom${c.done ? ' is-checked' : ''}` },
            checkbox(c.done, c.text, () => this._custom((sess) => (sess.custom[id] = { ...sess.custom[id], done: !c.done, updatedAt: Date.now() }))),
            el('span', { class: 'check-label' }, c.text),
            el('button', { type: 'button', class: 'icon-btn small-x', 'aria-label': 'Elimina voce', title: 'Elimina voce', onclick: () => this._custom((sess) => (sess.custom[id] = { deleted: true, updatedAt: Date.now() })) }, '×'),
          ),
        ),
      ),
      el('div', { class: 'add-row' }, input, el('button', { type: 'button', class: 'btn btn-small', onclick: add }, 'Aggiungi')),
    );

    // End-of-session card: errors, solutions, completion
    const errors = Object.entries(doc.errors)
      .filter(([, e]) => !e.deleted && e.session === v.sid)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const what = el('textarea', { rows: '2', placeholder: 'Cosa ho sbagliato', maxlength: '2000', 'aria-label': 'Cosa ho sbagliato', dataset: { field: 'what' } });
    const fix = el('textarea', { rows: '2', placeholder: 'Idea corretta (facoltativo)', maxlength: '2000', 'aria-label': 'Idea corretta', dataset: { field: 'fix' } });
    what.value = typed.what;
    fix.value = typed.fix;
    const addError = () => {
      const text = what.value.trim();
      if (!text) return;
      const id = uid().replace(/[^a-z0-9]/g, '').slice(0, 20);
      const fixText = fix.value.trim();
      what.value = '';
      fix.value = '';
      this.state.mutate(v.base, (d) => (d.errors[id] = { session: v.sid, text, fix: fixText, card: false, createdAt: Date.now(), updatedAt: Date.now() }));
    };
    const completed = v.row?.done === true;
    v.end.replaceChildren(
      el('div', { class: 'panel-card-head' }, el('span', { class: 'eyebrow' }, 'Registro errori')),
      errors.length
        ? el(
            'ul',
            { class: 'error-list' },
            errors.map(([id, e]) =>
              el(
                'li',
                {},
                el('span', { class: 'err-text' }, e.text, e.fix ? el('span', { class: 'err-fix' }, `→ ${e.fix}`) : null),
                el('button', { type: 'button', class: 'icon-btn small-x', 'aria-label': 'Elimina errore', title: 'Elimina', onclick: () => this.state.mutate(v.base, (d) => (d.errors[id] = { deleted: true, updatedAt: Date.now() })) }, '×'),
              ),
            ),
          )
        : el('p', { class: 'muted small' }, 'Nessun errore annotato per questa sessione. Diventeranno flashcard.'),
      el('div', { class: 'error-form' }, what, fix, el('button', { type: 'button', class: 'btn btn-small', onclick: addError }, 'Annota errore')),
      el(
        'div',
        { class: 'panel-actions end-actions' },
        v.solutionsPath
          ? el('button', { type: 'button', class: 'btn', onclick: () => this.toggleSolutions() }, v.solutions.hidden ? 'Mostra le soluzioni' : 'Nascondi le soluzioni')
          : null,
        v.progressPath && v.row
          ? completed
            ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.setDone(false) }, '✓ Completata · annulla')
            : el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.setDone(true) }, 'Segna la sessione come fatta')
          : null,
      ),
      v.solutionsPath && v.solutions.hidden ? el('p', { class: 'muted small' }, 'Le soluzioni vanno aperte solo dopo un tentativo vero.') : null,
    );
  }

  async toggleSolutions() {
    const v = this.view;
    if (!v?.solutionsPath) return;
    if (v.solutions.hidden && !v.solutions.childElementCount) {
      const text = await readText(this.gh, this.file(v.solutionsPath));
      v.solutions.replaceChildren(
        el('h2', { class: 'solutions-title' }, 'Soluzioni'),
        el('article', { class: 'md' }, renderMarkdown(text, { resolveLink: this.resolver(v.solutionsPath) })),
      );
    }
    v.solutions.hidden = !v.solutions.hidden;
    this._refreshChecks();
    if (!v.solutions.hidden) v.solutions.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async setDone(done) {
    const v = this.view;
    if (!v?.progressPath) return;
    try {
      await updateSessionDone(this.gh, v.progressPath, v.sid, done);
      v.row = { ...v.row, done };
      this._refreshChecks();
      await this.onChanged?.();
      toast(done ? `${v.sid} completata: le sue flashcard sono nel Ripasso` : `${v.sid} segnata come non completata`);
    } catch (err) {
      toast(err.status === 0 ? 'Offline: riprova quando sei connesso' : `Non riesco ad aggiornare ${v.sid}: ${err.message}`, { error: true, ms: 6000 });
    }
  }
}

/** Tick or untick a session in PROGRESSI.md through the API, retrying on concurrent edits. */
export async function updateSessionDone(gh, progressPath, id, done) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await gh.getTextFile(progressPath);
    const updated = file && setSessionDone(file.text, id, done);
    if (!updated) throw new Error(`${id} non trovata`);
    if (updated === file.text) return;
    try {
      await gh.putFile(progressPath, { text: updated }, file.sha, `reader: ${id} ${done ? 'completata' : 'riaperta'}`);
      return;
    } catch (err) {
      if ((err.status === 409 || err.status === 422) && attempt < 2) continue;
      throw err;
    }
  }
}

export const _test = { reviveState, mergeState, plain };
