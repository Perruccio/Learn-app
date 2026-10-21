import fs from 'fs';
import crypto from 'crypto';
import { APP, launch } from '../lib/env.mjs';
// Optional benchmark (not run in CI): BIG_PDF=/path/to/large.pdf node e2e/perf.mjs
if (!process.env.BIG_PDF) {
  console.log('Set BIG_PDF to a large PDF (e.g. 600 pages) to run the benchmark.');
  process.exit(0);
}
const buf = fs.readFileSync(process.env.BIG_PDF);
const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const files = new Map();
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Length' };
async function handle(route) {
  const req = route.request(); const p = decodeURIComponent(new URL(req.url()).pathname);
  const json = (s, b) => route.fulfill({ status: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (p === '/repos/Perruccio/Learn') return json(200, {});
  if (p.endsWith('/git/trees/main')) return json(200, { tree: [{ path: 'math/books/big.pdf', type: 'blob', sha, size: buf.length }] });
  if (p.includes('/git/blobs/')) return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Length': String(buf.length) }, body: buf });
  const f = p.split('/contents/')[1];
  if (req.method() === 'GET') return files.has(f) ? json(200, { sha: 'x' + files.get(f).length, content: Buffer.from(files.get(f)).toString('base64') }) : json(404, {});
  const body = JSON.parse(req.postData()); files.set(f, Buffer.from(body.content, 'base64').toString()); return json(200, {});
}
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route('https://api.github.com/**', handle);
const page = await ctx.newPage();
await page.goto(APP);
await page.fill('#setup-form [name=token]', 't'); await page.click('#setup-submit');
await page.waitForSelector('.book-card');
// Long-task observer
await page.evaluate(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: true }); });
let t = Date.now();
await page.click('.book-card');
await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
console.log('first open (download + render):', Date.now() - t, 'ms');
// add 300 annotations quickly through the UI API to stress storage
t = Date.now();
await page.evaluate(() => { window.__long = []; });
const mutateMs = await page.evaluate(async () => {
  const k = Object.keys(localStorage).find((k) => k.includes('big'));
  const times = [];
  for (let i = 0; i < 300; i++) {
    const s = performance.now();
    // simulate an annotation edit via the same store path the UI uses
    document.querySelector('#viewer'); 
    const raw = JSON.parse(localStorage.getItem(k) || '{"doc":{"annotations":[]},"rev":0}');
    raw.doc.annotations.push({ id: 'x' + i, type: 'highlight', page: 1 + (i % 600), color: 'yellow', text: 'lorem ipsum dolor sit amet '.repeat(4), rects: [[0.1, 0.2, 0.5, 0.02], [0.1, 0.23, 0.4, 0.02]], createdAt: Date.now(), updatedAt: Date.now() });
    raw.dirty = true; raw.rev++;
    localStorage.setItem(k, JSON.stringify(raw));
    times.push(performance.now() - s);
  }
  return times.reduce((a, b) => a + b) / times.length;
});
console.log('avg raw storage write with growing doc (to 300 annotations):', mutateMs.toFixed(2), 'ms');
await page.click('#btn-back'); await page.waitForSelector('.book-card');
await page.click('.book-card');
await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
// Now measure a real UI edit with 300 annotations present
const sel = await page.evaluate(() => { const s = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(x=>x.firstChild?.nodeType===3)[2]; const r = document.createRange(); r.setStart(s.firstChild,0); r.setEnd(s.firstChild, 20); getSelection().removeAllRanges(); getSelection().addRange(r); return true; });
await page.waitForSelector('#selection-bar:not([hidden])');
const editMs = await page.evaluate(async () => { const s = performance.now(); document.querySelector('#selection-bar .swatch.c-green').click(); await new Promise(requestAnimationFrame); return performance.now() - s; });
console.log('UI highlight with 300 existing annotations (until next frame):', editMs.toFixed(1), 'ms');
// scroll through 100 pages
await page.evaluate(() => { window.__long = []; });
t = Date.now();
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(30); }
await page.waitForTimeout(1500);
const longs = await page.evaluate(() => window.__long);
console.log('scrolled to page', await page.inputValue('#page-input'), '| long tasks during scroll:', longs.length, 'max', Math.round(Math.max(0, ...longs)), 'ms');
// wait for sync and measure it
await page.waitForTimeout(6000); console.log('sync state:', await page.evaluate(() => document.querySelector('[data-sync-pill]').dataset.state + ' ' + document.querySelector('[data-sync-pill]').title));
const remote = [...files.values()][0];
console.log('remote annotation file size:', (remote.length / 1024).toFixed(1), 'KB');
await page.evaluate(() => { window.__long = []; });
await page.click('#btn-back'); await page.waitForSelector('.book-card');
t = Date.now(); await page.click('.book-card'); await page.waitForSelector('.page .textLayer span');
console.log('reopen from device cache:', Date.now() - t, 'ms');
const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
console.log('JS heap:', mem, 'MB');
await browser.close();
