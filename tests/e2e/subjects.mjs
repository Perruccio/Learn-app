// Several subjects (folders with a PROGRESS.md): home dashboard, per-subject library, path, review and upload.
import crypto from 'crypto';
import { APP, SHOTS, launch, reporter } from '../lib/env.mjs';

// Synthetic content: two subjects and one book outside both.
const progress = (title, p) => `# Progress\n\nSynthetic ${title}.\n\n## Block 1\n\n| ✓ | Session | Track | Topic |\n|---|---|---|---|\n| [ ] | [${p}001](sessions/${p}001.md) | Aa-01 | First ${title} topic |\n| [ ] | [${p}002](sessions/${p}002.md) | Bb-01 | Second ${title} topic |\n| [ ] | ${p}003 | Aa-02 | Not prepared |\n`;
const session = (p) => `# ${p}001 · Aa-01 · Topic\n\n**Flashcards:** [Review](https://perruccio-learn.github.io/Learn-app/#review) · [Path](https://perruccio-learn.github.io/Learn-app/#path)\n\n## 1 · Review (10')\n\nText.\n\n## 2 · Pretest (3')\n\nText.\n`;
const cards = (deck, n) => `#separator:tab\n#html:true\n#deck:Test::${deck}\n#tags column:3\n${Array.from({ length: n }, (_, i) => `${deck} front ${i}\t${deck} back ${i}\tHL x hl:${deck}${i}`).join('\n')}\n`;
const CONTENT = {
  'alpha/README.md': '# Alpha study\n\nSynthetic.\n',
  'alpha/PROGRESS.md': progress('alpha', 'A'),
  'alpha/sessions/A001.md': session('A'),
  'alpha/sessions/A002.md': session('A'),
  'alpha/flashcards/HL-2026-01-01.tsv': cards('Alpha', 3),
  'beta/PROGRESS.md': progress('beta', 'B'),
  'beta/sessions/B001.md': session('B'),
  'beta/sessions/B002.md': session('B'),
  'beta/flashcards/HL-2026-01-01.tsv': cards('Beta', 2),
};
const PDFS = ['alpha/books/alpha-book.pdf', 'beta/books/beta-book.pdf', 'loose-book.pdf'];

const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map();
const put = (p, b) => repo.set(p, { buf: Buffer.from(b), sha: gitSha(Buffer.from(b)) });
for (const [p, t] of Object.entries(CONTENT)) put(p, t);
for (const p of PDFS) put(p, '%PDF-1.4\n%%EOF\n');
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
  return json(200, { content: { sha: repo.get(f).sha } });
}

const { check, finish } = reporter();
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.route('https://api.github.com/**', handle);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || /Content Security Policy/.test(m.text())) && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
page.on('dialog', (d) => d.dismiss());
const go = (h) => page.evaluate((x) => (location.hash = x), h);
const hash = () => page.evaluate(() => location.hash);

await page.goto(APP);
await page.fill('#setup-form [name=token]', 't');
await page.click('#setup-submit');

// Home: one card per subject
await page.waitForSelector('#view-home:not([hidden]) .subject-card');
const cardsInfo = await page.$$eval('.subject-card', (n) => n.map((c) => [c.dataset.subject, c.querySelector('.eyebrow').textContent, c.querySelector('.review-counts').textContent, c.querySelector('.next-title').textContent]));
check('home lists both subjects, sorted', cardsInfo.map((c) => c[0]).join() === 'alpha,beta', JSON.stringify(cardsInfo));
check('subject name from README heading, else folder name', cardsInfo[0][1] === 'Alpha' && cardsInfo[1][1] === 'Beta', cardsInfo.map((c) => c[1]).join());
check('card shows progress and next session', /0 of 3 sessions done/.test(cardsInfo[0][2]) && /A001/.test(cardsInfo[0][3]), cardsInfo[0].join(' | '));
await page.waitForFunction(() => document.querySelector('#home-rv-new').textContent === '5', null, { timeout: 10000 }).catch(() => {});
check('home review covers all subjects', (await page.textContent('#home-rv-new')) === '5', await page.textContent('#home-rv-new'));
check('books outside every subject are listed on the home', (await page.textContent('#home-books')).includes('Loose'), await page.textContent('#home-books'));
await page.screenshot({ path: `${SHOTS}/s1-home.png` });

// Enter a subject
await page.click('.subject-card[data-subject="beta"] .btn-primary');
await page.waitForSelector('#view-library:not([hidden]) #library-list .book-card');
check('subject page route', (await hash()) === '#s=beta', await hash());
check('subject page header shows its name and a way home', (await page.textContent('#lib-subject')) === 'Beta' && !(await page.$eval('#lib-home', (e) => e.hidden)));
const books = await page.$$eval('#library-list .book-card .book-title', (n) => n.map((x) => x.textContent));
check('library shows only the subject’s books', books.length === 1 && /Beta/.test(books[0]), books.join());
await page.waitForSelector('#next-session:not([hidden])');
check('next session of this subject', (await page.textContent('#next-title')).startsWith('B001'), await page.textContent('#next-title'));
check('flashcard counts of this subject only', (await page.textContent('#rv-new')) === '2', await page.textContent('#rv-new'));
check('path and review links scoped to the subject', (await page.getAttribute('#lib-path', 'href')) === '#path&s=beta' && (await page.getAttribute('#rv-start', 'href')) === '#review&s=beta');

// Upload proposes the subject's books folder
await page.setInputFiles('#upload-input', { name: 'new.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') });
await page.waitForSelector('#upload-dialog[open]');
check('upload folder defaults to the subject’s books/', (await page.inputValue('#upload-form [name=folder]')) === 'beta/books', await page.inputValue('#upload-form [name=folder]'));
await page.click('#upload-form button[value=cancel]');

// Path of one subject
await page.click('#lib-path');
await page.waitForSelector('.progress-summary');
const summaries = await page.$$eval('.progress-summary', (n) => n.length);
const ids = await page.$$eval('.session-id', (n) => n.map((x) => x.textContent));
check('path page shows only this subject', summaries === 1 && ids.every((i) => i.startsWith('B')), `${summaries} ${ids.join()}`);
await page.click('#course-back');
await page.waitForFunction(() => location.hash === '#s=beta');
check('back from the path returns to the subject', true);

// Session page: links and back stay in the subject
await go('#doc=beta/sessions/B001.md');
await page.waitForSelector('#view-course:not([hidden]) .md h1');
const links = await page.$$eval('.md a', (n) => n.map((a) => a.getAttribute('href')));
check('in-session #review and #path links scoped to the subject', links.includes('#review&s=beta') && links.includes('#path&s=beta'), links.join());
check('toolbar links scoped to the session’s subject', (await page.getAttribute('#course-review', 'href')) === '#review&s=beta');
await page.click('#course-back');
await page.waitForFunction(() => location.hash === '#path&s=beta');
check('back from a session goes to its subject’s path', true);

// Review of one subject, then back to it
await go('#review&s=alpha');
await page.waitForSelector('#review-stage:not([hidden])');
const fronts = new Set();
for (let i = 0; i < 10 && !(await page.$eval('#review-stage', (e) => e.hidden)); i++) {
  fronts.add(await page.textContent('#review-front'));
  await page.click('#review-show');
  await page.click('#review-ratings button:nth-child(4)');
}
check('review of a subject has only its cards', fronts.size === 3 && [...fronts].every((f) => f.startsWith('Alpha')), [...fronts].join(' | '));
await page.click('#review-finish');
await page.waitForFunction(() => location.hash === '#s=alpha');
check('leaving a subject’s review returns to the subject', true);

// Hostile or unknown subject in the hash falls back to the home
await go('#s=../../etc');
await page.waitForSelector('#view-home:not([hidden])');
check('unknown subject → home', true);
await go('#path&s=%3Cimg%20src%3Dx%3E');
await page.waitForSelector('.progress-summary');
check('unknown subject on the path page → all subjects', (await page.$$eval('.progress-summary', (n) => n.length)) === 2);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
finish();
