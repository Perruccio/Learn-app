// App shell: configuration, routing, library and sync triggers.

import { $, el, debounce, dirName, formatSize, prettyName, storage, toast } from './util.js';
import { GitHub } from './github.js';
import { SyncManager, liveAnnotations } from './sync.js';
import { Reader, isPdfCached } from './reader.js';

const CONFIG_KEY = 'learnreader:config';
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

const app = { cfg: null, gh: null, sync: null, reader: null, files: null, uploadQueue: [] };

// ------------------------------------------------------------------ config

function loadConfig() {
  const c = storage.get(CONFIG_KEY);
  return c && c.owner && c.repo && c.branch && c.token ? c : null;
}

function connect(cfg) {
  app.cfg = cfg;
  app.gh = new GitHub(cfg);
  app.sync = new SyncManager(app.gh, cfg);
  app.files = storage.get(filesKey(), null);
  app.sync.addEventListener('status', (e) => renderSyncStatus(e.detail));
  app.sync.addEventListener('unauthorized', () => {
    toast('Token non valido o scaduto: ricollega il repository', { error: true, ms: 6000 });
    location.hash = 'setup';
  });
  if (app.reader) app.reader.attach(app.sync, app.gh);
  else app.reader = new Reader({ sync: app.sync, gh: app.gh, onBack: () => (location.hash = '') });
  renderSyncStatus(app.sync.status());
}

function filesKey() {
  return `learnreader:files:${app.cfg.owner}/${app.cfg.repo}@${app.cfg.branch}`;
}

// ------------------------------------------------------------------ views & routing

function showView(name) {
  for (const v of ['setup', 'library', 'reader']) $(`#view-${v}`).hidden = v !== name;
  document.body.dataset.view = name;
}

function parseHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { read: params.get('read'), page: parseInt(params.get('page'), 10) || null, setup: params.has('setup') };
}

async function route() {
  const { read, page, setup } = parseHash();
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
    app.reader._showLoading(`Il libro «${path}» non è nel repository. Caricalo dalla libreria con il pulsante ↑.`, null, true);
    return;
  }
  await app.reader.open(file, { page });
}

// ------------------------------------------------------------------ setup

function showSetup() {
  showView('setup');
  document.title = 'Learn Reader · Impostazioni';
  const form = $('#setup-form');
  if (app.cfg) {
    form.repo.value = `${app.cfg.owner}/${app.cfg.repo}`;
    form.branch.value = app.cfg.branch;
    form.token.value = '';
    form.token.required = false;
    form.token.placeholder = 'Lascia vuoto per mantenere il token attuale';
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
    button.textContent = 'Verifico…';
    error.hidden = true;
    try {
      await new GitHub(cfg).checkAccess();
      storage.set(CONFIG_KEY, cfg);
      connect(cfg);
      location.hash = '';
      route();
    } catch (err) {
      error.textContent =
        err.status === 401
          ? 'Token non valido.'
          : err.status === 404
            ? 'Repository non trovato, oppure il token non ha accesso a questo repository.'
            : err.status === 0
              ? 'Nessuna connessione a internet.'
              : err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Connetti';
    }
  });
  $('#setup-cancel').addEventListener('click', () => (location.hash = ''));
  $('#setup-logout').addEventListener('click', () => {
    const pending = app.sync?.dirtyBooks().length || 0;
    if (pending && !confirm(`Ci sono annotazioni non ancora sincronizzate in ${pending} libri. Disconnettere comunque? Restano salvate su questo dispositivo.`)) return;
    storage.remove(CONFIG_KEY);
    app.cfg = null;
    location.hash = 'setup';
    route();
  });
}

// ------------------------------------------------------------------ library

async function refreshFiles() {
  const { files, truncated } = await app.gh.listFiles();
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, 'it'));
  if (truncated) toast('Repository molto grande: alcuni file potrebbero non comparire', { error: true });
  app.files = pdfs;
  storage.set(filesKey(), pdfs);
  return pdfs;
}

async function renderLibrary() {
  $('#lib-repo').textContent = `${app.cfg.owner}/${app.cfg.repo}`;
  const list = $('#library-list');
  if (app.files) drawLibrary();
  else list.replaceChildren(el('p', { class: 'muted lib-empty' }, 'Carico la libreria…'));
  try {
    await refreshFiles();
    $('#library-offline').hidden = true;
    drawLibrary();
  } catch (err) {
    if (err.status === 401) return;
    if (app.files) {
      $('#library-offline').hidden = err.status !== 0;
      if (err.status !== 0) toast(err.message, { error: true });
    } else {
      list.replaceChildren(el('p', { class: 'form-error lib-empty' }, err.status === 0 ? 'Sei offline e la libreria non è ancora mai stata caricata.' : err.message));
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
        el('p', {}, 'Nessun PDF nel repository.'),
        el('p', { class: 'muted' }, 'Aggiungi i libri con il pulsante ↑ in alto, oppure caricali nella cartella ', el('code', {}, 'matematica/libri'), ' del repository.'),
      ),
    );
    return;
  }
  if (!files.length) {
    list.replaceChildren(el('p', { class: 'muted lib-empty' }, 'Nessun libro corrisponde alla ricerca.'));
    return;
  }
  const groups = new Map();
  for (const f of files) {
    const dir = dirName(f.path) || '(radice)';
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
            if (count) meta.push(count === 1 ? '1 annotazione' : `${count} annotazioni`);
            const offline = el('span', { class: 'badge-offline', hidden: true, title: 'Disponibile offline' }, 'offline');
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
                  el('span', { class: 'book-meta' }, meta.join(' · '), dirty.has(f.path) && el('span', { class: 'dot-pending', title: 'Modifiche da sincronizzare' }), offline),
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
    const folders = new Set(['matematica/libri', ...(app.files || []).map((f) => dirName(f.path)).filter(Boolean)]);
    $('#upload-folders').replaceChildren(...[...folders].map((d) => el('option', { value: d })));
    dialog.showModal();
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'ok') return;
    const folder = $('#upload-form').folder.value.trim().replace(/^\/+|\/+$/g, '');
    for (const file of app.uploadQueue) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`${file.name}: troppo grande (massimo 95 MB)`, { error: true, ms: 6000 });
        continue;
      }
      const name = safeName(file.name).replace(/(\.pdf)?$/i, '.pdf');
      const path = folder ? `${folder}/${name}` : name;
      const existing = app.files?.find((f) => f.path === path);
      if (existing && !confirm(`${path} esiste già. Sostituirlo?`)) continue;
      toast(`Carico ${name}…`, { ms: 5000 });
      try {
        await app.gh.putFile(path, { base64: await readAsBase64(file) }, existing?.sha, `reader: aggiunto ${name}`);
        toast(`${name} caricato`);
      } catch (err) {
        toast(`${name}: ${err.message}`, { error: true, ms: 8000 });
      }
    }
    app.uploadQueue = [];
    await renderLibrary();
  });
}

// ------------------------------------------------------------------ sync status & triggers

function renderSyncStatus(status) {
  for (const pill of document.querySelectorAll('[data-sync-pill]')) {
    pill.dataset.state = status.state;
    pill.title = `${status.message} · tocca per sincronizzare`;
    pill.querySelector('.sync-text').textContent = status.message;
  }
}

async function syncNow() {
  if (!app.sync) return;
  app.reader?.savePosition.flush();
  app.reader?.saveNote.flush();
  const tasks = [app.sync.syncAll()];
  if (app.reader?.book) tasks.push(app.sync.sync(app.reader.book));
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) toast(failed.reason?.status === 0 ? 'Offline: le modifiche restano salvate qui' : `Sincronizzazione non riuscita: ${failed.reason?.message}`, { error: true });
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
    } else if (app.reader?.book) {
      app.sync.sync(app.reader.book).catch(() => {}); // pull edits made on other devices
    }
  });
  window.addEventListener('pagehide', () => {
    if (!app.sync) return;
    app.reader?.savePosition.flush();
    app.reader?.saveNote.flush();
    app.sync.syncAll();
  });
  window.addEventListener('online', () => app.sync?.syncAll());
  const onFullscreen = () => {
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $('#btn-fullscreen use').setAttribute('href', full ? '#i-shrink' : '#i-expand');
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
}

// ------------------------------------------------------------------ start

bindSetup();
bindUpload();
bindGlobal();
const saved = loadConfig();
if (saved) {
  connect(saved);
  app.sync.syncAll();
}
route();
