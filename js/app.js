// App shell: configuration, routing, library and sync triggers.

import { $, el, debounce, dirName, formatSize, prettyName, storage, toast } from './util.js?v=1b5502b95aac';
import { GitHub } from './github.js?v=1b5502b95aac';
import { SyncManager, liveAnnotations, migrateLegacyStorage } from './sync.js?v=1b5502b95aac';
import { Reader, isPdfCached } from './reader.js?v=1b5502b95aac';
import { loadDecks, loadMath, progressCodec, tickSession } from './cards.js?v=1b5502b95aac';
import { ReviewSession, summarize } from './review.js?v=1b5502b95aac';
import { Course, skipOf, stateCodec } from './course.js?v=1b5502b95aac';

// Stamped by scripts/stamp.py on every release (do not edit by hand).
const APP_VERSION = '1b5502b95aac';
const CONFIG_KEY = 'learnreader:config';
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

const app = { cfg: null, gh: null, sync: null, cards: null, state: null, course: null, reader: null, review: null, files: null, allFiles: null, decks: null, uploadQueue: [] };

// ------------------------------------------------------------------ config

const SESSION_TOKEN_KEY = 'learnreader:session-token';

/** Config lives in localStorage; the token too, unless the user chose "don't remember". */
function loadConfig() {
  const c = storage.get(CONFIG_KEY);
  if (!c || !c.owner || !c.repo || !c.branch) return null;
  let token = c.token;
  if (!token) {
    try {
      token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    } catch {
      token = null;
    }
  }
  return token ? { ...c, token } : null;
}

function saveConfig(cfg, remember) {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    if (!remember) sessionStorage.setItem(SESSION_TOKEN_KEY, cfg.token);
  } catch {
    /* ignore */
  }
  storage.set(CONFIG_KEY, remember ? cfg : { ...cfg, token: undefined });
}

function forgetConfig() {
  storage.remove(CONFIG_KEY);
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function connect(cfg) {
  app.cfg = cfg;
  app.gh = new GitHub(cfg);
  app.sync = new SyncManager(app.gh, cfg);
  app.cards = new SyncManager(app.gh, cfg, progressCodec);
  app.state = new SyncManager(app.gh, cfg, stateCodec);
  app.course = new Course({ gh: app.gh, cfg, state: app.state, onChanged: () => refreshFiles().catch(() => {}) });
  app.allFiles = storage.get(filesKey(), null);
  app.files = app.allFiles ? pdfsOf(app.allFiles) : null;
  app.course.setFiles(app.allFiles);
  for (const manager of [app.sync, app.cards, app.state]) {
    manager.addEventListener('status', () => renderSyncStatus());
    manager.addEventListener('unauthorized', () => {
      toast('Invalid or expired token: reconnect the repository', { error: true, ms: 6000 });
      location.hash = 'setup';
    });
  }
  if (app.reader) app.reader.attach(app.sync, app.gh);
  else app.reader = new Reader({ sync: app.sync, gh: app.gh, onBack: () => (location.hash = '') });
  if (app.review) app.review.attach(app.cards);
  else app.review = new ReviewSession({ sync: app.cards, onExit: () => (location.hash = '') });
  renderSyncStatus();
}

function pdfsOf(files) {
  return files.filter((f) => /\.pdf$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function filesKey() {
  return `learnreader:files:${app.cfg.owner}/${app.cfg.repo}@${app.cfg.branch}`;
}

// ------------------------------------------------------------------ views & routing

function showView(name) {
  for (const v of ['setup', 'library', 'reader', 'review', 'course']) $(`#view-${v}`).hidden = v !== name;
  document.body.dataset.view = name;
}

// Old Italian routes, kept so that existing bookmarks and links keep working.
const HASH_ALIASES = { ripasso: 'review', percorso: 'path' };

/** Rewrite an old route (#ripasso, #percorso) to its current name, without adding a history entry. */
function redirectAlias() {
  const name = location.hash.slice(1).split('&')[0];
  if (!Object.hasOwn(HASH_ALIASES, name)) return;
  const rest = location.hash.slice(1 + name.length);
  history.replaceState(history.state, '', `${location.pathname}${location.search}#${HASH_ALIASES[name]}${rest}`);
}

function parseHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    read: params.get('read'),
    page: parseInt(params.get('page'), 10) || null,
    setup: params.has('setup'),
    review: params.has('review'),
    progress: params.has('path'),
    doc: params.get('doc'),
  };
}

async function route() {
  redirectAlias();
  const { read, page, setup, review, progress, doc } = parseHash();
  if (!app.cfg || setup) {
    await app.reader?.close();
    showSetup();
    return;
  }
  if (read) {
    await openBook(read, page);
    return;
  }
  await app.reader?.close();
  if (review) {
    await startReview();
    return;
  }
  if (progress || doc) {
    await openCourse(doc);
    return;
  }
  if (document.body.dataset.view === 'review') app.cards.syncAll();
  document.title = 'Learn Reader';
  showView('library');
  renderLibrary();
}

async function openBook(path, page) {
  showView('reader');
  if (app.reader.book === path && app.reader.pdf) {
    if (page) app.reader.viewer.currentPageNumber = page;
    return;
  }
  let file = app.files?.find((f) => f.path === path);
  if (!file) {
    try {
      file = (await refreshFiles()).find((f) => f.path === path);
    } catch {
      /* offline: handled below */
    }
  }
  if (!file) {
    await app.reader.close();
    $('#reader-title').textContent = prettyName(path);
    app.reader._showLoading(`The book “${path}” is not in the repository. Upload it from the library with the ↑ button.`, null, true);
    return;
  }
  await app.reader.open(file, { page });
}

// ------------------------------------------------------------------ setup

function showSetup() {
  showView('setup');
  document.title = 'Learn Reader · Settings';
  const form = $('#setup-form');
  if (app.cfg) {
    form.repo.value = `${app.cfg.owner}/${app.cfg.repo}`;
    form.branch.value = app.cfg.branch;
    form.token.value = '';
    form.token.required = false;
    form.token.placeholder = 'Leave empty to keep the current token';
  }
  $('#setup-cancel').hidden = !app.cfg;
  $('#setup-logout').hidden = !app.cfg;
  $('#setup-error').hidden = true;
}

function bindSetup() {
  const form = $('#setup-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const [owner, repo] = form.repo.value.trim().split('/');
    const token = form.token.value.trim() || app.cfg?.token;
    const cfg = { owner, repo, branch: form.branch.value.trim(), token };
    const error = $('#setup-error');
    const button = $('#setup-submit');
    button.disabled = true;
    button.textContent = 'Checking…';
    error.hidden = true;
    try {
      await new GitHub(cfg).checkAccess();
      saveConfig(cfg, form.remember.checked);
      connect(cfg);
      location.hash = '';
      route();
    } catch (err) {
      error.textContent =
        err.status === 401
          ? 'Invalid token.'
          : err.status === 404
            ? 'Repository not found, or the token has no access to it.'
            : err.status === 0
              ? 'No internet connection.'
              : err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });
  $('#setup-cancel').addEventListener('click', () => (location.hash = ''));
  $('#setup-logout').addEventListener('click', () => {
    const pending = app.sync?.dirtyBooks().length || 0;
    if (pending && !confirm(`${pending} ${pending === 1 ? 'book has' : 'books have'} annotations not synced yet. Disconnect anyway? They stay saved on this device.`)) return;
    forgetConfig();
    app.cfg = null;
    location.hash = 'setup';
    route();
  });
}

// ------------------------------------------------------------------ library

async function refreshFiles() {
  const { files, truncated } = await app.gh.listFiles();
  if (truncated) toast('Very large repository: some files may be missing', { error: true });
  // Keep only what the app uses: PDFs, card files and progress tables.
  const relevant = files.filter((f) => /\.(pdf|tsv|md)$/i.test(f.path));
  app.allFiles = relevant;
  app.files = pdfsOf(relevant);
  app.course?.setFiles(relevant);
  storage.set(filesKey(), relevant);
  return app.files;
}

async function renderLibrary() {
  $('#lib-repo').textContent = `${app.cfg.owner}/${app.cfg.repo}`;
  const list = $('#library-list');
  if (app.files) {
    drawLibrary();
    renderHomePanels({ pull: false });
  } else list.replaceChildren(el('p', { class: 'muted lib-empty' }, 'Loading the library…'));
  try {
    await refreshFiles();
    $('#library-offline').hidden = true;
    drawLibrary();
    renderHomePanels();
  } catch (err) {
    if (err.status === 401) return;
    if (app.files) {
      $('#library-offline').hidden = err.status !== 0;
      if (err.status !== 0) toast(err.message, { error: true });
    } else {
      list.replaceChildren(el('p', { class: 'form-error lib-empty' }, err.status === 0 ? 'You are offline and the library has never been loaded yet.' : err.message));
    }
  }
}

function drawLibrary() {
  const list = $('#library-list');
  const query = $('#lib-search').value.trim().toLowerCase();
  const files = (app.files || []).filter((f) => !query || f.path.toLowerCase().includes(query));
  if (!app.files?.length) {
    list.replaceChildren(
      el(
        'div',
        { class: 'lib-empty' },
        el('p', {}, 'No PDFs in the repository.'),
        el('p', { class: 'muted' }, 'Add books with the ↑ button above, or upload them to the ', el('code', {}, 'math/books'), ' folder of the repository.'),
      ),
    );
    return;
  }
  if (!files.length) {
    list.replaceChildren(el('p', { class: 'muted lib-empty' }, 'No book matches the search.'));
    return;
  }
  const groups = new Map();
  for (const f of files) {
    const dir = dirName(f.path) || '(root)';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const dirty = new Set(app.sync.dirtyBooks());
  const sections = [];
  for (const [dir, items] of groups) {
    sections.push(
      el(
        'section',
        { class: 'lib-group' },
        el('h2', { class: 'lib-group-title' }, dir),
        el(
          'ul',
          { class: 'book-list' },
          items.map((f) => {
            const { doc } = app.sync.load(f.path);
            const count = liveAnnotations(doc).length;
            const meta = [formatSize(f.size)];
            if (doc.lastPage) meta.push(`p. ${doc.lastPage.page}`);
            if (count) meta.push(count === 1 ? '1 annotation' : `${count} annotations`);
            const offline = el('span', { class: 'badge-offline', hidden: true, title: 'Available offline' }, 'offline');
            isPdfCached(f.sha).then((yes) => (offline.hidden = !yes));
            return el(
              'li',
              {},
              el(
                'a',
                { class: 'book-card', href: `#read=${encodeURIComponent(f.path).replace(/%2F/g, '/')}` },
                el('span', { class: 'book-spine', 'aria-hidden': 'true' }),
                el(
                  'span',
                  { class: 'book-info' },
                  el('span', { class: 'book-title' }, prettyName(f.path)),
                  el('span', { class: 'book-meta' }, meta.join(' · '), dirty.has(f.path) && el('span', { class: 'dot-pending', title: 'Changes to sync' }), offline),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
  list.replaceChildren(...sections);
}

// ------------------------------------------------------------------ home panels: next session and flashcards

let panelsToken = 0;
async function renderHomePanels({ pull = true } = {}) {
  if (!app.allFiles) return;
  const token = ++panelsToken;
  let decks;
  try {
    decks = await loadDecks(app.gh, app.allFiles);
  } catch {
    return; // offline and texts not cached yet
  }
  if (token !== panelsToken) return;
  app.decks = decks;

  // Next session = first unticked, not skipped row of the first progress table.
  const table = decks.dirs.find((d) => d.rows.length) || null;
  const base = table ? dirName(table.progressFile.path) : '';
  const state = table ? app.state.load(base).doc : null;
  const rows = table ? table.rows.filter((r) => r.done || skipOf(state, r.id) !== 'drop') : [];
  const next = rows.find((r) => !r.done && !skipOf(state, r.id)) || null;
  $('#next-session').hidden = !next;
  if (next) {
    $('#next-title').textContent = `${next.id} · ${next.title}`;
    $('#next-meta').textContent = `${next.track} · ${rows.filter((r) => r.done).length} of ${rows.length} done`;
    const link = next.link ? `#doc=${base ? `${base}/` : ''}${next.link}` : null;
    $('#next-open').hidden = !link;
    if (link) $('#next-open').href = link;
  }

  drawReviewPanel(decks);
  if (pull) {
    // Pull review progress made on other devices, then refresh the counts.
    await Promise.allSettled(decks.dirs.map((d) => app.cards.sync(d.dir)));
    if (token === panelsToken && document.body.dataset.view === 'library') drawReviewPanel(decks);
  }
}

function drawReviewPanel(decks) {
  const hasCards = decks.cards.length + decks.locked > 0;
  $('#review-panel').hidden = !hasCards;
  if (!hasCards) return;
  const s = summarize(decks, app.cards);
  $('#rv-due').textContent = s.due;
  $('#rv-new').textContent = s.fresh;
  const parts = Object.entries(s.byDeck)
    .filter(([, c]) => c.due + c.fresh > 0)
    .map(([deck, c]) => `${deck} ${c.due + c.fresh}`);
  $('#rv-decks').textContent = decks.cards.length
    ? parts.length
      ? `By track: ${parts.join(' · ')}`
      : 'All reviewed for today.'
    : 'A session’s cards unlock when you mark it as done.';
  $('#rv-start').classList.toggle('is-disabled', s.due + s.fresh === 0);
}

async function openCourse(docPath) {
  showView('course');
  const main = $('#course-main');
  const setTitle = (text) => {
    $('#course-title').textContent = text;
    document.title = `${text} · Learn Reader`;
  };
  $('#course-back').onclick = () => {
    if (docPath && /\/sessions\//.test(docPath)) location.hash = 'path';
    else if (docPath) history.length > 1 ? history.back() : (location.hash = 'path');
    else location.hash = '';
  };
  try {
    if (!app.allFiles) await refreshFiles();
  } catch (err) {
    if (!app.allFiles) {
      main.replaceChildren(el('p', { class: 'form-error' }, err.status === 0 ? 'Offline, and the content has not been downloaded yet.' : err.message));
      return;
    }
  }
  main.scrollTop = 0;
  if (!docPath) {
    setTitle('Path');
    await app.course.renderProgress(main);
    // Pull checklist state from other devices, then refresh the view.
    const bases = [...new Set(app.allFiles.filter((f) => /(^|\/)PROGRESS\.md$/.test(f.path)).map((f) => dirName(f.path)))];
    Promise.allSettled(bases.map((b) => app.state.sync(b))).then(() => {
      if (parseHash().progress) app.course.renderProgress(main);
    });
    return;
  }
  if (!app.course.file(docPath)) {
    // The file may have been added after the list was cached.
    await refreshFiles().catch(() => {});
  }
  await app.course.renderDoc(main, docPath, { title: setTitle });
  const sessionBase = /\/sessions\//.test(docPath) ? dirName(dirName(docPath)) : null;
  if (sessionBase !== null) app.state.sync(sessionBase).catch(() => {});
}

async function startReview() {
  showView('review');
  document.title = 'Review · Learn Reader';
  $('#review-count').textContent = 'Loading cards…';
  $('#review-stage').hidden = true;
  $('#review-done').hidden = true;
  try {
    if (!app.allFiles) await refreshFiles();
    app.decks = await loadDecks(app.gh, app.allFiles);
  } catch (err) {
    if (!app.decks) {
      toast(err.status === 0 ? 'Offline, and the cards have not been downloaded yet' : err.message, { error: true });
      location.hash = '';
      return;
    }
  }
  // Best effort: include reviews done on other devices before building the queue.
  await Promise.all([loadMath(), Promise.race([
    Promise.allSettled(app.decks.dirs.map((d) => app.cards.sync(d.dir))),
    new Promise((r) => setTimeout(r, 4000)),
  ])]);
  app.review.start(app.decks);
}

// ------------------------------------------------------------------ upload

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function safeName(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function bindUpload() {
  const input = $('#upload-input');
  const dialog = $('#upload-dialog');
  $('#btn-upload').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    app.uploadQueue = [...input.files];
    input.value = '';
    if (!app.uploadQueue.length) return;
    $('#upload-files').textContent = app.uploadQueue.map((f) => `${f.name} (${formatSize(f.size)})`).join(', ');
    const folders = new Set(['math/books', ...(app.files || []).map((f) => dirName(f.path)).filter(Boolean)]);
    $('#upload-folders').replaceChildren(...[...folders].map((d) => el('option', { value: d })));
    dialog.showModal();
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'ok') return;
    const folder = $('#upload-form').folder.value.trim().replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((s) => s === '.' || s === '..' || (folder && !s))) {
      toast(`Invalid folder: ${folder}`, { error: true, ms: 6000 });
      app.uploadQueue = [];
      return;
    }
    for (const file of app.uploadQueue) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`${file.name}: too large (95 MB max)`, { error: true, ms: 6000 });
        continue;
      }
      const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      if (String.fromCharCode(...head) !== '%PDF-') {
        toast(`${file.name}: not a valid PDF`, { error: true, ms: 6000 });
        continue;
      }
      const name = safeName(file.name).replace(/(\.pdf)?$/i, '.pdf');
      const path = folder ? `${folder}/${name}` : name;
      const existing = app.files?.find((f) => f.path === path);
      if (existing && !confirm(`${path} already exists. Replace it?`)) continue;
      toast(`Uploading ${name}…`, { ms: 5000 });
      try {
        await app.gh.putLargeFile(path, await readAsBase64(file), `reader: add ${name}`);
        toast(`${name} uploaded`);
      } catch (err) {
        toast(`${name}: ${err.message}`, { error: true, ms: 8000 });
      }
    }
    app.uploadQueue = [];
    await renderLibrary();
  });
}

// ------------------------------------------------------------------ sync status & triggers

function renderSyncStatus() {
  const order = ['syncing', 'error', 'offline', 'pending', 'synced'];
  const statuses = [app.sync, app.cards, app.state].filter(Boolean).map((m) => m.status());
  const status = statuses.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0] || { state: 'synced', message: 'Synced' };
  for (const pill of document.querySelectorAll('[data-sync-pill]')) {
    pill.dataset.state = status.state;
    pill.title = `${status.message} · tap to sync`;
    pill.querySelector('.sync-text').textContent = status.message;
  }
}

async function syncNow() {
  if (!app.sync) return;
  app.reader?.savePosition.flush();
  app.reader?.saveNote.flush();
  const tasks = [app.sync.syncAll(), app.cards.syncAll(), app.state.syncAll()];
  if (app.reader?.book) tasks.push(app.sync.sync(app.reader.book));
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) toast(failed.reason?.status === 0 ? 'Offline: changes stay saved here' : `Sync failed: ${failed.reason?.message}`, { error: true });
  if (document.body.dataset.view === 'library') drawLibrary();
}

function bindGlobal() {
  for (const pill of document.querySelectorAll('[data-sync-pill]')) pill.addEventListener('click', syncNow);
  $('#lib-search').addEventListener('input', debounce(drawLibrary, 120));
  document.querySelector('.loading-back').addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '';
  });
  window.addEventListener('hashchange', route);
  // Leaving the app (switching tab/app, locking the phone): flush pending changes.
  document.addEventListener('visibilitychange', () => {
    if (!app.sync) return;
    if (document.visibilityState === 'hidden') {
      app.reader?.savePosition.flush();
      app.reader?.saveNote.flush();
      app.sync.syncAll();
      app.cards.syncAll();
      app.state.syncAll();
    } else if (app.reader?.book) {
      app.sync.sync(app.reader.book).catch(() => {}); // pull edits made on other devices
    }
  });
  window.addEventListener('pagehide', () => {
    if (!app.sync) return;
    app.reader?.savePosition.flush();
    app.reader?.saveNote.flush();
    app.sync.syncAll();
    app.cards.syncAll();
    app.state.syncAll();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());
  window.addEventListener('online', () => {
    app.sync?.syncAll();
    app.cards?.syncAll();
    app.state?.syncAll();
  });
  const onFullscreen = () => {
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $('#btn-fullscreen use').setAttribute('href', full ? '#i-shrink' : '#i-expand');
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
}

// ------------------------------------------------------------------ updates

let lastUpdateCheck = 0;

/**
 * GitHub Pages lets browsers cache files for ~10 minutes. If a newer version is
 * deployed, refresh the cached page and reload: immediately when nothing is in
 * progress, otherwise via a toast so a review or a note is never interrupted.
 */
async function checkForUpdate() {
  if (APP_VERSION === 'dev' || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (typeof version !== 'string' || version === APP_VERSION) return;
    await Promise.allSettled([fetch('./', { cache: 'reload' }), fetch('index.html', { cache: 'reload' })]);
    const busy = ['reader', 'review'].includes(document.body.dataset.view) || document.activeElement?.matches?.('input, textarea');
    // Reload automatically at most once per version (no loop if a CDN still serves the old page).
    let alreadyTried = false;
    try {
      alreadyTried = sessionStorage.getItem('learnreader:reloaded-for') === version;
      if (!busy && !alreadyTried) sessionStorage.setItem('learnreader:reloaded-for', version);
    } catch {
      alreadyTried = true;
    }
    if (!busy && !alreadyTried) {
      location.reload();
      return;
    }
    toast('A new version of the app is available.', { ms: 600000, action: { label: 'Update', fn: () => location.reload() } });
  } catch {
    /* offline: try again later */
  }
}

// ------------------------------------------------------------------ start

// Never run inside a frame: blocks clickjacking and pages that embed the app to drive it.
if (window.top !== window.self) {
  document.body.replaceChildren(document.createTextNode('Learn Reader cannot be opened inside another page.'));
  throw new Error('Refusing to run in a frame');
}

bindSetup();
bindUpload();
bindGlobal();
migrateLegacyStorage();
const saved = loadConfig();
if (saved) {
  connect(saved);
  app.sync.syncAll();
  app.cards.syncAll();
  app.state.syncAll();
}
route();
checkForUpdate();
