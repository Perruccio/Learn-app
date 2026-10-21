// Study path inside the app: progress overview, session pages with checklists,
// solutions on demand, error log. Nothing here requires opening GitHub.
//
// Progress of sessions is PROGRESS.md (ticked rows). The reached step of each
// session, personal to-dos and the error log are stored in "<base>/state.json"
// (synced like annotations).

import { el, dirName, toast, uid } from './util.js?v=16e8e35a2e34';
import { loadMath, parseProgress, readText, setSessionDone } from './cards.js?v=16e8e35a2e34';
import { joinPath, renderMarkdown } from './markdown.js?v=16e8e35a2e34';

const SESSION_ID = /^[A-Z]\d{2,4}$/;
const ID_RE = /^[a-z0-9]{4,24}$/;
// Skipped topic: 'later' = recover it later, 'drop' = removed from the path, '' = not skipped.
const SKIP_VALUES = new Set(['', 'later', 'drop']);
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
    const out = { stage: null, skip: null, custom: {} };
    const st = s.stage;
    if (st && Number.isInteger(st.value) && st.value >= 0 && st.value <= 20 && num(st.updatedAt)) {
      out.stage = { value: st.value, label: str(st.label, 40), updatedAt: st.updatedAt };
    }
    const sk = s.skip;
    if (sk && SKIP_VALUES.has(sk.value) && num(sk.updatedAt)) out.skip = { value: sk.value, updatedAt: sk.updatedAt };
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
    const x = a.sessions[sid] || { stage: null, custom: {} };
    const y = b.sessions[sid] || { stage: null, custom: {} };
    const s = { stage: newer(x.stage, y.stage) || null, skip: newer(x.skip, y.skip) || null, custom: {} };
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
  path: (base) => (base ? `${base}/state.json` : 'state.json'),
  empty: emptyState,
  revive: reviveState,
  merge: mergeState,
  serialize: (doc) => `${JSON.stringify(sortKeys({ version: 1, sessions: doc.sessions, errors: doc.errors }), null, 2)}\n`,
  isEmpty: (doc) => !Object.keys(doc.sessions).length && !Object.keys(doc.errors).length,
  toStorage: (doc) => doc,
  message: () => 'reader: session progress',
};

// ------------------------------------------------------------------ helpers

/** How a session was skipped: 'later', 'drop' or null. */
export function skipOf(doc, sid) {
  return doc.sessions[sid]?.skip?.value || null;
}

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
      title: checked ? 'Done' : 'To do',
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
    for (const f of this.allFiles.filter((x) => /(^|\/)PROGRESS\.md$/.test(x.path))) {
      out.push({ base: dirName(f.path), path: f.path, rows: parseProgress(await readText(this.gh, f)) });
    }
    return out;
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
    container.replaceChildren(el('p', { class: 'muted' }, 'Loading the path…'));
    const tables = await this.tables();
    if (!tables.length) {
      container.replaceChildren(el('p', { class: 'muted' }, 'No PROGRESS.md in the repository.'));
      return;
    }
    const nodes = [];
    for (const t of tables) {
      const state = this.state.load(t.base).doc;
      // Topics removed from the path no longer count.
      const rows = t.rows.filter((r) => r.done || skipOf(state, r.id) !== 'drop');
      const done = rows.filter((r) => r.done).length;
      const tracks = {};
      for (const r of rows) {
        // Track code = the word before the dash ("LinAlg-01" -> "LinAlg"); anything else is mixed.
        const k = (r.track.match(/^[A-Za-z]+(?=-)/) || ['Mixed'])[0];
        tracks[k] ??= { done: 0, total: 0 };
        tracks[k].total++;
        if (r.done) tracks[k].done++;
      }
      const errorsOpen = Object.values(state.errors).filter((e) => !e.deleted && !e.card).length;
      nodes.push(
        el(
          'section',
          { class: 'panel-card progress-summary' },
          el('div', { class: 'panel-card-head' }, el('span', { class: 'eyebrow' }, t.base || 'Path')),
          el('p', { class: 'review-counts' }, el('span', { class: 'big' }, String(done)), ` of ${rows.length} sessions done`),
          progressBar(rows.length ? done / rows.length : 0, 'Overall progress'),
          el(
            'div',
            { class: 'track-bars' },
            Object.entries(tracks).map(([k, v]) =>
              el('div', { class: 'track-row' }, el('span', { class: 'track-name' }, k), progressBar(v.done / v.total, k), el('span', { class: 'track-num' }, `${v.done}/${v.total}`)),
            ),
          ),
          errorsOpen ? el('p', { class: 'muted small' }, `${errorsOpen} logged ${errorsOpen === 1 ? 'error' : 'errors'} to turn into flashcards: ask Claude “make flashcards from my errors”.`) : null,
        ),
      );
      const blocks = [...new Set(t.rows.map((r) => r.block))];
      for (const b of blocks) {
        nodes.push(
          el(
            'section',
            { class: 'block' },
            el('h2', { class: 'lib-group-title' }, b || 'Sessions'),
            el(
              'ul',
              { class: 'session-list' },
              t.rows
                .filter((r) => r.block === b)
                .map((r) => {
                  const path = r.link ? joinPath(t.base, r.link) : null;
                  const available = path && this.file(path);
                  const st = this.state.load(t.base).doc.sessions[r.id];
                  const started = (st?.stage?.value || 0) > 0;
                  const skip = r.done ? null : skipOf(state, r.id);
                  const status = r.done ? 'done' : skip === 'drop' ? 'dropped' : skip === 'later' ? 'skipped' : started ? 'started' : 'todo';
                  const label = {
                    done: 'Done',
                    skipped: 'Skipped · to recover',
                    dropped: 'Dropped from the path',
                    started: st?.stage?.label ? `In progress · done up to ${st.stage.label}` : 'In progress',
                    todo: available ? 'To do' : 'Being prepared',
                  }[status];
                  const inner = [
                    el('span', { class: `status-dot s-${status}`, title: label, 'aria-label': label }),
                    el('span', { class: 'session-id' }, r.id),
                    el('span', { class: 'session-title' }, r.title, el('span', { class: 'session-track' }, r.track)),
                    el('span', { class: 'session-state' }, label),
                  ];
                  return el('li', { class: status === 'dropped' ? 'is-dropped' : '' }, available ? el('a', { class: 'session-row', href: `#doc=${path}` }, inner) : el('div', { class: 'session-row is-disabled' }, inner));
                }),
            ),
          ),
        );
      }
      // Documents: method pages plus every roadmap (titled by its first heading).
      const docs = [
        ['Study method', 'method/method.md'],
        ['Setup and tools', 'method/setup.md'],
        ['Resources', 'method/resources.md'],
      ].filter(([, p]) => this.file(joinPath(t.base, p)));
      const roadmapDir = joinPath(t.base, 'roadmap');
      const roadmaps = this.allFiles.filter((f) => dirName(f.path) === roadmapDir && /\.md$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
      for (const f of roadmaps) {
        const h1 = (await readText(this.gh, f)).match(/^#\s+(.+)$/m);
        docs.push([`Roadmap · ${h1 ? h1[1].trim() : f.path.split('/').pop()}`, f.path.slice(t.base ? t.base.length + 1 : 0)]);
      }
      if (docs.length) {
        nodes.push(
          el(
            'section',
            { class: 'block' },
            el('h2', { class: 'lib-group-title' }, 'Documents'),
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
      container.replaceChildren(el('p', { class: 'form-error' }, `File not found: ${path}`));
      return;
    }
    container.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    const [text] = await Promise.all([readText(this.gh, file), loadMath()]);
    const m = path.match(/(?:^|\/)sessions\/([A-Z]\d{2,4})\.md$/);
    const sid = m ? m[1] : null;
    const base = sid ? dirName(dirName(path)) : null;

    // Steps of a session = its numbered sections: "## 1 · Review (10')", ...
    const steps = [];
    const anchor = sid
      ? (block) => {
          if (block.type !== 'heading' || block.level !== 2) return;
          const h = block.text.match(/^(\d+)\s*·\s*(.+?)\s*(?:\((\d+)'\))?$/);
          if (!h) return;
          steps.push({ label: plain(h[2]), minutes: h[3] ? Number(h[3]) : null, node: block.node });
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

    // Session page: stepper ("where am I"), content, end-of-session panel.
    this.view = { path, sid, base, steps, body };
    const progressFile = this.file(base ? `${base}/PROGRESS.md` : 'PROGRESS.md');
    this.view.row = progressFile ? parseProgress(await readText(this.gh, progressFile)).find((r) => r.id === sid) : null;
    this.view.progressPath = progressFile?.path;

    const stepper = el('nav', { class: 'stepper', 'aria-label': 'Where you are' });
    const end = el('section', { class: 'panel-card session-end', id: 'session-end' });
    const solutionsPath = joinPath(dirName(dirName(path)), `solutions/${sid}.md`);
    const solutions = el('section', { class: 'solutions', hidden: true });
    container.replaceChildren(stepper, body, end, solutions);
    Object.assign(this.view, { stepper, end, solutions, solutionsPath: this.file(solutionsPath) ? solutionsPath : null });
    this._refreshChecks();
  }

  /** Tap on step i: "I got here" (steps 1..i done). Tapping the current step again steps back one. */
  setStage(i) {
    const v = this.view;
    if (!v) return;
    const current = this.state.load(v.base).doc.sessions[v.sid]?.stage?.value || 0;
    const value = current === i ? i - 1 : i;
    const label = value > 0 ? v.steps[value - 1].label : '';
    this._custom((s) => (s.stage = { value, label, updatedAt: Date.now() }));
    if (value === v.steps.length && value > 0) {
      toast('Last phase done: log your errors and mark the session as done.', { ms: 4500 });
      v.end.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (value < v.steps.length) {
      v.steps[value]?.node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  _custom(mutator) {
    const v = this.view;
    if (!v) return;
    this.state.mutate(v.base, (d) => {
      const s = (d.sessions[v.sid] ??= { stage: null, custom: {} });
      mutator(s, d);
    });
  }

  /** Re-render every state-dependent part of the session page. */
  _refreshChecks() {
    const v = this.view;
    if (!v || !v.stepper?.isConnected) return;
    const doc = this.state.load(v.base).doc;
    const s = doc.sessions[v.sid] || { stage: null, skip: null, custom: {} };
    const skip = s.skip?.value || null;
    const stage = Math.min(s.stage?.value || 0, v.steps.length);
    const completed = v.row?.done === true;

    // Keep what the user is typing across re-renders (e.g. when a sync brings remote changes).
    const typed = {
      add: v.end.querySelector('.add-input')?.value || '',
      what: v.end.querySelector('textarea[data-field="what"]')?.value || '',
      fix: v.end.querySelector('textarea[data-field="fix"]')?.value || '',
    };

    // Stepper: one tap = "I got here".
    v.stepper.replaceChildren(
      el(
        'ol',
        { class: 'steps' },
        v.steps.map((step, k) => {
          const n = k + 1;
          const state = completed || n <= stage ? 'done' : n === stage + 1 ? 'next' : 'todo';
          return el(
            'li',
            { class: `step s-${state}` },
            el(
              'button',
              {
                type: 'button',
                'aria-pressed': String(state === 'done'),
                title: state === 'done' ? (n === stage ? 'Tap again to step back' : 'Done') : 'Tap when you finish this phase',
                onclick: () => !completed && this.setStage(n),
              },
              el('span', { class: 'step-dot' }, state === 'done' ? '✓' : String(n)),
              el('span', { class: 'step-label' }, step.label),
            ),
          );
        }),
      ),
      el(
        'p',
        { class: 'step-hint' },
        completed
          ? 'Session done.'
          : stage === 0
            ? 'Tap a phase when you finish it: the ones before it are marked too.'
            : stage < v.steps.length
              ? `Next phase: ${v.steps[stage].label}.`
              : 'All phases done: close the session at the bottom of the page.',
      ),
      completed ? null : this._skipControls(skip),
    );
    v.steps.forEach((step, k) => step.node.classList.toggle('is-done', completed || k < stage));

    // Optional personal to-dos
    const customs = Object.entries(s.custom)
      .filter(([, c]) => !c.deleted)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const input = el('input', { type: 'text', class: 'add-input', placeholder: 'Reminder (e.g. “redo T3 tomorrow”)', maxlength: '300', 'aria-label': 'New reminder' });
    input.value = typed.add;
    const add = () => {
      const text = input.value.trim();
      if (!text) return;
      const id = uid().replace(/[^a-z0-9]/g, '').slice(0, 20);
      input.value = '';
      this._custom((sess) => (sess.custom[id] = { text, done: false, createdAt: Date.now(), updatedAt: Date.now() }));
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));

    // Error log
    const errors = Object.entries(doc.errors)
      .filter(([, e]) => !e.deleted && e.session === v.sid)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const what = el('textarea', { rows: '2', placeholder: 'What I got wrong', maxlength: '2000', 'aria-label': 'What I got wrong', dataset: { field: 'what' } });
    const fix = el('textarea', { rows: '2', placeholder: 'Correct idea (optional)', maxlength: '2000', 'aria-label': 'Correct idea', dataset: { field: 'fix' } });
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

    v.end.replaceChildren(
      el('div', { class: 'panel-card-head' }, el('span', { class: 'eyebrow' }, 'Error log')),
      errors.length
        ? el(
            'ul',
            { class: 'error-list' },
            errors.map(([id, e]) =>
              el(
                'li',
                {},
                el('span', { class: 'err-text' }, e.text, e.fix ? el('span', { class: 'err-fix' }, `→ ${e.fix}`) : null),
                el('button', { type: 'button', class: 'icon-btn small-x', 'aria-label': 'Delete error', title: 'Delete', onclick: () => this.state.mutate(v.base, (d) => (d.errors[id] = { deleted: true, updatedAt: Date.now() })) }, '×'),
              ),
            ),
          )
        : el('p', { class: 'muted small' }, 'No errors logged for this session. They will become flashcards.'),
      el('div', { class: 'error-form' }, what, fix, el('button', { type: 'button', class: 'btn btn-small', onclick: addError }, 'Add error')),
      el('div', { class: 'panel-card-head todo-head' }, el('span', { class: 'eyebrow' }, 'Reminders')),
      customs.length
        ? el(
            'ul',
            { class: 'check-list' },
            customs.map(([id, c]) =>
              el(
                'li',
                { class: c.done ? 'is-checked' : '' },
                checkbox(c.done, c.text, () => this._custom((sess) => (sess.custom[id] = { ...sess.custom[id], done: !c.done, updatedAt: Date.now() }))),
                el('span', { class: 'check-label' }, c.text),
                el('button', { type: 'button', class: 'icon-btn small-x', 'aria-label': 'Delete reminder', title: 'Delete', onclick: () => this._custom((sess) => (sess.custom[id] = { deleted: true, updatedAt: Date.now() })) }, '×'),
              ),
            ),
          )
        : null,
      el('div', { class: 'add-row' }, input, el('button', { type: 'button', class: 'btn btn-small', onclick: add }, 'Add')),
      el(
        'div',
        { class: 'panel-actions end-actions' },
        v.solutionsPath
          ? el('button', { type: 'button', class: 'btn', onclick: () => this.toggleSolutions() }, v.solutions.hidden ? 'Show solutions' : 'Hide solutions')
          : null,
        v.progressPath && v.row
          ? completed
            ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.setDone(false) }, '✓ Done · undo')
            : el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.setDone(true) }, 'Mark session as done')
          : null,
      ),
      v.solutionsPath && v.solutions.hidden ? el('p', { class: 'muted small' }, 'Open the solutions only after a real attempt.') : null,
    );
  }

  /** "Skip this topic": no exercises, reviews or flashcards on it; recover it later or drop it for good. */
  _skipControls(skip) {
    const v = this.view;
    if (skip) {
      return el(
        'div',
        { class: 'skip-box is-skipped' },
        el(
          'p',
          { class: 'skip-msg' },
          skip === 'drop'
            ? 'Topic dropped from the path: no exercises, reviews or flashcards on it.'
            : 'Topic skipped, to recover later: until then no reviews or flashcards on it.',
        ),
        el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => this.setSkip('') }, 'Undo skip'),
      );
    }
    if (!v.skipAsk) {
      return el('div', { class: 'skip-box' }, el('button', { type: 'button', class: 'link-btn skip-open', onclick: () => ((v.skipAsk = true), this._refreshChecks()) }, 'Skip this topic'));
    }
    return el(
      'div',
      { class: 'skip-box is-asking' },
      el('p', { class: 'skip-msg' }, 'This skips the topic with its exercises, reviews and flashcards. Then?'),
      el(
        'div',
        { class: 'skip-actions' },
        el('button', { type: 'button', class: 'btn btn-small', dataset: { skip: 'later' }, onclick: () => this.setSkip('later') }, 'Recover it later'),
        el('button', { type: 'button', class: 'btn btn-small', dataset: { skip: 'drop' }, onclick: () => this.setSkip('drop') }, 'Drop it for good'),
        el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => ((v.skipAsk = false), this._refreshChecks()) }, 'Cancel'),
      ),
    );
  }

  setSkip(value) {
    const v = this.view;
    if (!v) return;
    v.skipAsk = false;
    this._custom((s) => (s.skip = { value, updatedAt: Date.now() }));
    if (value) toast(value === 'drop' ? `${v.sid} dropped from the path` : `${v.sid} skipped: to recover later`);
  }

  async toggleSolutions() {
    const v = this.view;
    if (!v?.solutionsPath) return;
    if (v.solutions.hidden && !v.solutions.childElementCount) {
      const text = await readText(this.gh, this.file(v.solutionsPath));
      v.solutions.replaceChildren(
        el('h2', { class: 'solutions-title' }, 'Solutions'),
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
      // Doing a skipped topic after all recovers it.
      if (done && this.state.load(v.base).doc.sessions[v.sid]?.skip?.value) this._custom((s) => (s.skip = { value: '', updatedAt: Date.now() }));
      v.row = { ...v.row, done };
      this._refreshChecks();
      await this.onChanged?.();
      toast(done ? `${v.sid} done: its flashcards are now in Review` : `${v.sid} marked as not done`);
    } catch (err) {
      toast(err.status === 0 ? 'Offline: try again when you are connected' : `Could not update ${v.sid}: ${err.message}`, { error: true, ms: 6000 });
    }
  }
}

/** Tick or untick a session in PROGRESS.md through the API, retrying on concurrent edits. */
export async function updateSessionDone(gh, progressPath, id, done) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await gh.getTextFile(progressPath);
    const updated = file && setSessionDone(file.text, id, done);
    if (!updated) throw new Error(`${id} not found`);
    if (updated === file.text) return;
    try {
      await gh.putFile(progressPath, { text: updated }, file.sha, `reader: ${id} ${done ? 'done' : 'reopened'}`);
      return;
    } catch (err) {
      if ((err.status === 409 || err.status === 422) && attempt < 2) continue;
      throw err;
    }
  }
}

export const _test = { reviveState, mergeState, plain };
