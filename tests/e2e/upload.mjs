// PDF upload through the Git Data API (blob → tree → commit → ref), with a concurrent push and
// rejected inputs (non-PDF content, path traversal in the folder).
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { APP, FIXTURES, launch, reporter } from '../lib/env.mjs';

const { check, finish } = reporter();
const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map([['matematica/PROGRESSI.md', Buffer.from('# Progressi\n')]]);
const blobs = new Map();
const trees = new Map(); // tree sha -> { path, sha }
let head = 'c0';
const commits = new Map([['c0', { tree: 't0' }]]);
let refConflicts = 1; // the first ref update fails as if someone else had pushed
const calls = [];

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, OPTIONS' };
async function handle(route) {
  const req = route.request();
  const p = decodeURIComponent(new URL(req.url()).pathname);
  const json = (s, b) => route.fulfill({ status: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  calls.push(`${req.method()} ${p.replace('/repos/Perruccio/Learn', '')}`);
  if (p === '/repos/Perruccio/Learn') return json(200, {});
  if (p.endsWith('/git/trees/main')) return json(200, { tree: [...repo].map(([k, v]) => ({ path: k, type: 'blob', sha: gitSha(v), size: v.length })) });
  if (p.endsWith('/git/blobs') && req.method() === 'POST') {
    const buf = Buffer.from(body.content, 'base64');
    blobs.set(gitSha(buf), buf);
    return json(201, { sha: gitSha(buf) });
  }
  if (p.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: head } });
  const c = p.match(/\/git\/commits\/(\w+)$/);
  if (c) return commits.has(c[1]) ? json(200, { tree: { sha: commits.get(c[1]).tree } }) : json(404, {});
  if (p.endsWith('/git/trees') && req.method() === 'POST') {
    const sha = `t${trees.size + 1}`;
    trees.set(sha, { base: body.base_tree, path: body.tree[0].path, sha: body.tree[0].sha });
    return json(201, { sha });
  }
  if (p.endsWith('/git/commits') && req.method() === 'POST') {
    const sha = `c${commits.size}`;
    commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
    return json(201, { sha });
  }
  if (p.endsWith('/git/refs/heads/main') && req.method() === 'PATCH') {
    if (refConflicts-- > 0) {
      head = 'cX'; // another device pushed meanwhile
      commits.set('cX', { tree: 'tX' });
      return json(422, { message: 'Update is not a fast forward' });
    }
    if (!commits.get(body.sha).parents.includes(head)) return json(422, { message: 'Update is not a fast forward' });
    head = body.sha;
    const entry = trees.get(commits.get(head).tree);
    repo.set(entry.path, blobs.get(entry.sha));
    return json(200, { object: { sha: head } });
  }
  return json(404, {});
}

const browser = await launch();
const ctx = await browser.newContext();
await ctx.route('https://api.github.com/**', handle);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(APP);
await page.fill('#setup-form [name=token]', 't');
await page.click('#setup-submit');
await page.waitForSelector('#view-library:not([hidden])');

async function upload(files, folder = 'matematica/libri') {
  await page.setInputFiles('#upload-input', files);
  await page.waitForSelector('#upload-dialog[open]');
  await page.fill('#upload-form [name=folder]', folder);
  await page.click('#upload-form button[value=ok]');
}

// A real PDF: blob, tree on the current head, commit, ref update (retried after a concurrent push)
const pdf = fs.readFileSync(path.join(FIXTURES, 'book.pdf'));
await upload({ name: 'All of Statistics.pdf', mimeType: 'application/pdf', buffer: pdf });
await page.waitForFunction(() => /caricato/.test(document.querySelector('#toasts')?.textContent || ''), null, { timeout: 15000 });
const stored = repo.get('matematica/libri/all-of-statistics.pdf');
check('PDF uploaded through the Git Data API, byte for byte', stored && stored.equals(pdf), String(stored?.length));
check('contents endpoint not used for the upload', !calls.some((c) => c.startsWith('PUT /contents/')), calls.filter((c) => c.startsWith('PUT')).join(', '));
check('concurrent push: commit rebuilt on the new head', commits.get(head).parents[0] === 'cX' && head !== 'cX', JSON.stringify(commits.get(head)));
check('blob sent once, even with the retry', calls.filter((c) => c === 'POST /git/blobs').length === 1);

// Not a PDF
const before = calls.length;
await upload({ name: 'evil.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
await page.waitForFunction(() => /non è un PDF/.test(document.querySelector('#toasts')?.textContent || ''), null, { timeout: 5000 });
check('non-PDF content rejected before any request', !calls.slice(before).some((c) => c.includes('/git/blobs')));

// Path traversal in the folder field
const before2 = calls.length;
await upload({ name: 'x.pdf', mimeType: 'application/pdf', buffer: pdf }, 'matematica/../../etc');
await page.waitForFunction(() => /Cartella non valida/.test(document.querySelector('#toasts')?.textContent || ''), null, { timeout: 5000 });
check('folder with .. rejected', !calls.slice(before2).some((c) => c.includes('/git/blobs')));

check('no JS errors', errors.length === 0, errors.join(' | '));
await browser.close();
finish();
