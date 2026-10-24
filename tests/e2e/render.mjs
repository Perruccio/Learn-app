// Every page and flashcard of one subject renders: no KaTeX errors, 4-step stepper on session pages.
// Subject folder from SUBJECT (default "math"); content from CONTENT_DIR (synthetic fixtures by default).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { APP, CONTENT_DIR, ROOT, launch, reporter } from '../lib/env.mjs';

const SUBJECT = process.env.SUBJECT || 'math';
const BASE = path.join(CONTENT_DIR, SUBJECT);
const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map();
const put = (p, b) => repo.set(p, { buf: Buffer.from(b), sha: gitSha(Buffer.from(b)) });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
for (const f of walk(BASE)) if (/\.(md|tsv)$/.test(f)) put(path.relative(CONTENT_DIR, f), fs.readFileSync(f));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };

const { check, finish } = reporter();
const browser = await launch();
const ctx = await browser.newContext();
await ctx.route('https://api.github.com/**', (route) => {
  const req = route.request();
  const p = decodeURIComponent(new URL(req.url()).pathname);
  const json = (s, b) => route.fulfill({ status: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (p === '/repos/Perruccio/Learn') return json(200, {});
  if (p.endsWith('/git/trees/main')) return json(200, { tree: [...repo].map(([k, v]) => ({ path: k, type: 'blob', sha: v.sha, size: v.buf.length })) });
  const f = p.split('/contents/')[1];
  if (req.method() === 'GET') return repo.has(f) ? json(200, { sha: repo.get(f).sha, size: repo.get(f).buf.length, content: repo.get(f).buf.toString('base64') }) : json(404, {});
  return json(409, { message: 'read-only test' });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(APP);
await page.fill('#setup-form [name=token]', 't');
await page.click('#setup-submit');
await page.waitForSelector('#view-library:not([hidden])');

// Pages: sessions (with solutions opened), solutions, roadmaps, method, progress
let formulas = 0;
const broken = [];
for (const doc of [...repo.keys()].filter((k) => k.endsWith('.md')).sort()) {
  await page.evaluate((h) => (location.hash = h), `#doc=${doc}`);
  await page.waitForFunction(() => document.querySelector('#view-course:not([hidden]) .md') && !document.querySelector('#course-main > p.muted'));
  const session = /\/sessions\/[A-Z]\d+\.md$/.test(doc);
  if (session) {
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.session-end .btn')].find((x) => /Show solutions/.test(x.textContent));
      b?.click();
      return !!b;
    });
    if (opened) await page.waitForSelector('.solutions:not([hidden])', { timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(100);
  const r = await page.evaluate(() => ({
    ok: document.querySelectorAll('#course-main .katex').length,
    bad: [...document.querySelectorAll('#course-main .katex-error')].map((e) => e.textContent.slice(0, 60)),
    steps: document.querySelectorAll('.stepper .step').length,
  }));
  formulas += r.ok;
  if (r.bad.length) broken.push(`${doc}: ${r.bad.join(' | ')}`);
  if (session && !/\/C\d+\.md$/.test(doc) && r.steps !== 4) broken.push(`${doc}: ${r.steps} stepper phases`);
}
check(`${SUBJECT}: every page renders (${formulas} formulas)`, broken.length === 0, broken.slice(0, 5).join(' ; '));

// Flashcards: same KaTeX build and options as the app
const katex = (await import(path.join(ROOT, 'vendor/katex/katex.mjs'))).default;
let cards = 0;
const badCards = [];
for (const [p, { buf }] of repo) {
  if (!p.endsWith('.tsv')) continue;
  for (const line of buf.toString().split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 3) badCards.push(`${p}: ${cols.length} columns: ${line.slice(0, 40)}`);
    for (const field of cols.slice(0, 2)) {
      for (const m of field.matchAll(/\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g)) {
        cards++;
        try {
          katex.renderToString(m[1] ?? m[2] ?? m[3], { throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 });
        } catch (e) {
          badCards.push(`${p}: ${e.message.slice(0, 80)}`);
        }
      }
    }
  }
}
check(`${SUBJECT}: every flashcard renders (${cards} formulas)`, badCards.length === 0, badCards.slice(0, 5).join(' ; '));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
finish();
