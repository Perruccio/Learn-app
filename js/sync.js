// Local-first annotation store with background sync to GitHub.
//
// Every book has one JSON file next to the PDF ("<name>.annotations.json").
// Edits are written to localStorage immediately; a debounced background sync
// pulls the remote file, merges per annotation (newest `updatedAt` wins,
// deletions are kept as tombstones) and pushes the result.

import { storage, prettyName } from './util.js?v=ab27f989bd6f';

const DOC_VERSION = 1;
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;
const AUTO_SYNC_DELAY_MS = 4000;
const MAX_ATTEMPTS = 4;

export function annotationPath(pdfPath) {
  return pdfPath.replace(/\.pdf$/i, '') + '.annotations.json';
}

export function emptyDoc(book) {
  return { version: DOC_VERSION, book, lastPage: null, annotations: {} };
}

const COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
const TYPES = new Set(['highlight', 'area', 'note', 'bookmark']);
const MAX_PAGE = 100000;

const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const inUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -0.01 && v <= 1.01;

/**
 * Whitelist-based validation of one annotation. Anything read from storage or
 * from the repository is untrusted: unknown keys are dropped, enums are
 * checked, geometry must be numeric, strings are length-capped.
 */
export function sanitizeAnnotation(a) {
  if (!a || typeof a !== 'object') return null;
  if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) return null;
  if (!Number.isInteger(a.page) || a.page < 1 || a.page > MAX_PAGE) return null;
  const out = {
    id: a.id,
    type: TYPES.has(a.type) ? a.type : 'highlight',
    page: a.page,
    createdAt: finiteOr(a.createdAt, 0),
    updatedAt: finiteOr(a.updatedAt, 0),
  };
  if (a.deleted === true) {
    out.deleted = true;
    return out;
  }
  out.color = COLORS.has(a.color) ? a.color : 'yellow';
  if (typeof a.text === 'string' && a.text) out.text = a.text.slice(0, 4000);
  if (typeof a.note === 'string') out.note = a.note.slice(0, 20000);
  if (out.type === 'bookmark') {
    // A saved reading position: page plus the viewport top, in page heights.
    if (!inUnit(a.y)) return null;
    out.y = a.y;
  } else if (out.type === 'note') {
    if (!inUnit(a.x) || !inUnit(a.y)) return null;
    out.x = a.x;
    out.y = a.y;
  } else {
    const rects = Array.isArray(a.rects)
      ? a.rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(inUnit)).slice(0, 200)
      : [];
    if (!rects.length) return null;
    out.rects = rects;
  }
  return out;
}

/** Normalize whatever is stored (local or remote) into the in-memory shape. */
export function reviveDoc(raw, book) {
  const doc = emptyDoc(book);
  if (!raw || typeof raw !== 'object') return doc;
  const lp = raw.lastPage;
  doc.lastPage =
    lp && Number.isInteger(lp.page) && lp.page >= 1 && lp.page <= MAX_PAGE ? { page: lp.page, at: finiteOr(lp.at, 0) } : null;
  const list = Array.isArray(raw.annotations) ? raw.annotations : Object.values(raw.annotations || {});
  for (const item of list.slice(0, 50000)) {
    const a = sanitizeAnnotation(item);
    if (a) doc.annotations[a.id] = a;
  }
  return doc;
}

function anchorY(a) {
  if (Array.isArray(a.rects) && a.rects.length) return a.rects[0][1];
  return Number.isFinite(a.y) ? a.y : 0;
}

function byPosition(a, b) {
  return a.page - b.page || anchorY(a) - anchorY(b) || (a.createdAt || 0) - (b.createdAt || 0);
}

const KEY_ORDER = ['id', 'type', 'page', 'color', 'text', 'note', 'rects', 'x', 'y', 'createdAt', 'updatedAt', 'deleted'];

function canonical(a) {
  const out = {};
  for (const k of KEY_ORDER) if (a[k] !== undefined) out[k] = a[k];
  for (const k of Object.keys(a)) if (!(k in out)) out[k] = a[k];
  return out;
}

/** Stable, human-readable serialization (one annotation per block, compact rect arrays). */
export function serializeDoc(doc) {
  const now = Date.now();
  const annotations = Object.values(doc.annotations)
    .filter((a) => !(a.deleted && now - (a.updatedAt || 0) > TOMBSTONE_TTL_MS))
    .sort(byPosition)
    .map(canonical);
  const json = JSON.stringify({ version: DOC_VERSION, book: doc.book, lastPage: doc.lastPage, annotations }, null, 2);
  // Collapse innermost numeric arrays ([x, y, w, h]) onto one line.
  return json.replace(/\[\s+(-?[\d.e-]+(?:,\s+-?[\d.e-]+)*)\s+\]/g, (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`) + '\n';
}

function newerPosition(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (a.at || 0) >= (b.at || 0) ? a : b;
}

/** Per-annotation last-writer-wins merge. `local` wins ties. */
export function mergeDocs(local, remote) {
  const out = emptyDoc(local.book || remote.book);
  const ids = new Set([...Object.keys(local.annotations), ...Object.keys(remote.annotations)]);
  for (const id of ids) {
    const x = local.annotations[id];
    const y = remote.annotations[id];
    out.annotations[id] = !x ? y : !y ? x : (x.updatedAt || 0) >= (y.updatedAt || 0) ? x : y;
  }
  out.lastPage = newerPosition(local.lastPage, remote.lastPage);
  return out;
}

function isEmptyDoc(doc) {
  return !doc.lastPage && Object.keys(doc.annotations).length === 0;
}

/** How annotation documents are stored, merged and written (one file per book). */
export const annotationCodec = {
  namespace: 'doc',
  autoDelay: AUTO_SYNC_DELAY_MS,
  path: annotationPath,
  empty: emptyDoc,
  revive: reviveDoc,
  merge: mergeDocs,
  serialize: serializeDoc,
  isEmpty: isEmptyDoc,
  toStorage: (doc) => ({ ...doc, annotations: Object.values(doc.annotations) }),
  message: (book) => `reader: annotations ${prettyName(book)}`,
};

// ------------------------------------------------------------------ local data under old (Italian) paths

const LEGACY_SEGMENTS = { matematica: 'math', libri: 'books', flashcard: 'flashcards' };

/** New path for a path of the old Italian content layout ("matematica/libri/x.pdf" -> "math/books/x.pdf"), else null. */
export function legacyPath(path) {
  if (!/^matematica(\/|$)/.test(path)) return null;
  const parts = path.split('/');
  const last = /\.[a-z]+$/i.test(parts[parts.length - 1]) ? parts.length - 1 : parts.length; // keep file names
  return parts.map((p, i) => (i < last && Object.hasOwn(LEGACY_SEGMENTS, p) ? LEGACY_SEGMENTS[p] : p)).join('/');
}

/**
 * The content repository moved to English names. Move local documents (annotations,
 * review state, course state, zoom) stored under old paths to the new ones, so that
 * pending edits are pushed to the new files instead of recreating the old folders.
 * Cached file lists with old paths are dropped (they are fetched again).
 */
export function migrateLegacyStorage() {
  for (const key of storage.keys('learnreader:')) {
    const m = key.match(/^(learnreader:(?:(?:doc|cards|state):[^:]+:|zoom:))(.+)$/);
    if (m) {
      const to = legacyPath(m[2]);
      if (!to) continue;
      const value = storage.get(key);
      if (storage.get(m[1] + to) === null && value !== null) storage.set(m[1] + to, value);
      storage.remove(key);
    } else if (key.startsWith('learnreader:files:')) {
      const files = storage.get(key);
      if (Array.isArray(files) && files.some((f) => legacyPath(String(f?.path || '')))) storage.remove(key);
    }
  }
}

export function liveAnnotations(doc) {
  return Object.values(doc.annotations).filter((a) => !a.deleted).sort(byPosition);
}

/**
 * Events: 'change' {detail: {book, doc, remote}} and 'status' {detail: status}.
 * status = {state: 'synced'|'pending'|'syncing'|'error'|'offline', message}
 */
export class SyncManager extends EventTarget {
  constructor(gh, cfg, codec = annotationCodec) {
    super();
    this.gh = gh;
    this.codec = codec;
    this.prefix = `learnreader:${codec.namespace}:${cfg.owner}/${cfg.repo}@${cfg.branch}:`;
    this.timers = new Map();
    this.running = new Map();
    this.again = new Set();
    this.lastError = null;
    // Books whose only unsynced change is the reading position (not shown as pending).
    this.positionOnly = new Set();
    // Books with unsynced local changes (kept in memory to avoid re-parsing storage).
    this.dirty = new Set(
      storage
        .keys(this.prefix)
        .filter((k) => storage.get(k, {})?.dirty)
        .map((k) => k.slice(this.prefix.length)),
    );
  }

  key(book) {
    return this.prefix + book;
  }

  /** Current local state of a book: {doc, dirty, rev}. */
  load(book) {
    const saved = storage.get(this.key(book), null);
    if (!saved) return { doc: this.codec.empty(book), dirty: false, rev: 0 };
    return { doc: this.codec.revive(saved.doc, book), dirty: !!saved.dirty, rev: saved.rev || 0 };
  }

  _save(book, doc, dirty, rev) {
    const ok = storage.set(this.key(book), {
      doc: this.codec.toStorage(doc),
      dirty,
      rev,
    });
    if (!ok) this.lastError = 'Local storage full: sync as soon as possible';
    if (dirty) this.dirty.add(book);
    else {
      this.dirty.delete(book);
      this.positionOnly.delete(book);
    }
  }

  _emit(book, doc, remote = false) {
    this.dispatchEvent(new CustomEvent('change', { detail: { book, doc, remote } }));
  }

  /**
   * Apply a local edit. `fn(doc)` mutates the document. With `schedule: false`
   * the change is stored locally and only synced at the next sync point
   * (used for the reading position, to avoid a commit on every page turn).
   */
  mutate(book, fn, { schedule = true, silent = false } = {}) {
    const state = this.load(book);
    fn(state.doc);
    if (schedule) this.positionOnly.delete(book);
    else if (!this.dirty.has(book)) this.positionOnly.add(book);
    this._save(book, state.doc, true, state.rev + 1);
    if (!silent) this._emit(book, state.doc);
    if (schedule) this.schedule(book);
    else this._updateStatus();
    return state.doc;
  }

  schedule(book, delay = this.codec.autoDelay) {
    clearTimeout(this.timers.get(book));
    this.timers.set(
      book,
      setTimeout(() => {
        this.timers.delete(book);
        this.sync(book).catch(() => {});
      }, delay),
    );
    this._updateStatus();
  }

  dirtyBooks() {
    return [...this.dirty];
  }

  /** Pull + merge + push one book. Concurrent calls are coalesced. */
  sync(book) {
    if (this.running.has(book)) {
      this.again.add(book);
      return this.running.get(book);
    }
    clearTimeout(this.timers.get(book));
    this.timers.delete(book);
    const task = this._sync(book)
      .then((doc) => {
        this.lastError = null;
        return doc;
      })
      .catch((err) => {
        this.lastError = err.status === 0 ? 'offline' : err.message;
        if (err.status === 401) this.dispatchEvent(new CustomEvent('unauthorized'));
        throw err;
      })
      .finally(() => {
        this.running.delete(book);
        if (this.again.delete(book)) this.sync(book).catch(() => {});
        this._updateStatus();
      });
    this.running.set(book, task);
    this._updateStatus();
    return task;
  }

  async _sync(book) {
    const { codec } = this;
    const path = codec.path(book);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const start = this.load(book);
      const remote = await this.gh.getTextFile(path);
      let remoteDoc = codec.empty(book);
      if (remote) {
        try {
          remoteDoc = codec.revive(JSON.parse(remote.text), book);
        } catch {
          // A corrupted remote file is replaced by the local version (git keeps the history).
        }
      }
      const merged = codec.merge(start.doc, remoteDoc);
      const mergedText = codec.serialize(merged);
      const needsPush = remote ? mergedText !== remote.text : !codec.isEmpty(merged);
      if (needsPush) {
        try {
          await this.gh.putFile(path, { text: mergedText }, remote?.sha, codec.message(book));
        } catch (err) {
          if (err.status === 409 || err.status === 422) continue; // someone else pushed first: retry
          throw err;
        }
      }
      // Fold the result back, keeping edits made while the request was in flight.
      const now = this.load(book);
      const finalDoc = codec.merge(now.doc, merged);
      const stillDirty = now.rev !== start.rev;
      this._save(book, finalDoc, stillDirty, now.rev);
      this._emit(book, finalDoc, true);
      if (stillDirty) this.schedule(book, 1000);
      return finalDoc;
    }
    throw new Error('Too many sync conflicts, will retry later');
  }

  /** Sync every book with local changes (app start, leaving the page, back online). */
  async syncAll() {
    const books = this.dirtyBooks();
    await Promise.allSettled(books.map((b) => this.sync(b)));
  }

  status() {
    if (this.running.size) return { state: 'syncing', message: 'Syncing…' };
    if (this.lastError === 'offline') return { state: 'offline', message: 'Offline: saved locally' };
    if (this.lastError) return { state: 'error', message: this.lastError };
    const pending = this.dirtyBooks().some((b) => !this.positionOnly.has(b));
    if (this.timers.size || pending) return { state: 'pending', message: 'Saved locally' };
    return { state: 'synced', message: 'Synced' };
  }

  _updateStatus() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }
}
