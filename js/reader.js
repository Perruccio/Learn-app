// PDF reader: PDF.js viewer + highlights, area highlights and notes.
//
// Annotation geometry is stored as fractions of the page box ([x, y, w, h] in
// 0..1), so it is independent of zoom level and device.

import { $, el, debounce, clamp, isNarrow, prettyName, storage, toast, uid } from './util.js?v=a5f3b542b585';
import { liveAnnotations } from './sync.js?v=a5f3b542b585';

export const COLORS = ['yellow', 'green', 'blue', 'pink'];
const COLOR_LABELS = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' };
const TYPE_LABELS = { highlight: 'Highlight', area: 'Area', note: 'Note', bookmark: 'Bookmark' };

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
const PDF_CACHE = 'learn-reader-pdf-v1';
const PDF_CACHE_INDEX = 'learnreader:pdfcache';

let pdfjsLib = null;
let viewerLib = null;

async function loadPdfJs() {
  if (viewerLib) return;
  pdfjsLib = await import(`${VENDOR}build/pdf.min.mjs`);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}build/pdf.worker.min.mjs`;
  // pdf_viewer.mjs reads the library from this global when it is evaluated.
  globalThis.pdfjsLib = pdfjsLib;
  viewerLib = await import(`${VENDOR}web/pdf_viewer.mjs`);
}

function cacheKey(sha) {
  return `https://learn-reader.invalid/pdf/${sha}`;
}

export async function isPdfCached(sha) {
  try {
    const cache = await caches.open(PDF_CACHE);
    return !!(await cache.match(cacheKey(sha)));
  } catch {
    return false;
  }
}

/** PDF bytes from the device cache, or downloaded once from GitHub and cached. */
async function loadPdfBytes(gh, file, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(PDF_CACHE);
    const hit = await cache.match(cacheKey(file.sha));
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const data = await gh.getBlob(file.sha, onProgress, file.size);
  if (cache) {
    try {
      await cache.put(cacheKey(file.sha), new Response(data, { headers: { 'Content-Type': 'application/pdf' } }));
      const index = storage.get(PDF_CACHE_INDEX, {});
      const previous = index[file.path];
      if (previous && previous !== file.sha) await cache.delete(cacheKey(previous));
      index[file.path] = file.sha;
      storage.set(PDF_CACHE_INDEX, index);
    } catch {
      /* quota exceeded or storage disabled: just don't cache */
    }
  }
  return data;
}

/** Merge client rects that sit on the same text line into single boxes. */
function mergeLineRects(rects) {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out = [];
  for (const r of sorted) {
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top);
      const minHeight = Math.min(last.bottom - last.top, box.bottom - box.top);
      const gap = box.left - last.right;
      if (overlap > 0.5 * minHeight && gap < 0.6 * minHeight && box.right > last.left - 0.6 * minHeight) {
        last.left = Math.min(last.left, box.left);
        last.right = Math.max(last.right, box.right);
        last.top = Math.min(last.top, box.top);
        last.bottom = Math.max(last.bottom, box.bottom);
        continue;
      }
    }
    out.push(box);
  }
  return out;
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;

/** Inner (padding) box of a page element in client coordinates. */
function pageBox(pageEl) {
  const r = pageEl.getBoundingClientRect();
  return {
    left: r.left + pageEl.clientLeft,
    top: r.top + pageEl.clientTop,
    width: pageEl.clientWidth,
    height: pageEl.clientHeight,
  };
}

function contains(a, x, y, pad = 0.004) {
  return (a.rects || []).some(([rx, ry, rw, rh]) => x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad);
}

export class Reader {
  constructor({ sync, gh, onBack }) {
    this.sync = sync;
    this.gh = gh;
    this.onBack = onBack;
    this.root = $('#view-reader');
    this.container = $('#viewerContainer');
    this.viewerEl = $('#viewer');
    this.tool = 'select';
    this.color = COLORS.includes(storage.get('learnreader:color')) ? storage.get('learnreader:color') : 'yellow';
    this.file = null;
    this.book = null;
    this.doc = null;
    this.pdf = null;
    this.viewer = null;
    this.activeId = null;
    this.pendingSelection = null;
    this.drag = null;
    this.findQuery = '';
    this.jumps = []; // positions to return to after following a link (most recent last)

    this.savePosition = debounce((page) => {
      if (!this.book) return;
      this.sync.mutate(this.book, (d) => (d.lastPage = { page, at: Date.now() }), { schedule: false, silent: true });
    }, 1200);
    this.saveNote = debounce((id, text) => this._update(id, { note: text }), 500);

    this.attach(sync, gh);

    this._bindToolbar();
    this._bindPointer();
    this._bindSelection();
    this._bindPanel();
    this._bindPopover();
    this._bindPinch();
    new ResizeObserver(debounce(() => this._relayout(), 150)).observe(this.container);
  }

  /** Use a (new) sync manager and GitHub client, e.g. after reconnecting. */
  attach(sync, gh) {
    this.sync = sync;
    this.gh = gh;
    if (sync._readerBound) return;
    sync._readerBound = true;
    sync.addEventListener('change', (e) => {
      if (this.sync !== sync || e.detail.book !== this.book) return;
      this.doc = e.detail.doc;
      this.renderAllLayers();
      this.renderAnnotationList();
      if (this.activeId && (!this.doc.annotations[this.activeId] || this.doc.annotations[this.activeId].deleted)) this.closePopover();
    });
  }

  // ------------------------------------------------------------------ open / close

  async open(file, { page = null } = {}) {
    if (this.book) await this.close();
    this.file = file;
    this.book = file.path;
    this.doc = this.sync.load(file.path).doc;
    this.jumps = [];
    this._updateJumpButton();
    this.closePopover();
    this.setTool('select');
    $('#reader-title').textContent = prettyName(file.path);
    document.title = `${prettyName(file.path)} · Learn Reader`;
    $('#annotation-count').textContent = '';
    this._showLoading('Opening the book…');

    try {
      await loadPdfJs();
      const data = await loadPdfBytes(this.gh, file, (loaded, total) => {
        const mb = (n) => (n / 1048576).toFixed(1);
        this._showLoading(total ? `Downloading the book… ${mb(loaded)} / ${mb(total)} MB` : `Downloading the book… ${mb(loaded)} MB`, total ? loaded / total : null);
      });
      if (this.book !== file.path) return; // another book was opened meanwhile
      this._showLoading('Opening the book…');
      const pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: `${VENDOR}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${VENDOR}standard_fonts/`,
        // Security: never compile code from PDF data (CVE-2024-4367 class), no XFA forms.
        isEvalSupported: false,
        enableXfa: false,
      }).promise;
      if (this.book !== file.path) {
        pdf.destroy();
        return;
      }
      this.pdf = pdf;
      this._createViewer();
      const ready = new Promise((resolve) => this.eventBus.on('pagesinit', resolve, { once: true }));
      this.viewer.setDocument(pdf);
      this.linkService.setDocument(pdf, null);
      await ready;

      const savedZoom = storage.get(`learnreader:zoom:${file.path}`);
      this.viewer.currentScaleValue = savedZoom || (isNarrow() ? 'page-width' : 'auto');
      // The saved reading position wins over the requested page (e.g. a session's chapter):
      // the requested page is only used the first time the book is opened.
      const startPage = clamp(this.doc.lastPage?.page || page || 1, 1, pdf.numPages);
      this.viewer.currentPageNumber = startPage;
      $('#page-total').textContent = pdf.numPages;
      this._updatePageIndicator(startPage);
      this._hideLoading();
      this.renderAnnotationList();
      this._renderOutline();

      // Pull remote annotations in the background; follow the remote reading
      // position only if the user has not moved yet.
      const localPosition = this.doc.lastPage;
      this.sync
        .sync(file.path)
        .then((doc) => {
          if (this.book !== file.path || !this.viewer) return;
          const remote = doc.lastPage;
          if (remote && remote !== localPosition && remote.page !== startPage && this.viewer.currentPageNumber === startPage) {
            this.viewer.currentPageNumber = clamp(remote.page, 1, pdf.numPages);
          }
        })
        .catch(() => {});
    } catch (err) {
      console.error(err);
      this._showLoading(err.status === 404 ? 'Book not found in the repository.' : `Cannot open the book: ${err.message}`, null, true);
    }
  }

  async close() {
    if (!this.book) return;
    this.savePosition.flush();
    this.saveNote.flush();
    this.closePopover();
    this._hideSelectionBar();
    this._exitImmersive();
    const book = this.book;
    this.book = null;
    this.jumps = [];
    this._updateJumpButton();
    this.file = null;
    if (this.sync.dirtyBooks().includes(book)) this.sync.sync(book).catch(() => {});
    if (this.viewer) {
      this.viewer.setDocument(null);
      this.linkService.setDocument(null);
    }
    if (this.pdf) {
      const pdf = this.pdf;
      this.pdf = null;
      await pdf.destroy();
    }
    $('#outline').replaceChildren();
    $('#ann-list').replaceChildren();
  }

  _createViewer() {
    if (this.viewer) return;
    const { EventBus, LinkTarget, PDFLinkService, PDFFindController, PDFViewer } = viewerLib;
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      textLayerMode: 1,
      // Links only: no form fields, and PDF JavaScript is never executed (no scripting manager).
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      imageResourcesPath: `${VENDOR}web/images/`,
      removePageBorders: false,
    });
    this.linkService.setViewer(this.viewer);

    this.eventBus.on('pagerendered', ({ pageNumber }) => this.renderLayer(pageNumber));
    this.eventBus.on('textlayerrendered', ({ pageNumber }) => this.renderLayer(pageNumber));
    this.eventBus.on('pagechanging', ({ pageNumber }) => {
      this._updatePageIndicator(pageNumber);
      this.savePosition(pageNumber);
    });
    this.eventBus.on('scalechanging', ({ scale, presetValue }) => {
      this._updateZoomIndicator(scale, presetValue);
      if (this.book) storage.set(`learnreader:zoom:${this.book}`, presetValue || String(scale));
    });
    this.eventBus.on('updatefindmatchescount', ({ matchesCount }) => this._updateFindStatus(matchesCount));
    this.eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => this._updateFindStatus(matchesCount, state));
  }

  _relayout() {
    if (!this.viewer || !this.pdf) return;
    const value = this.viewer.currentScaleValue;
    if (['auto', 'page-width', 'page-fit'].includes(value)) this.viewer.currentScaleValue = value;
    else this.viewer.update();
  }

  // ------------------------------------------------------------------ loading overlay

  _showLoading(message, fraction = null, isError = false) {
    const box = $('#reader-loading');
    box.hidden = false;
    box.classList.toggle('is-error', isError);
    $('#reader-loading-text').textContent = message;
    const bar = $('#reader-loading-bar');
    bar.hidden = fraction === null;
    if (fraction !== null) bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
  }

  _hideLoading() {
    $('#reader-loading').hidden = true;
  }

  // ------------------------------------------------------------------ annotation layers

  _pageAnnotations() {
    const byPage = new Map();
    for (const a of liveAnnotations(this.doc)) {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    }
    return byPage;
  }

  _layerFor(pageNumber, create = true) {
    const pv = this.viewer?.getPageView(pageNumber - 1);
    if (!pv?.div) return null;
    let layer = pv.div.querySelector(':scope > .hl-layer');
    if (!layer && create) {
      layer = el('div', { class: 'hl-layer' });
      const canvasWrapper = pv.div.querySelector(':scope > .canvasWrapper');
      if (canvasWrapper) canvasWrapper.after(layer);
      else pv.div.prepend(layer);
    }
    return layer;
  }

  renderLayer(pageNumber, byPage = null) {
    if (!this.doc || !this.viewer) return;
    const annotations = (byPage || this._pageAnnotations()).get(pageNumber) || [];
    const layer = this._layerFor(pageNumber, annotations.length > 0);
    if (!layer) return;
    const nodes = [];
    for (const a of annotations) {
      const active = a.id === this.activeId ? ' is-active' : '';
      if (a.type === 'bookmark') {
        nodes.push(
          el('button', {
            class: `bm-ribbon c-${a.color}${active}`,
            type: 'button',
            title: a.note || 'Bookmark',
            'aria-label': 'Open bookmark',
            dataset: { id: a.id },
            style: { top: `${a.y * 100}%` },
            onclick: (e) => {
              e.stopPropagation();
              this.openPopover(a.id);
            },
          }),
        );
        continue;
      }
      if (a.type === 'note') {
        nodes.push(
          el(
            'button',
            {
              class: `note-pin c-${a.color}${active}`,
              type: 'button',
              title: a.note || 'Note',
              'aria-label': 'Open note',
              dataset: { id: a.id },
              style: { left: `${a.x * 100}%`, top: `${a.y * 100}%` },
              onclick: (e) => {
                e.stopPropagation();
                this.openPopover(a.id);
              },
            },
            el('span', { 'aria-hidden': 'true' }, '✎'),
          ),
        );
        continue;
      }
      for (const [x, y, w, h] of a.rects || []) {
        nodes.push(
          el('div', {
            class: `hl ${a.type === 'area' ? 'hl-area' : 'hl-text'} c-${a.color}${active}${a.note ? ' has-note' : ''}`,
            dataset: { id: a.id },
            style: { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` },
          }),
        );
      }
    }
    if (this.drag?.page === pageNumber && this.drag.draft) nodes.push(this.drag.draft);
    layer.replaceChildren(...nodes);
  }

  renderAllLayers() {
    if (!this.viewer || !this.pdf) return;
    const byPage = this._pageAnnotations();
    for (let i = 1; i <= this.viewer.pagesCount; i++) {
      if (byPage.has(i) || this._layerFor(i, false)) this.renderLayer(i, byPage);
    }
    this._updateCount();
  }

  _updateCount() {
    const count = liveAnnotations(this.doc).filter((a) => a.type !== 'bookmark').length;
    $('#annotation-count').textContent = count ? String(count) : '';
  }

  /** Save the current reading position as a named, reusable bookmark. */
  addBookmark() {
    if (!this.viewer || !this.pdf) return;
    const { page, y } = this._currentPosition();
    const id = this._add({ type: 'bookmark', page, y: clamp(y, 0, 1) });
    this.openPopover(id, { focus: true });
  }

  // ------------------------------------------------------------------ editing

  _add(annotation) {
    const now = Date.now();
    const a = { id: uid(), color: this.color, createdAt: now, updatedAt: now, ...annotation };
    this.sync.mutate(this.book, (d) => (d.annotations[a.id] = a));
    return a.id;
  }

  _update(id, changes) {
    if (!this.book) return;
    this.sync.mutate(this.book, (d) => {
      const a = d.annotations[id];
      if (a) Object.assign(a, changes, { updatedAt: Date.now() });
    });
  }

  _delete(id) {
    const before = this.doc.annotations[id];
    if (!before) return;
    const snapshot = { ...before };
    this.sync.mutate(this.book, (d) => {
      const a = d.annotations[id];
      if (a) d.annotations[id] = { id, type: a.type, page: a.page, createdAt: a.createdAt, updatedAt: Date.now(), deleted: true };
    });
    this.closePopover();
    const book = this.book;
    toast('Annotation deleted', {
      action: {
        label: 'Undo',
        fn: () => this.sync.mutate(book, (d) => (d.annotations[id] = { ...snapshot, updatedAt: Date.now() })),
      },
    });
  }

  setColor(color) {
    this.color = color;
    storage.set('learnreader:color', color);
    for (const b of document.querySelectorAll('[data-color-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.colorChoice === color));
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.root.dataset.mode = tool;
    for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    if (tool !== 'select') this._hideSelectionBar();
    const hint = $('#tool-hint');
    hint.hidden = tool === 'select';
    hint.textContent = tool === 'area' ? 'Drag on the page to highlight an area' : 'Tap the page where you want the note';
  }

  // ------------------------------------------------------------------ text selection

  _bindSelection() {
    const onChange = debounce(() => this._onSelectionChange(), 180);
    document.addEventListener('selectionchange', onChange);
    const bar = $('#selection-bar');
    // Keep the selection alive while tapping the bar.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    for (const color of COLORS) {
      bar.querySelector('.sel-colors').append(
        el('button', {
          class: `swatch c-${color}`,
          type: 'button',
          title: `Highlight (${COLOR_LABELS[color]})`,
          'aria-label': `Highlight in ${COLOR_LABELS[color].toLowerCase()}`,
          onclick: () => this._highlightSelection(color),
        }),
      );
    }
    $('#sel-note').addEventListener('click', () => this._highlightSelection(this.color, true));
    $('#sel-cancel').addEventListener('click', () => {
      window.getSelection()?.removeAllRanges();
      this._hideSelectionBar();
    });
  }

  _onSelectionChange() {
    if (!this.book || this.tool !== 'select') return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.pendingSelection = null;
      this._hideSelectionBar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!this.container.contains(range.commonAncestorContainer)) return;
    const pieces = this._selectionPieces(range);
    if (!pieces.length) return;
    this.pendingSelection = { pieces, text: sel.toString().replace(/\s+/g, ' ').trim().slice(0, 4000) };
    $('#selection-bar').hidden = false;
  }

  _hideSelectionBar() {
    $('#selection-bar').hidden = true;
  }

  /** Split a DOM range into per-page lists of normalized rectangles. */
  _selectionPieces(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentNode;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        range.intersectsNode(n) && n.parentElement?.closest('.textLayer') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const perPage = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const pageEl = n.parentElement.closest('.page');
      if (!pageEl) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      if (r.collapsed) continue;
      if (!perPage.has(pageEl)) perPage.set(pageEl, []);
      for (const rect of r.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5) perPage.get(pageEl).push(rect);
    }
    const pieces = [];
    for (const [pageEl, rects] of perPage) {
      if (!rects.length) continue;
      const box = pageBox(pageEl);
      const normalized = mergeLineRects(rects)
        .map((r) => [
          round5((r.left - box.left) / box.width),
          round5((r.top - box.top) / box.height),
          round5((r.right - r.left) / box.width),
          round5((r.bottom - r.top) / box.height),
        ])
        .filter(([, , w, h]) => w > 0 && h > 0 && h < 0.2);
      if (normalized.length) pieces.push({ page: Number(pageEl.dataset.pageNumber), rects: normalized });
    }
    return pieces.sort((a, b) => a.page - b.page);
  }

  _highlightSelection(color, withNote = false) {
    const sel = this.pendingSelection;
    if (!sel || !this.book) return;
    this.setColor(color);
    let firstId = null;
    for (const piece of sel.pieces) {
      const id = this._add({ type: 'highlight', page: piece.page, color, text: sel.text, rects: piece.rects });
      firstId ??= id;
    }
    this.pendingSelection = null;
    window.getSelection()?.removeAllRanges();
    this._hideSelectionBar();
    if (withNote && firstId) this.openPopover(firstId, { focus: true });
  }

  // ------------------------------------------------------------------ pointer: area, note, hit-test

  _normPoint(pageEl, clientX, clientY) {
    const box = pageBox(pageEl);
    return { x: clamp((clientX - box.left) / box.width, 0, 1), y: clamp((clientY - box.top) / box.height, 0, 1) };
  }

  _bindPointer() {
    const c = this.container;
    c.addEventListener('pointerdown', (e) => {
      if (this.tool === 'select') this.suppressClick = false;
      if (this.tool === 'select' || !this.book || e.button > 0) return;
      const pageEl = e.target.closest('.page');
      if (!pageEl) return;
      e.preventDefault();
      this.suppressClick = true; // the click that follows this gesture is not a hit-test
      const page = Number(pageEl.dataset.pageNumber);
      const p = this._normPoint(pageEl, e.clientX, e.clientY);
      if (this.tool === 'note') {
        const id = this._add({ type: 'note', page, x: round5(p.x), y: round5(p.y), note: '' });
        this.setTool('select');
        this.openPopover(id, { focus: true });
        return;
      }
      const draft = el('div', { class: `hl hl-area hl-draft c-${this.color}` });
      this.drag = { pageEl, page, start: p, end: p, draft, pointerId: e.pointerId };
      this._layerFor(page)?.append(draft);
      this._updateDraft();
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag.end = this._normPoint(this.drag.pageEl, e.clientX, e.clientY);
      this._updateDraft();
    });
    const finish = (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { start, end, page, draft } = this.drag;
      this.drag = null;
      draft.remove();
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      this.setTool('select');
      if (e.type === 'pointerup' && w > 0.01 && h > 0.006) {
        this._add({ type: 'area', page, rects: [[round5(x), round5(y), round5(w), round5(h)]] });
      }
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);

    // External links inside a PDF: never follow silently. Show the full address and ask.
    c.addEventListener(
      'click',
      (e) => {
        const link = e.target.closest('.annotationLayer a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (href.startsWith('#')) {
          // Internal destination inside the book: remember where we were so we can come back.
          this._pushJump();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        let url;
        try {
          url = new URL(href, location.href);
        } catch {
          return;
        }
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return;
        if (confirm(`The PDF contains an external link:\n\n${url.href}\n\nOpen it in a new tab?`)) {
          window.open(url.href, '_blank', 'noopener,noreferrer');
        }
      },
      true,
    );

    c.addEventListener('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (this.tool !== 'select' || !this.book) return;
      if (e.target.closest('.note-pin, .annotationLayer a, .annotationLayer section')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const pageEl = e.target.closest('.page');
      if (!pageEl) return this.closePopover();
      const page = Number(pageEl.dataset.pageNumber);
      const p = this._normPoint(pageEl, e.clientX, e.clientY);
      const hits = (this._pageAnnotations().get(page) || []).filter((a) => a.type !== 'note' && contains(a, p.x, p.y));
      if (hits.length) {
        hits.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        this.openPopover(hits[0].id);
      } else {
        this.closePopover();
      }
    });
  }

  _updateDraft() {
    const { start, end, draft } = this.drag;
    Object.assign(draft.style, {
      left: `${Math.min(start.x, end.x) * 100}%`,
      top: `${Math.min(start.y, end.y) * 100}%`,
      width: `${Math.abs(end.x - start.x) * 100}%`,
      height: `${Math.abs(end.y - start.y) * 100}%`,
    });
  }

  // ------------------------------------------------------------------ popover (edit one annotation)

  _bindPopover() {
    const pop = $('#popover');
    const colors = pop.querySelector('.pop-colors');
    for (const color of COLORS) {
      colors.append(
        el('button', {
          class: `swatch swatch-sm c-${color}`,
          type: 'button',
          'aria-label': COLOR_LABELS[color],
          dataset: { popColor: color },
          onclick: () => {
            if (!this.activeId) return;
            this._update(this.activeId, { color });
            this.setColor(color);
            this._syncPopoverColors(color);
          },
        }),
      );
    }
    const note = $('#pop-note');
    note.addEventListener('input', () => this.activeId && this.saveNote(this.activeId, note.value));
    $('#pop-delete').addEventListener('click', () => this.activeId && this._delete(this.activeId));
    $('#pop-done').addEventListener('click', () => this.closePopover());
    $('#pop-close').addEventListener('click', () => this.closePopover());
  }

  _syncPopoverColors(color) {
    for (const b of $('#popover').querySelectorAll('[data-pop-color]')) b.setAttribute('aria-pressed', String(b.dataset.popColor === color));
  }

  openPopover(id, { focus = false } = {}) {
    const a = this.doc?.annotations[id];
    if (!a || a.deleted) return;
    this.saveNote.flush();
    const previous = this.activeId;
    this.activeId = id;
    $('#pop-meta').textContent = `${TYPE_LABELS[a.type] || 'Annotation'} · p. ${a.page}`;
    const quote = $('#pop-quote');
    quote.textContent = a.text || '';
    quote.hidden = !a.text;
    const note = $('#pop-note');
    note.value = a.note || '';
    note.placeholder = a.type === 'bookmark' ? 'Name this bookmark…' : 'Write a note…';
    this._syncPopoverColors(a.color);
    $('#popover').hidden = false;
    if (previous) this.renderLayer(this.doc.annotations[previous]?.page);
    this.renderLayer(a.page);
    if (focus) note.focus({ preventScroll: true }); // synchronous: keeps the user gesture so mobile keyboards open
  }

  closePopover() {
    if (!this.activeId) {
      $('#popover').hidden = true;
      return;
    }
    this.saveNote.flush();
    const page = this.doc?.annotations[this.activeId]?.page;
    this.activeId = null;
    $('#popover').hidden = true;
    if (page) this.renderLayer(page);
  }

  // ------------------------------------------------------------------ navigation

  goToAnnotation(a) {
    if (!this.viewer) return;
    if (a.type === 'bookmark') {
      this._pushJump();
      this._scrollTo(a);
      return;
    }
    this.viewer.scrollPageIntoView({ pageNumber: a.page });
    requestAnimationFrame(() => {
      const pageEl = this.viewer.getPageView(a.page - 1)?.div;
      if (!pageEl) return;
      const y = a.type === 'note' ? a.y : a.rects?.[0]?.[1] ?? 0;
      const pr = pageEl.getBoundingClientRect();
      const cr = this.container.getBoundingClientRect();
      this.container.scrollTop += pr.top - cr.top + pageEl.clientTop + y * pageEl.clientHeight - cr.height * 0.3;
    });
  }

  /** Current reading position: page and vertical offset of the viewport top, in page heights. */
  _currentPosition() {
    const page = this.viewer.currentPageNumber;
    const pageEl = this.viewer.getPageView(page - 1)?.div;
    if (!pageEl || !pageEl.clientHeight) return { page, y: 0 };
    const pr = pageEl.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    return { page, y: clamp((cr.top - pr.top) / pageEl.clientHeight, -1, 2) };
  }

  /** Remember the current position before a jump (link, outline, page number). */
  _pushJump() {
    if (!this.viewer || !this.pdf) return;
    const pos = this._currentPosition();
    const last = this.jumps[this.jumps.length - 1];
    if (!last || last.page !== pos.page || Math.abs(last.y - pos.y) > 0.02) {
      this.jumps.push(pos);
      if (this.jumps.length > 50) this.jumps.shift();
    }
    this._updateJumpButton();
  }

  /** Return to the position saved before the most recent jump. */
  jumpBack() {
    const pos = this.jumps.pop();
    this._updateJumpButton();
    this._scrollTo(pos);
  }

  /** Scroll so that the viewport top is at `y` page heights into `page`. */
  _scrollTo(pos) {
    if (!pos || !this.viewer || !this.pdf) return;
    const page = clamp(pos.page, 1, this.pdf.numPages);
    this.viewer.scrollPageIntoView({ pageNumber: page });
    requestAnimationFrame(() => {
      const pageEl = this.viewer?.getPageView(page - 1)?.div;
      if (!pageEl) return;
      const pr = pageEl.getBoundingClientRect();
      const cr = this.container.getBoundingClientRect();
      this.container.scrollTop += pr.top - cr.top + pos.y * pageEl.clientHeight;
    });
  }

  _updateJumpButton() {
    const btn = $('#btn-jump-back');
    const last = this.jumps[this.jumps.length - 1];
    btn.hidden = !last;
    if (!last) return;
    $('#jump-back-label').textContent = `p. ${last.page}`;
    btn.title = `Back to page ${last.page} (Alt+←)`;
    btn.setAttribute('aria-label', `Back to page ${last.page}`);
  }

  _updatePageIndicator(pageNumber) {
    const input = $('#page-input');
    if (document.activeElement !== input) input.value = pageNumber;
  }

  _updateZoomIndicator(scale, presetValue) {
    const select = $('#zoom-select');
    const custom = $('#zoom-custom');
    if (presetValue && [...select.options].some((o) => o.value === presetValue)) {
      select.value = presetValue;
      return;
    }
    const match = [...select.options].find((o) => o.value !== 'custom' && Number(o.value) === Math.round(scale * 100) / 100);
    if (match) {
      select.value = match.value;
    } else {
      custom.textContent = `${Math.round(scale * 100)}%`;
      custom.hidden = false;
      select.value = 'custom';
    }
  }

  // ------------------------------------------------------------------ toolbar

  _bindToolbar() {
    $('#btn-back').addEventListener('click', () => this.onBack());
    $('#page-prev').addEventListener('click', () => this.viewer && this.viewer.previousPage());
    $('#page-next').addEventListener('click', () => this.viewer && this.viewer.nextPage());
    const input = $('#page-input');
    input.addEventListener('change', () => {
      if (!this.pdf) return;
      const n = clamp(parseInt(input.value, 10) || 1, 1, this.pdf.numPages);
      if (n !== this.viewer.currentPageNumber) this._pushJump();
      this.viewer.currentPageNumber = n;
      input.value = n;
      input.blur();
    });
    input.addEventListener('focus', () => input.select());
    $('#zoom-out').addEventListener('click', () => this.viewer?.decreaseScale());
    $('#zoom-in').addEventListener('click', () => this.viewer?.increaseScale());
    $('#zoom-select').addEventListener('change', (e) => {
      if (!this.viewer || e.target.value === 'custom') return;
      this.viewer.currentScaleValue = e.target.value;
    });
    for (const b of document.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => this.setTool(this.tool === b.dataset.tool ? 'select' : b.dataset.tool));
    }
    const colorBox = $('#tool-colors');
    for (const color of COLORS) {
      colorBox.append(
        el('button', {
          class: `swatch swatch-sm c-${color}`,
          type: 'button',
          title: `Color: ${COLOR_LABELS[color]}`,
          'aria-label': `Color ${COLOR_LABELS[color].toLowerCase()}`,
          dataset: { colorChoice: color },
          onclick: () => this.setColor(color),
        }),
      );
    }
    this.setColor(this.color);
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#btn-exit-immersive').addEventListener('click', () => this._exitImmersive());
    $('#btn-jump-back').addEventListener('click', () => this.jumpBack());
    $('#btn-bookmark').addEventListener('click', () => this.addBookmark());

    document.addEventListener('keydown', (e) => {
      if (!this.book || this.root.hidden) return;
      const typing = e.target.closest?.('input, textarea, select');
      if (e.key === 'Escape') {
        if (!$('#popover').hidden) this.closePopover();
        else if (this.tool !== 'select') this.setTool('select');
        else if (this.root.classList.contains('immersive')) this._exitImmersive();
        return;
      }
      if (!typing && e.altKey && e.key === 'ArrowLeft' && this.jumps.length) {
        e.preventDefault();
        this.jumpBack();
        return;
      }
      if (typing || e.metaKey || e.altKey) return;
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        this.openPanel('search');
        $('#find-input').focus();
      } else if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        this.viewer?.increaseScale();
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        this.viewer?.decreaseScale();
      } else if (!e.ctrlKey && e.key === 'f') {
        this.toggleFullscreen();
      } else if (!e.ctrlKey && e.key === 'b') {
        this.addBookmark();
      }
    });

    this.container.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || !this.viewer) return;
        e.preventDefault();
        this.viewer.updateScale({ scaleFactor: Math.exp(-e.deltaY / 300), origin: [e.clientX, e.clientY], drawingDelay: 300 });
      },
      { passive: false },
    );
  }

  toggleFullscreen() {
    const docEl = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (this.root.classList.contains('immersive')) {
      this._exitImmersive();
    } else if (docEl.requestFullscreen) {
      docEl.requestFullscreen().catch(() => this._enterImmersive());
    } else if (docEl.webkitRequestFullscreen) {
      docEl.webkitRequestFullscreen();
    } else {
      this._enterImmersive(); // iPhone Safari: no Fullscreen API for pages
    }
  }

  _enterImmersive() {
    this.root.classList.add('immersive');
    $('#btn-exit-immersive').hidden = false;
  }

  _exitImmersive() {
    this.root.classList.remove('immersive');
    $('#btn-exit-immersive').hidden = true;
  }

  // ------------------------------------------------------------------ pinch zoom (touch)

  _bindPinch() {
    const c = this.container;
    let gesture = null;
    const distance = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midpoint = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
    c.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2 && this.viewer) {
          gesture = { start: distance(e.touches), ratio: 1, origin: midpoint(e.touches) };
          const vr = this.viewerEl.getBoundingClientRect();
          this.viewerEl.style.transformOrigin = `${gesture.origin[0] - vr.left}px ${gesture.origin[1] - vr.top}px`;
        }
      },
      { passive: true },
    );
    c.addEventListener(
      'touchmove',
      (e) => {
        if (!gesture || e.touches.length !== 2) return;
        e.preventDefault();
        gesture.ratio = clamp(distance(e.touches) / gesture.start, 0.25, 4);
        this.viewerEl.style.transform = `scale(${gesture.ratio})`;
      },
      { passive: false },
    );
    const end = (e) => {
      if (!gesture || e.touches.length >= 2) return;
      const { ratio, origin } = gesture;
      gesture = null;
      this.viewerEl.style.transform = '';
      if (Math.abs(ratio - 1) > 0.03) this.viewer.updateScale({ scaleFactor: ratio, origin });
    };
    c.addEventListener('touchend', end);
    c.addEventListener('touchcancel', end);
  }

  // ------------------------------------------------------------------ side panel

  _bindPanel() {
    $('#btn-panel').addEventListener('click', () => (this.root.classList.contains('panel-open') ? this.closePanel() : this.openPanel()));
    $('#panel-close').addEventListener('click', () => this.closePanel());
    for (const tab of document.querySelectorAll('[data-panel-tab]')) {
      tab.addEventListener('click', () => this.openPanel(tab.dataset.panelTab));
    }
    const form = $('#find-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._find(false);
    });
    $('#find-prev').addEventListener('click', () => this._find(true));
    $('#find-next').addEventListener('click', () => this._find(false));
  }

  openPanel(tab = storage.get('learnreader:panelTab', 'notes')) {
    this.root.classList.add('panel-open');
    $('#panel').hidden = false;
    storage.set('learnreader:panelTab', tab);
    for (const t of document.querySelectorAll('[data-panel-tab]')) t.setAttribute('aria-selected', String(t.dataset.panelTab === tab));
    for (const body of document.querySelectorAll('[data-panel-body]')) body.hidden = body.dataset.panelBody !== tab;
  }

  closePanel() {
    this.root.classList.remove('panel-open');
    $('#panel').hidden = true;
  }

  renderAnnotationList() {
    const all = this.doc ? liveAnnotations(this.doc) : [];
    this._renderList($('#ann-list'), $('#ann-empty'), all.filter((a) => a.type !== 'bookmark'));
    this._renderList($('#bm-list'), $('#bm-empty'), all.filter((a) => a.type === 'bookmark'));
    this._updateCount();
  }

  _renderList(list, empty, items) {
    empty.hidden = items.length > 0;
    list.replaceChildren(
      ...items.map((a) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              class: 'ann-item',
              type: 'button',
              dataset: { id: a.id },
              onclick: () => {
                if (isNarrow()) this.closePanel();
                this.goToAnnotation(a);
                if (a.type !== 'bookmark') this.openPopover(a.id);
              },
            },
            el('span', { class: `ann-swatch c-${a.color}`, 'aria-hidden': 'true' }),
            el(
              'span',
              { class: 'ann-body' },
              el('span', { class: 'ann-meta' }, `p. ${a.page} · ${TYPE_LABELS[a.type] || ''}`),
              a.text && el('span', { class: 'ann-text' }, a.text),
              a.note && el('span', { class: 'ann-note' }, a.note),
            ),
          ),
        ),
      ),
    );
  }

  async _renderOutline() {
    const root = $('#outline');
    root.replaceChildren();
    let outline = null;
    try {
      outline = await this.pdf?.getOutline();
    } catch {
      outline = null;
    }
    $('#outline-empty').hidden = !!outline?.length;
    if (!outline?.length) return;
    const build = (items, depth) =>
      el(
        'ul',
        { class: depth ? 'outline-sub' : 'outline-root' },
        items.map((item) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                class: 'outline-item',
                type: 'button',
                disabled: !item.dest,
                onclick: () => {
                  if (!item.dest) return;
                  this._pushJump();
                  this.linkService.goToDestination(item.dest);
                  if (isNarrow()) this.closePanel();
                },
              },
              item.title,
            ),
            item.items?.length ? build(item.items, depth + 1) : null,
          ),
        ),
      );
    root.append(build(outline, 0));
  }

  _find(previous) {
    const query = $('#find-input').value.trim();
    if (!query || !this.eventBus) return;
    const again = query === this.findQuery;
    this.findQuery = query;
    this.eventBus.dispatch('find', {
      source: this,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  _updateFindStatus(matchesCount, state) {
    const status = $('#find-status');
    if (state === 1 /* NOT_FOUND */ || (matchesCount && matchesCount.total === 0)) {
      status.textContent = 'No results';
    } else if (matchesCount?.total) {
      status.textContent = `${matchesCount.current} of ${matchesCount.total}`;
    }
  }
}
