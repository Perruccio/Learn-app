// Security tests: malicious PDF content and tampered annotation files.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { APP, ORIGIN, CONTENT_DIR, FIXTURES, SHOTS, devices, launch } from '../lib/env.mjs';

const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map();
const put = (p, b) => repo.set(p, { buf: b, sha: gitSha(b) });
put('math/books/malicious.pdf', fs.readFileSync(path.join(FIXTURES, 'malicious.pdf')));
put('math/books/fake.pdf', Buffer.from('<html><script>window.__pwned=1</script></html>'));
put(
  'math/books/malicious.annotations.json',
  Buffer.from(
    JSON.stringify({
      version: 1,
      lastPage: { page: '1;alert(1)', at: 1 },
      annotations: [
        { id: 'ok1', type: 'highlight', page: 1, color: 'green', text: 'valid', rects: [[0.1, 0.1, 0.3, 0.02]], createdAt: 1, updatedAt: 1 },
        { id: 'x"><img src=x onerror=alert(1)>', type: 'highlight', page: 1, color: 'yellow', rects: [[0.1, 0.2, 0.3, 0.02]] },
        { id: 'xss2', type: 'highlight', page: 1, color: 'yellow" onmouseover="window.__pwned=1', text: '<img src=x onerror="window.__pwned=1">', note: '<script>window.__pwned=1</script>', rects: [[0.1, 0.3, 0.3, 0.02]], onclick: 'window.__pwned=1', createdAt: 2, updatedAt: 2 },
        { id: 'css', type: 'area', page: 1, color: 'blue', rects: [['0;background:url(https://evil.example/x)', 0, 1, 1]], createdAt: 3, updatedAt: 3 },
        { id: 'pin', type: 'note', page: 1, color: 'pink', x: 'javascript:alert(1)', y: 0.5, note: 'x' },
        { id: 'bm-bad', type: 'bookmark', page: 1, color: 'green', y: '0;top:-9999px' },
        { id: 'bad-type', type: '<svg onload=alert(1)>', page: 1, color: 'blue', rects: [[0.1, 0.5, 0.2, 0.02]], createdAt: 4, updatedAt: 4 },
      ],
    }),
  ),
);

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Length' };
const outbound = [];
async function handle(route) {
  const req = route.request();
  const p = decodeURIComponent(new URL(req.url()).pathname);
  const json = (s, b) => route.fulfill({ status: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (p === '/repos/Perruccio/Learn') return json(200, {});
  if (p.endsWith('/git/trees/main')) return json(200, { tree: [...repo].map(([k, v]) => ({ path: k, type: 'blob', sha: v.sha, size: v.buf.length })) });
  const m = p.match(/git\/blobs\/(\w+)/);
  if (m) {
    const e = [...repo.values()].find((v) => v.sha === m[1]);
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/octet-stream' }, body: e.buf });
  }
  const f = p.split('/contents/')[1];
  if (req.method() === 'GET') return repo.has(f) ? json(200, { sha: repo.get(f).sha, content: repo.get(f).buf.toString('base64') }) : json(404, {});
  const body = JSON.parse(req.postData());
  put(f, Buffer.from(body.content, 'base64'));
  return json(200, {});
}

const results = [];
const check = (n, c, x = '') => {
  results.push(!!c);
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? `  (${x})` : ''}`);
};

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.route('https://api.github.com/**', handle);
// Any request to a host other than the app and the GitHub API is a leak.
await ctx.route((url) => !url.href.startsWith(`${ORIGIN}/`) && !url.href.startsWith('https://api.github.com/'), (route) => {
  outbound.push(route.request().url());
  route.abort();
});
const page = await ctx.newPage();
const dialogs = [];
const csp = [];
const popups = [];
page.on('dialog', async (d) => {
  dialogs.push(d.message());
  await d.dismiss();
});
page.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && csp.push(m.text()));
ctx.on('page', (p) => popups.push(p.url()));

await page.goto(APP);
await page.fill('#setup-form [name=token]', 't');
await page.click('#setup-submit');
await page.waitForSelector('.book-card');

await page.evaluate(() => (location.hash = '#read=math/books/malicious.pdf'));
await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
await page.waitForTimeout(2500);

check('PDF document JavaScript not executed (no alert)', dialogs.length === 0, dialogs.join(' | '));
check('no javascript: link rendered', (await page.$$('.annotationLayer a[href^="javascript"]')).length === 0);
check('window not compromised', (await page.evaluate(() => window.__pwned)) === undefined);

// Tampered annotation file
const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('.hl-layer [data-id]')].map((e) => e.dataset.id))]);
check('only valid annotations survive sanitization', JSON.stringify(ids.sort()) === JSON.stringify(['bad-type', 'ok1', 'xss2']), ids.join(','));
check('no injected elements in the page', (await page.$$('.hl-layer img, .hl-layer script, .hl-layer svg, img[src="x"]')).length === 0);
const xssClass = await page.$eval('.hl-layer [data-id="xss2"]', (e) => e.className);
check('bad color normalized', /c-yellow/.test(xssClass) && !/onmouseover/.test(xssClass), xssClass);
await page.click('#btn-panel');
await page.waitForSelector('.ann-item');
check('panel shows markup as plain text', (await page.$$('#ann-list img, #ann-list script')).length === 0 && (await page.textContent('#ann-list')).includes('<img src=x'));
await page.hover('.hl-layer [data-id="xss2"]', { force: true }).catch(() => {});
check('still not compromised after interaction', (await page.evaluate(() => window.__pwned)) === undefined);

// External link: must ask, and open only after confirmation
await page.click('#panel-close');
const link = await page.$('.annotationLayer a[href^="https://example.com"]');
check('external link present', !!link);
await link.click({ force: true });
await page.waitForTimeout(500);
check('external link asks for confirmation with full URL', dialogs.some((d) => d.includes('https://example.com/phishing')), dialogs.join(' | '));
check('dismissed link does not open', popups.length === 0, popups.join(','));

// A non-PDF disguised as .pdf must not run anything
await page.evaluate(() => (location.hash = '#read=math/books/fake.pdf'));
await page.waitForSelector('#reader-loading.is-error:not([hidden])', { timeout: 15000 });
check('fake PDF rejected', /Cannot open/.test(await page.textContent('#reader-loading-text')));
check('fake PDF did not execute', (await page.evaluate(() => window.__pwned)) === undefined);

check('no requests to third-party hosts', outbound.length === 0, outbound.join(', '));
check('no CSP violations by the app itself', csp.length === 0, csp.slice(0, 3).join(' | '));
const policy = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);
const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src'));
check('CSP present and blocks inline scripts/eval', scriptSrc.trim() === "script-src 'self'" && !/unsafe-eval/.test(policy) && !/style-src 'self' 'unsafe-inline'/.test(policy), scriptSrc);

// Framing is refused
const framePage = await ctx.newPage();
await framePage.setContent(`<iframe id="f" src="${APP}" width="800" height="600"></iframe>`);
await framePage.waitForTimeout(2500);
const framed = framePage.frames().find((f) => f.url().startsWith(ORIGIN));
const framedText = framed ? await framed.evaluate(() => document.body.innerText) : '';
check('app refuses to run inside a frame', /cannot be opened/.test(framedText), framedText.slice(0, 60));

// "Don't remember" keeps the token out of localStorage
const ctx2 = await browser.newContext();
await ctx2.route('https://api.github.com/**', handle);
const p2 = await ctx2.newPage();
await p2.goto(APP);
await p2.fill('#setup-form [name=token]', 'secret-token-123');
await p2.uncheck('#setup-form [name=remember]');
await p2.click('#setup-submit');
await p2.waitForSelector('#view-library:not([hidden])');
const leaked = await p2.evaluate(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) || '').includes('secret-token-123')));
check('token not persisted when "remember" is off', !leaked);
await p2.reload();
await p2.waitForSelector('#view-library:not([hidden])');
check('session still works after reload in the same tab', true);

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
