// Flashcard review tests against a mock GitHub API, with the real card files.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { APP, ORIGIN, CONTENT_DIR, FIXTURES, SHOTS, devices, launch } from '../lib/env.mjs';

const LEARN = path.join(CONTENT_DIR, 'matematica');
const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map();
const put = (p, b) => repo.set(p, { buf: Buffer.from(b), sha: gitSha(Buffer.from(b)) });
put('matematica/PROGRESSI.md', fs.readFileSync(`${LEARN}/PROGRESSI.md`));
for (const f of fs.readdirSync(`${LEARN}/flashcard`)) put(`matematica/flashcard/${f}`, fs.readFileSync(`${LEARN}/flashcard/${f}`));
put('matematica/libri/README.md', 'x');
const cardLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
const S001_CARDS = cardLines(`${LEARN}/flashcard/S001.tsv`);
const CARD_FILES = fs.readdirSync(`${LEARN}/flashcard`).filter((f) => /^S\d+\.tsv$/.test(f)).map((f) => [f, fs.readFileSync(`${LEARN}/flashcard/${f}`, 'utf8')]);
put(
  'matematica/flashcard/EVID-test.tsv',
  '#separator:tab\n#deck:Matematica::LA\n<img src=x onerror="window.__pwned=1">\\(x\\)\t<script>window.__pwned=1</script> \\(\\href{javascript:window.__pwned=1}{click}\\) <b>ok</b>\tEVID\n',
);
const puts = [];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
async function handle(route) {
  const req = route.request();
  const p = decodeURIComponent(new URL(req.url()).pathname);
  const json = (s, b) => route.fulfill({ status: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (p === '/repos/Perruccio/Learn') return json(200, {});
  if (p.endsWith('/git/trees/main')) return json(200, { tree: [...repo].map(([k, v]) => ({ path: k, type: 'blob', sha: v.sha, size: v.buf.length })) });
  const f = p.split('/contents/')[1];
  if (!f) return json(404, {});
  if (req.method() === 'GET') return repo.has(f) ? json(200, { sha: repo.get(f).sha, size: repo.get(f).buf.length, content: repo.get(f).buf.toString('base64') }) : json(404, {});
  const body = JSON.parse(req.postData());
  if (repo.has(f) && body.sha !== repo.get(f).sha) return json(409, { message: 'conflict' });
  put(f, Buffer.from(body.content, 'base64'));
  puts.push(`${f} :: ${body.message}`);
  return json(200, { content: { sha: repo.get(f).sha } });
}

const results = [];
const check = (n, c, x = '') => {
  results.push(!!c);
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? `  (${x})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launch();

async function device(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route('https://api.github.com/**', handle);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' || /Content Security Policy/.test(m.text())) && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  page.on('dialog', (d) => d.dismiss());
  await page.goto(APP);
  await page.fill('#setup-form [name=token]', 't');
  await page.click('#setup-submit');
  await page.waitForSelector('#view-library:not([hidden])');
  return { ctx, page, errors };
}

const A = await device({ viewport: { width: 1200, height: 850 } });
await A.page.waitForSelector('#next-session:not([hidden])');
check('next session panel shows S001', (await A.page.textContent('#next-title')).startsWith('S001'), await A.page.textContent('#next-title'));
check('session cards locked before the session is done (only the always-on EVID card)', (await A.page.textContent('#rv-new')) === '1', await A.page.textContent('#rv-new'));
await A.page.screenshot({ path: `${SHOTS}/r1-library.png` });

// Session pages need the markdown files in the mock repo
put('matematica/sessioni/S001.md', fs.readFileSync(`${LEARN}/sessioni/S001.md`));
await A.page.evaluate(() => (location.hash = '#doc=matematica/sessioni/S001.md'));
await A.page.waitForSelector('.session-end .btn-primary', { timeout: 15000 });
await A.page.click('.session-end .btn-primary');
await A.page.waitForSelector('.session-end .btn >> text=Completata');
await A.page.evaluate(() => (location.hash = ''));
await A.page.waitForFunction(() => document.querySelector('#next-title').textContent.startsWith('S002'), null, { timeout: 15000 });
check('PROGRESSI.md ticked on GitHub', /\| \[x\] \| \[S001\]/.test(repo.get('matematica/PROGRESSI.md').buf.toString()));
const fresh = Number(await A.page.textContent('#rv-new'));
check(`S001 cards unlocked (${S001_CARDS}) + always-on EVID file (1)`, fresh === S001_CARDS + 1, String(fresh));
await A.page.screenshot({ path: `${SHOTS}/r2-library-unlocked.png` });

// Review
await A.page.click('#rv-start');
await A.page.waitForSelector('#review-stage:not([hidden])');
const firstFront = await A.page.textContent('#review-front');
check('a card is shown', firstFront.length > 3, firstFront.slice(0, 60));
await A.page.keyboard.press('Space');
await A.page.waitForSelector('#review-ratings:not([hidden])');
const ivls = await A.page.$$eval('.rate-ivl', (n) => n.map((x) => x.textContent));
check('rating buttons show intervals', ivls.every(Boolean) && ivls.length === 4, ivls.join(' | '));
await A.page.screenshot({ path: `${SHOTS}/r3-review.png` });
await A.page.keyboard.press('1'); // Again: must come back later in the session
const after1 = await A.page.textContent('#review-count');
await A.page.click('#review-undo');
await sleep(100);
check('undo brings back the same card', (await A.page.textContent('#review-front')) === firstFront);
// Answer everything with Good (Again only on the first card)
let guard = 0;
let first = true;
while (!(await A.page.$eval('#review-stage', (e) => e.hidden)) && guard++ < 80) {
  await A.page.keyboard.press('Space');
  await A.page.waitForSelector('#review-ratings:not([hidden])');
  await A.page.keyboard.press(first ? '1' : '3');
  first = false;
}
check('session completes', await A.page.$eval('#review-stage', (e) => e.hidden), `${guard} answers`);
check('learning cards are re-shown within the session', guard > fresh, `${guard} answers for ${fresh} cards`);
const pwned = await A.page.evaluate(() => window.__pwned);
check('malicious card content not executed', pwned === undefined);
await A.page.screenshot({ path: `${SHOTS}/r4-done.png` });

// KaTeX: every real card renders without errors
const katexReport = await A.page.evaluate(async (files) => {
  const { renderRich, parseCardFile, loadMath } = await import('./js/cards.js'); await loadMath();
  const out = { cards: 0, errors: [], math: 0 };
  for (const [n, text] of files) {
    for (const c of parseCardFile(text, `x/flashcard/${n}`)) {
      for (const side of [c.front, c.back]) {
        const div = document.createElement('div');
        renderRich(div, side);
        out.cards++;
        out.math += div.querySelectorAll('.katex').length;
        for (const e of div.querySelectorAll('.katex-error')) out.errors.push(`${n}: ${e.textContent}`);
      }
    }
  }
  return out;
}, CARD_FILES);
check('all card formulas render with KaTeX', katexReport.errors.length === 0 && katexReport.math > 3, `${katexReport.math} formulas, errors: ${katexReport.errors.slice(0, 3).join(' ; ')}`);

// Leaving the review pushes progress
await A.page.click('#review-finish');
await A.page.waitForSelector('#view-library:not([hidden])');
await A.page.waitForFunction(() => document.querySelector('[data-sync-pill]').dataset.state === 'synced', null, { timeout: 15000 });
const prog = repo.get('matematica/flashcard/progresso.json');
const progJson = prog && JSON.parse(prog.buf.toString());
check('progress pushed to progresso.json', progJson?.cards?.length === fresh, String(progJson?.cards?.length));
check('progress pushed in few commits', puts.filter((p) => p.includes('progresso')).length <= 2, String(puts.filter((p) => p.includes('progresso')).length));

// Device B (phone) sees A's progress: nothing new left today
const B = await device({ ...devices['iPhone 13'] });
await B.page.waitForFunction(() => document.querySelector('#rv-new').textContent !== '', null, { timeout: 15000 });
await sleep(1500);
check('device B: new cards already studied on A', (await B.page.textContent('#rv-new')) === '0', `${await B.page.textContent('#rv-new')} new, ${await B.page.textContent('#rv-due')} due`);
await B.page.screenshot({ path: `${SHOTS}/r5-phone-library.png` });
// Force a card due on B to see the phone layout
await B.page.evaluate(() => {
  const k = Object.keys(localStorage).find((k) => k.startsWith('learnreader:cards:'));
  const v = JSON.parse(localStorage.getItem(k));
  v.doc.cards.forEach((c) => (c.due = Date.now() - 1000));
  localStorage.setItem(k, JSON.stringify(v));
});
await B.page.evaluate(() => (location.hash = '#ripasso'));
await B.page.waitForSelector('#review-stage:not([hidden])');
await B.page.tap('#review-card');
await B.page.waitForSelector('#review-ratings:not([hidden])');
await B.page.screenshot({ path: `${SHOTS}/r6-phone-review.png` });

check('no JS/CSP errors on A', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
check('no JS/CSP errors on B', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
