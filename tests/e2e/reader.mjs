// End-to-end test of Learn Reader against an in-memory mock of the GitHub API.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { APP, ORIGIN, CONTENT_DIR, FIXTURES, SHOTS, devices, launch } from '../lib/env.mjs';


// ------------------------------------------------------------------ mock GitHub
function gitSha(buf) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
}
const repo = new Map(); // path -> {buf, sha}
function putRepo(p, buf) {
  repo.set(p, { buf, sha: gitSha(buf) });
}
putRepo('math/books/axler-ladr-4ed.pdf', fs.readFileSync(path.join(FIXTURES, 'book.pdf')));
putRepo('math/books/williams.pdf', fs.readFileSync(path.join(FIXTURES, 'book.pdf')));
putRepo('README.md', Buffer.from('# Learn\n'));
const log = [];
let forceConflictOnce = false;
let networkDown = false;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length',
};

async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (networkDown) return route.abort('internetdisconnected');
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const json = (status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (req.headers()['authorization'] !== 'Bearer good-token') return json(401, { message: 'Bad credentials' });
  const p = decodeURIComponent(url.pathname);
  log.push(`${method} ${p}`);
  if (p === '/repos/Perruccio/Learn') return json(200, { full_name: 'Perruccio/Learn' });
  if (p === '/repos/Perruccio/Learn/git/trees/main') {
    return json(200, { truncated: false, tree: [...repo].map(([k, v]) => ({ path: k, type: 'blob', sha: v.sha, size: v.buf.length })) });
  }
  let m = p.match(/^\/repos\/Perruccio\/Learn\/git\/blobs\/([0-9a-f]+)$/);
  if (m) {
    const entry = [...repo.values()].find((v) => v.sha === m[1]);
    if (!entry) return json(404, { message: 'Not Found' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(entry.buf.length) }, body: entry.buf });
  }
  m = p.match(/^\/repos\/Perruccio\/Learn\/contents\/(.+)$/);
  if (m) {
    const file = m[1];
    if (method === 'GET') {
      const entry = repo.get(file);
      if (!entry) return json(404, { message: 'Not Found' });
      return json(200, { sha: entry.sha, content: entry.buf.toString('base64'), encoding: 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(req.postData());
      const entry = repo.get(file);
      if (forceConflictOnce) {
        forceConflictOnce = false;
        // simulate another device pushing first
        return json(409, { message: 'is at abc but expected def' });
      }
      if (entry && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (entry && body.sha !== entry.sha) return json(409, { message: 'sha mismatch' });
      if (!entry && body.sha) return json(404, { message: 'Not Found' });
      putRepo(file, Buffer.from(body.content, 'base64'));
      log.push(`  -> ${body.message}`);
      return json(entry ? 200 : 201, { content: { path: file, sha: repo.get(file).sha } });
    }
  }
  return json(404, { message: `unmocked ${p}` });
}

// ------------------------------------------------------------------ helpers
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}
const remoteAnn = () => {
  const e = repo.get('math/books/axler-ladr-4ed.annotations.json');
  return e ? JSON.parse(e.buf.toString()) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newDevice(browser, opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route('https://api.github.com/**', handle);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' || /Content Security Policy/.test(m.text())) && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  return { ctx, page, errors };
}

async function setup(page) {
  await page.goto(APP);
  await page.waitForSelector('#view-setup:not([hidden])');
  await page.fill('#setup-form [name=token]', 'good-token');
  await page.click('#setup-submit');
  await page.waitForSelector('#view-library:not([hidden]) .book-card');
}

async function openBook(page, hash = '#read=math/books/axler-ladr-4ed.pdf') {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForSelector('#viewer .page[data-page-number="1"] .textLayer span', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#reader-loading').hidden);
}

/** Select characters [from, to) of the n-th text span on a page. */
async function selectText(page, pageNumber, spanIndex, from, to) {
  await page.evaluate(
    ({ pageNumber, spanIndex, from, to }) => {
      const spans = [...document.querySelectorAll(`.page[data-page-number="${pageNumber}"] .textLayer span`)].filter((s) => s.firstChild?.nodeType === 3);
      const node = spans[spanIndex].firstChild;
      const r = document.createRange();
      r.setStart(node, from);
      r.setEnd(node, Math.min(to, node.length));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    },
    { pageNumber, spanIndex, from, to },
  );
  await page.waitForSelector('#selection-bar:not([hidden])');
}

// ------------------------------------------------------------------ run
const browser = await launch();

// Device A: desktop
const A = await newDevice(browser, { viewport: { width: 1280, height: 860 } });
await setup(A.page);
check('library lists the two PDFs', (await A.page.$$('.book-card')).length === 2);
await A.page.screenshot({ path: `${SHOTS}/01-library.png` });

await openBook(A.page);
check('pdf renders with text layer', await A.page.$('.page[data-page-number="1"] canvas'));
check('page total shown', (await A.page.textContent('#page-total')) === '6');

// 1. Text highlight
await selectText(A.page, 1, 1, 0, 40);
await A.page.screenshot({ path: `${SHOTS}/02-selection.png` });
await A.page.click('#selection-bar .swatch.c-yellow');
await A.page.waitForSelector('.page[data-page-number="1"] .hl-text.c-yellow');
const hlBox = await A.page.$eval('.page[data-page-number="1"] .hl-text', (e) => e.getBoundingClientRect().toJSON());
check('highlight drawn with sensible size', hlBox.width > 50 && hlBox.height > 5 && hlBox.height < 40, JSON.stringify({ w: Math.round(hlBox.width), h: Math.round(hlBox.height) }));
check('status pending right after edit', (await A.page.getAttribute('[data-sync-pill]', 'data-state')) === 'pending');
const t0 = Date.now();
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
check('auto-sync within ~5s', Date.now() - t0 < 9000, `${Date.now() - t0} ms`);
let remote = remoteAnn();
check('remote file has the highlight', remote?.annotations?.length === 1 && remote.annotations[0].type === 'highlight' && remote.annotations[0].text.startsWith('Line 1'), remote?.annotations?.[0]?.text);

// 2. Highlight stays aligned after zoom
const before = await A.page.$eval('.page[data-page-number="1"] .hl-text', (e) => {
  const p = e.closest('.page').getBoundingClientRect();
  const r = e.getBoundingClientRect();
  return [(r.left - p.left) / p.width, (r.top - p.top) / p.height];
});
await A.page.click('#zoom-in');
await A.page.click('#zoom-in');
await A.page.waitForSelector('.page[data-page-number="1"] .hl-text');
await sleep(800);
const after = await A.page.$eval('.page[data-page-number="1"] .hl-text', (e) => {
  const p = e.closest('.page').getBoundingClientRect();
  const r = e.getBoundingClientRect();
  return [(r.left - p.left) / p.width, (r.top - p.top) / p.height];
});
check('highlight position stable across zoom', Math.abs(before[0] - after[0]) < 0.01 && Math.abs(before[1] - after[1]) < 0.01, `${before.map((x) => x.toFixed(3))} vs ${after.map((x) => x.toFixed(3))}`);
// highlight covers the selected text: compare with the span's own rect
const cover = await A.page.evaluate(() => {
  const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter((s) => s.firstChild?.nodeType === 3)[1];
  const r = document.createRange();
  r.setStart(span.firstChild, 0);
  r.setEnd(span.firstChild, 40);
  const t = r.getBoundingClientRect();
  const h = document.querySelector('.page[data-page-number="1"] .hl-text').getBoundingClientRect();
  return { dx: Math.abs(t.left - h.left), dw: Math.abs(t.width - h.width), dy: Math.abs(t.top - h.top) };
});
check('highlight matches selected text geometry after zoom', cover.dx < 3 && cover.dw < 4 && cover.dy < 3, JSON.stringify(cover));
await A.page.selectOption('#zoom-select', 'auto');

// 3. Note on a highlight via popover
await A.page.click('.page[data-page-number="1"] .hl-text', { force: true });
await A.page.waitForSelector('#popover:not([hidden])');
await A.page.fill('#pop-note', 'Key definition: review the axioms');
await A.page.click('#pop-done');
check('popover closes', await A.page.$eval('#popover', (e) => e.hidden));

// 4. Area highlight on page 2
await A.page.fill('#page-input', '2');
await A.page.press('#page-input', 'Enter');
await sleep(500);
await A.page.click('[data-tool="area"]');
const p2 = await A.page.$eval('.page[data-page-number="2"]', (e) => e.getBoundingClientRect().toJSON());
await A.page.mouse.move(p2.x + p2.width * 0.2, p2.y + p2.height * 0.3);
await A.page.mouse.down();
await A.page.mouse.move(p2.x + p2.width * 0.5, p2.y + p2.height * 0.4, { steps: 5 });
await A.page.mouse.up();
await A.page.waitForSelector('.page[data-page-number="2"] .hl-area');
check('area tool resets to select', (await A.page.getAttribute('#view-reader', 'data-mode')) === 'select');

// 5. Page note on page 2
await A.page.click('[data-tool="note"]');
await A.page.mouse.click(p2.x + p2.width * 0.8, p2.y + p2.height * 0.2);
await A.page.waitForSelector('#popover:not([hidden])');
await sleep(100);
check('note popover focused', await A.page.evaluate(() => document.activeElement?.id === 'pop-note'));
await A.page.keyboard.type('Exercise 3 unclear');
await sleep(700);
check('popover still open after typing (no stray click close)', await A.page.$eval('#popover', (e) => !e.hidden));
await A.page.keyboard.press('Escape');
await A.page.waitForSelector('.page[data-page-number="2"] .note-pin');

// 6. Panel lists annotations; outline present
await A.page.click('#btn-panel');
await A.page.waitForSelector('#panel:not([hidden]) .ann-item');
check('panel lists 3 annotations', (await A.page.$$('.ann-item')).length === 3);
await A.page.screenshot({ path: `${SHOTS}/03-reader-panel.png` });
await A.page.click('[data-panel-tab="outline"]');
check('outline rendered', (await A.page.$$('.outline-item')).length === 6);
await A.page.click('.outline-item >> text=Chapter 5: Topic 5');
await sleep(600);
check('outline navigates', Number(await A.page.inputValue('#page-input')) === 5);
check('back button appears after an outline jump', await A.page.isVisible('#btn-jump-back'));
await A.page.click('[data-panel-tab="search"]');
await A.page.fill('#find-input', 'vector space');
await A.page.press('#find-input', 'Enter');
await sleep(1200);
check('search finds matches', /of \d+/.test(await A.page.textContent('#find-status')), await A.page.textContent('#find-status'));
check('search highlights matches', (await A.page.$$('.textLayer .highlight')).length > 0);
await A.page.click('[data-panel-tab="outline"]');
await sleep(400);
check('leaving the search tab clears the highlights', (await A.page.$$('.textLayer .highlight')).length === 0);
await A.page.click('[data-panel-tab="search"]');
await A.page.press('#find-input', 'Enter');
await sleep(1200);
check('searching again restores the highlights', (await A.page.$$('.textLayer .highlight')).length > 0);
await A.page.click('#panel-close');
await sleep(400);
check('closing the panel clears the highlights', (await A.page.$$('.textLayer .highlight')).length === 0);

// 6b. Back button after following an internal PDF link
let dialogs = 0;
const onDialog = (d) => {
  dialogs++;
  d.dismiss();
};
A.page.on('dialog', onDialog);
await A.page.fill('#page-input', '1');
await A.page.press('#page-input', 'Enter');
await sleep(400);
const internalLink = A.page.locator('.page[data-page-number="1"] .annotationLayer a').first();
await internalLink.scrollIntoViewIfNeeded();
await A.page.evaluate(() => (document.querySelector('#viewerContainer').scrollTop += 150)); // a non-trivial offset
await sleep(300);
const beforeJump = await A.page.evaluate(() => ({ top: document.querySelector('#viewerContainer').scrollTop, page: document.querySelector('#page-input').value }));
await internalLink.click();
await sleep(600);
check('internal link jumps to page 5 without confirmation', Number(await A.page.inputValue('#page-input')) === 5 && dialogs === 0, `page ${await A.page.inputValue('#page-input')}, dialogs ${dialogs}`);
await A.page.screenshot({ path: `${SHOTS}/03b-jump-back.png` });
check('back button shows the origin page', (await A.page.textContent('#jump-back-label')) === `p. ${beforeJump.page}`, await A.page.textContent('#jump-back-label'));
await A.page.click('#btn-jump-back');
await sleep(600);
const afterBack = await A.page.evaluate(() => document.querySelector('#viewerContainer').scrollTop);
check('back button returns to the exact position', Math.abs(afterBack - beforeJump.top) < 4, `${beforeJump.top} -> ${afterBack}`);
const olderLabel = await A.page.textContent('#jump-back-label');
await A.page.keyboard.press('Alt+ArrowLeft');
await sleep(600);
check('Alt+Left walks further back', `p. ${await A.page.inputValue('#page-input')}` === olderLabel, `${olderLabel} vs p. ${await A.page.inputValue('#page-input')}`);
A.page.off('dialog', onDialog);

await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
remote = remoteAnn();
check('remote has 3 annotations incl. notes', remote.annotations.length === 3 && remote.annotations.some((a) => a.note === 'Key definition: review the axioms') && remote.annotations.some((a) => a.type === 'note' && a.note === 'Exercise 3 unclear'));

// 7. Reading position is synced when leaving the book
await A.page.fill('#page-input', '4');
await A.page.press('#page-input', 'Enter');
await sleep(1500);
await A.page.click('#btn-back');
await A.page.waitForSelector('#view-library:not([hidden])');
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
check('remote lastPage = 4', remoteAnn().lastPage?.page === 4, JSON.stringify(remoteAnn().lastPage));
check('library shows page and count', /p\. 4 · 3 annotations/.test(await A.page.textContent('.book-card')), await A.page.textContent('.book-card'));

// Device B: phone
const B = await newDevice(browser, { ...devices['iPhone 13'], hasTouch: true });
await setup(B.page);
await openBook(B.page);
await sleep(1500);
check('device B opens at the synced page 4', Number(await B.page.inputValue('#page-input')) === 4, await B.page.inputValue('#page-input'));
await B.page.screenshot({ path: `${SHOTS}/04-phone-reader.png` });
await B.page.fill('#page-input', '1');
await B.page.press('#page-input', 'Enter');
await sleep(800);
const countB = await B.page.evaluate(() => document.querySelectorAll('.page[data-page-number="1"] .hl-layer .hl').length);
check('device B sees page-1 highlight', countB >= 1, String(countB));
const storedB = await B.page.evaluate(() => {
  const k = Object.keys(localStorage).find((k) => k.includes('axler'));
  return JSON.parse(localStorage.getItem(k)).doc.annotations.filter((a) => !a.deleted).length;
});
check('device B has all 3 annotations locally', storedB === 3, String(storedB));

// 8. Concurrent edits on both devices merge (with a forced conflict)
await openBook(A.page);
await selectText(A.page, 1, 3, 0, 30);
await A.page.click('#selection-bar .swatch.c-green');
await B.page.evaluate(() => (location.hash = '#read=math/books/axler-ladr-4ed.pdf&page=1'));
await sleep(800);
await selectText(B.page, 1, 5, 0, 25);
await B.page.screenshot({ path: `${SHOTS}/05-phone-selection.png` });
await B.page.click('#selection-bar .swatch.c-blue');
forceConflictOnce = true;
await Promise.all([
  A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 20000 }),
  B.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 20000 }),
]);
remote = remoteAnn();
const colors = remote.annotations.filter((a) => !a.deleted).map((a) => a.color).sort();
check('merge keeps both devices’ highlights', colors.includes('green') && colors.includes('blue') && remote.annotations.filter((a) => !a.deleted).length === 5, colors.join(','));

// 9. Delete on A propagates to B (B pulls on visibility change / reopen)
const n0 = remoteAnn().annotations.filter((a) => !a.deleted).length;
await A.page.click('#view-reader [data-sync-pill]');
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
await A.page.click('#btn-panel');
await A.page.click('[data-panel-tab="notes"]');
await A.page.waitForFunction((n) => document.querySelectorAll('.ann-item').length === n, n0);
await A.page.click('.ann-item >> nth=0');
await A.page.waitForSelector('#popover:not([hidden])');
await A.page.click('#pop-delete');
await A.page.waitForFunction((n) => document.querySelectorAll('.ann-item').length === n - 1, n0);
await A.page.click('#panel-close');
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
await B.page.click('#view-reader [data-sync-pill]');
await B.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
await sleep(300);
const liveRemote = remoteAnn().annotations.filter((a) => !a.deleted).length;
const bList = await B.page.evaluate(() => {
  const k = Object.keys(localStorage).find((k) => k.includes('axler'));
  return JSON.parse(localStorage.getItem(k)).doc.annotations.filter((a) => !a.deleted).length;
});
check('deletion propagated to B', liveRemote === n0 - 1 && bList === n0 - 1, `remote ${liveRemote}, B ${bList}`);

// 10. Offline edits are kept and synced later
networkDown = true;
await selectText(A.page, 1, 7, 0, 20);
await A.page.click('#selection-bar .swatch.c-pink');
await A.page.waitForFunction(() => ['offline', 'error'].includes(document.querySelector('[data-sync-pill]').dataset.state), null, { timeout: 15000 });
check('offline state shown', true, await A.page.getAttribute('[data-sync-pill]', 'data-state'));
networkDown = false;
await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
check('offline highlight synced after reconnect', remoteAnn().annotations.some((a) => a.color === 'pink' && !a.deleted));

// 11. Deep link with page
await A.page.evaluate(() => (location.hash = '#read=math/books/williams.pdf&page=3'));
await A.page.waitForSelector('#viewer .page[data-page-number="3"]');
await sleep(800);
check('deep link opens other book at page 3', Number(await A.page.inputValue('#page-input')) === 3);

// 11b. Bookmarks and resume: the saved position wins over the page in the link
await A.page.click('#btn-bookmark');
await A.page.waitForSelector('#popover:not([hidden])');
check('bookmark popover asks for a name', (await A.page.getAttribute('#pop-note', 'placeholder')) === 'Name this bookmark…');
await A.page.keyboard.type('Chapter 3');
await A.page.click('#pop-done');
check('bookmark ribbon drawn on page 3', await A.page.$('.page[data-page-number="3"] .bm-ribbon'));
await A.page.fill('#page-input', '5');
await A.page.press('#page-input', 'Enter');
await sleep(1600); // position save is debounced
await A.page.evaluate(() => (location.hash = '#'));
await A.page.waitForSelector('#view-library:not([hidden])');
await A.page.evaluate(() => (location.hash = '#read=math/books/williams.pdf&page=2'));
await A.page.waitForSelector('#viewer .page[data-page-number="5"]');
await A.page.waitForFunction(() => document.querySelector('#reader-loading').hidden);
await sleep(800);
check('reopening resumes at the last page, not the linked one', Number(await A.page.inputValue('#page-input')) === 5, await A.page.inputValue('#page-input'));
await A.page.click('#btn-panel');
await A.page.click('[data-panel-tab="bookmarks"]');
const bmItems = await A.page.$$eval('#bm-list .ann-item', (els) => els.map((e) => e.textContent));
check('bookmarks tab lists the bookmark', bmItems.length === 1 && bmItems[0].includes('Chapter 3') && bmItems[0].includes('p. 3'), bmItems.join(' | '));
await A.page.click('[data-panel-tab="notes"]');
check('bookmarks are not listed as annotations', !(await A.page.$$eval('#ann-list .ann-item', (els) => els.some((e) => e.textContent.includes('Bookmark')))));
await A.page.click('[data-panel-tab="bookmarks"]');
await A.page.click('#bm-list .ann-item');
await sleep(500);
check('bookmark jumps to its page', Number(await A.page.inputValue('#page-input')) === 3, await A.page.inputValue('#page-input'));
check('bookmark jump can be undone', await A.page.isVisible('#btn-jump-back'));
if (!(await A.page.$eval('#panel', (e) => e.hidden))) await A.page.click('#panel-close');
await A.page.click('#view-reader [data-sync-pill]');
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
const williams = JSON.parse(repo.get('math/books/williams.annotations.json').buf.toString());
check('bookmark synced to the repo', williams.annotations.some((a) => a.type === 'bookmark' && a.page === 3 && a.note === 'Chapter 3' && typeof a.y === 'number'), JSON.stringify(williams.annotations));

// 12. Missing book message
await A.page.evaluate(() => (location.hash = '#read=math/books/missing.pdf'));
await A.page.waitForSelector('#reader-loading.is-error:not([hidden])');
check('missing book shows a clear error', /not in the repository/.test(await A.page.textContent('#reader-loading-text')));

// 13. Second open uses the device cache (no blob download)
const blobBefore = log.filter((l) => l.includes('/git/blobs/')).length;
await openBook(A.page);
const blobAfter = log.filter((l) => l.includes('/git/blobs/')).length;
check('reopening uses cached PDF', blobAfter === blobBefore, `${blobBefore} -> ${blobAfter}`);

// 14. Performance: page-turn does not trigger commits; scrolling is not blocked
const putsBefore = log.filter((l) => l.startsWith('PUT')).length;
for (const n of [2, 3, 4, 5]) {
  await A.page.fill('#page-input', String(n));
  await A.page.press('#page-input', 'Enter');
  await sleep(300);
}
await sleep(6000);
check('page turns alone do not commit', log.filter((l) => l.startsWith('PUT')).length === putsBefore);

await A.page.screenshot({ path: `${SHOTS}/06-reader.png` });
check('no JS errors on A', A.errors.length === 0, A.errors.join(' | '));
check('no JS errors on B', B.errors.length === 0, B.errors.join(' | '));

// 15. Unsynced local edits saved under the old Italian layout (matematica/libri/...) move to the new paths
const D = await newDevice(browser, { viewport: { width: 1000, height: 800 } });
await D.ctx.addInitScript(() => {
  if (localStorage.getItem('learnreader:config')) return;
  localStorage.setItem('learnreader:config', JSON.stringify({ owner: 'Perruccio', repo: 'Learn', branch: 'main', token: 'good-token' }));
  const doc = { version: 1, book: 'matematica/libri/axler-ladr-4ed.pdf', lastPage: null, annotations: [{ id: 'legacy1', type: 'highlight', page: 2, color: 'blue', rects: [[0.1, 0.1, 0.2, 0.02]], createdAt: 1, updatedAt: Date.now() }] };
  localStorage.setItem('learnreader:doc:Perruccio/Learn@main:matematica/libri/axler-ladr-4ed.pdf', JSON.stringify({ doc, dirty: true, rev: 1 }));
  localStorage.setItem('learnreader:zoom:matematica/libri/axler-ladr-4ed.pdf', JSON.stringify('page-fit'));
});
await D.page.goto(APP);
await D.page.waitForSelector('#view-library:not([hidden]) .book-card');
await D.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
const legacyKeys = await D.page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('matematica')));
check(
  'legacy local edits pushed to the new path, old keys gone',
  remoteAnn().annotations.some((a) => a.id === 'legacy1') && ![...repo.keys()].some((k) => k.startsWith('matematica/')) && legacyKeys.length === 0,
  legacyKeys.join(', '),
);
check('no JS errors on D', D.errors.length === 0, D.errors.join(' | '));

// dark-mode screenshot of library on phone
const C = await newDevice(browser, { ...devices['iPhone 13'], colorScheme: 'dark' });
await setup(C.page);
await C.page.screenshot({ path: `${SHOTS}/07-phone-library-dark.png` });

fs.writeFileSync(`${SHOTS}/remote.json`, repo.get('math/books/axler-ladr-4ed.annotations.json').buf);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
