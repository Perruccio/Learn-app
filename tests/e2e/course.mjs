// In-app course tests: progress page, session pages, checklists, errors, solutions, completion.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { APP, ORIGIN, CONTENT_DIR, FIXTURES, SHOTS, devices, launch } from '../lib/env.mjs';

const LEARN = CONTENT_DIR;
// Expectations derived from the content, so the suite runs on fixtures and on the real course.
const PROG = fs.readFileSync(path.join(LEARN, 'math/PROGRESS.md'), 'utf8');
const ROWS = [...PROG.matchAll(/^\| \[[ x]\] \| (\[)?([A-Z]\d{2,4})/gm)].map((m) => ({ id: m[2], linked: !!m[1] }));
const FIRST_UNLINKED = ROWS.find((r) => !r.linked)?.id;
const N_DOCS = ['method.md', 'setup.md', 'resources.md'].filter((f) => fs.existsSync(path.join(LEARN, 'math/method', f))).length
  + fs.readdirSync(path.join(LEARN, 'math/roadmap')).filter((f) => f.endsWith('.md')).length;
const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const repo = new Map();
const put = (p, b) => repo.set(p, { buf: Buffer.from(b), sha: gitSha(Buffer.from(b)) });
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '.git' ? [] : walk(path.join(dir, d.name))) : [path.join(dir, d.name)]));
// Start from a fresh path (every session to do), so the suite also runs on a course in progress.
const untick = (text) => text.replace(/^\| \[[xX]\] \|/gm, '| [ ] |');
// Only the math subject: with a second subject the app would open on the home instead of the library.
for (const f of walk(path.join(LEARN, 'math'))) if (/\.(md|tsv|ipynb)$/.test(f)) put(path.relative(LEARN, f), /(^|\/)PROGRESS\.md$/.test(f) ? untick(fs.readFileSync(f, 'utf8')) : fs.readFileSync(f));
put('math/evil.md', '# Evil\n\n<script>window.__pwned=1</script>\n\n<img src=x onerror="window.__pwned=1">\n\n[click](javascript:window.__pwned=1) [data](data:text/html,hi) $\\href{javascript:alert(1)}{x}$\n\n| a | b |\n|---|---|\n| <b onclick="window.__pwned=1">x</b> | y |\n');
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
const synced = (page) => page.waitForFunction(() => [...document.querySelectorAll('[data-sync-pill]')].every((p) => p.dataset.state === 'synced'), null, { timeout: 20000 });

const A = await device({ viewport: { width: 1200, height: 900 } });
await A.page.waitForSelector('#next-session:not([hidden])');
const nextHref = await A.page.getAttribute('#next-open', 'href');
check('home links the next session inside the app', nextHref === '#doc=math/sessions/S001.md', nextHref);
await A.page.click('#next-open');
await A.page.waitForSelector('#view-course:not([hidden]) .md h1');
check('session page title', /S001/.test(await A.page.textContent('#course-title')), await A.page.textContent('#course-title'));
const katexInfo = await A.page.evaluate(() => ({ ok: document.querySelectorAll('.md .katex').length, bad: document.querySelectorAll('.md .katex-error').length }));
check('formulas rendered with KaTeX', katexInfo.ok > 3 && katexInfo.bad === 0, JSON.stringify(katexInfo));
const steps = await A.page.$$eval('.stepper .step', (n) => n.map((x) => x.textContent.trim()));
check('stepper with the 4 phases of the session', steps.length === 4 && /Review/.test(steps[0]) && /Pretest/.test(steps[1]) && /Theory/.test(steps[2]) && /Exercises/.test(steps[3]), steps.join(' | '));
const links = await A.page.evaluate(() => [...document.querySelectorAll('.md a')].map((a) => [a.textContent.trim(), a.getAttribute('href'), a.target, a.rel]));
const reader = links.find(([t]) => /reader/i.test(t));
const codespaces = links.find(([t]) => /Codespaces/.test(t));
const notebook = links.find(([t]) => /\.ipynb$/.test(t));
const solLink = links.find(([, h]) => h && h.includes('solutions'));
check('reader link stays in the app', reader && /^#read=math\/books\/[^/]+\.pdf$/.test(reader[1]), String(reader));
check('notebook link opens Codespaces in a new tab', codespaces && /^https:\/\/codespaces\.new\/[^/?#]+\/[^/?#]+\?quickstart=1$/.test(codespaces[1]) && codespaces[2] === '_blank', String(codespaces));
check('relative notebook link resolves to Codespaces, not Colab', notebook && notebook[1] === 'https://codespaces.new/Perruccio/Learn?quickstart=1' && notebook[2] === '_blank', String(notebook));
check('links to other files stay in the app', solLink && solLink[1].startsWith('#doc=math/solutions/'), String(solLink));
check('every content link opens in a new tab', links.length > 0 && links.every(([, , tgt]) => tgt === '_blank'), JSON.stringify(links.filter(([, , tgt]) => tgt !== '_blank')));
check('only app routes keep the opener; external links are noopener', links.every(([, h, , rel]) => (h.startsWith('#') ? rel === 'opener' : /noopener/.test(rel) && /noreferrer/.test(rel))), JSON.stringify(links.map(([, h, , r]) => [h.slice(0, 30), r])));
{
  await A.page.evaluate(() => sessionStorage.setItem('learnreader:probe', '1'));
  const [popup] = await Promise.all([A.page.context().waitForEvent('page'), A.page.click(`.md a[href="${reader[1]}"]`)]);
  await popup.waitForSelector('#view-reader:not([hidden])', { timeout: 15000 }).catch(() => {});
  const popupView = await popup.evaluate(() => document.body.dataset.view);
  check('reader link opens the reader in a new tab, the session stays open', popupView === 'reader' && /S001/.test(await A.page.textContent('#course-title')), popupView);
  check('tab-only storage (token not remembered) reaches the new tab', (await popup.evaluate(() => sessionStorage.getItem('learnreader:probe'))) === '1');
  await A.page.evaluate(() => sessionStorage.removeItem('learnreader:probe'));
  await popup.close();
}
await A.page.screenshot({ path: `${SHOTS}/c1-session.png` });

// One tap = "I got here": tapping phase 3 marks 1–3 done
await A.page.click('.stepper .step:nth-child(3) button');
await A.page.waitForFunction(() => document.querySelectorAll('.stepper .step.s-done').length === 3);
check('tap on phase 3 marks phases 1–3 as done', /Exercises/.test(await A.page.textContent('.step-hint')), await A.page.textContent('.step-hint'));
await A.page.click('.stepper .step:nth-child(3) button');
await A.page.waitForFunction(() => document.querySelectorAll('.stepper .step.s-done').length === 2);
check('tapping the last done phase again steps back', true);
await A.page.click('.stepper .step:nth-child(3) button');
await A.page.waitForFunction(() => document.querySelectorAll('.stepper .step.s-done').length === 3);
// Optional personal to-do
await A.page.fill('.session-reminders .add-input', 'Redo T3 tomorrow');
await A.page.press('.session-reminders .add-input', 'Enter');
await A.page.waitForSelector('.session-reminders .check-list li');
check('personal to-do added', (await A.page.textContent('.session-reminders .check-list')).includes('Redo T3'));
check('reminders are at the top, before the session content', await A.page.evaluate(() => {
  const r = document.querySelector('.session-reminders');
  const md = document.querySelector('article.md');
  return !!(r && md && r.compareDocumentPosition(md) & Node.DOCUMENT_POSITION_FOLLOWING);
}));
// Error log
await A.page.fill('textarea[data-field="what"]', 'Mixed up union and sum of subspaces');
await A.page.fill('textarea[data-field="fix"]', 'U+W is the smallest subspace containing U∪W');
await A.page.click('.error-form .btn');
await A.page.waitForSelector('.error-list li');
check('error added to the log', (await A.page.textContent('.error-list')).includes('Mixed up'));
await synced(A.page);
const state = JSON.parse(repo.get('math/state.json').buf.toString());
check('state synced to state.json', state.sessions.S001.stage.value === 3 && Object.values(state.errors).length === 1, JSON.stringify(state).slice(0, 120));

await synced(A.page);
// Solutions
await A.page.click('.session-end .btn >> text=Show solutions');
await A.page.waitForSelector('.solutions:not([hidden]) pre code');
check('solutions rendered in the app with code blocks', (await A.page.$$('.solutions pre')).length >= 1);

// Completion
await A.page.click('.session-end .btn-primary');
await A.page.waitForSelector('.session-end .btn >> text=✓ Done');
check('PROGRESS.md ticked from the session page', /\| \[x\] \| \[S001\]/.test(repo.get('math/PROGRESS.md').buf.toString()));
check('app commit messages in English', puts.includes('math/PROGRESS.md :: reader: S001 done') && puts.some((p) => p.startsWith('math/state.json :: reader: session progress')), puts.join(' ; '));

// Progress page
await A.page.click('#view-course a[href="#path"]');
await A.page.waitForSelector('.progress-summary');
await sleep(500);
check('progress shows 1 completed session', new RegExp(`1 of ${ROWS.length}\\b`).test(await A.page.textContent('.progress-summary')), (await A.page.textContent('.progress-summary')).slice(0, 60));
const trackNames = await A.page.$$eval('.track-name', (n) => n.map((x) => x.textContent));
check('progress grouped by word track codes', trackNames.includes('LinAlg') && trackNames.includes('Prob') && trackNames.every((t) => /^[A-Za-z]+$/.test(t)), trackNames.join(' '));
const rows = await A.page.$$eval('.session-row', (n) => n.map((r) => [r.querySelector('.session-id').textContent, r.querySelector('.session-state').textContent, r.tagName]));
check('statuses: S001 done, S002 todo, unprepared sessions not yet available', rows[0][1] === 'Done' && rows[1][1] === 'To do' && (!FIRST_UNLINKED || rows.find((r) => r[0] === FIRST_UNLINKED)[2] === 'DIV'), JSON.stringify(rows.slice(0, 2)));
// Skip a topic: choose "recover later", then undo, then "drop for good"
await A.page.click('.session-row >> text=S002');
await A.page.waitForSelector('.skip-open');
await A.page.click('.skip-open');
await A.page.screenshot({ path: `${SHOTS}/c5-skip-ask.png` });
await A.page.click('.skip-box [data-skip="later"]');
await A.page.waitForSelector('.skip-box.is-skipped');
check('skipped topic shown on the session page', /recover later/.test(await A.page.textContent('.skip-box')));
await synced(A.page);
const skipState = JSON.parse(repo.get('math/state.json').buf.toString()).sessions.S002?.skip;
check('skip synced to state.json', skipState?.value === 'later' && skipState.updatedAt > 0, JSON.stringify(skipState));
await A.page.click('.skip-box .btn-ghost');
await A.page.waitForSelector('.skip-open');
check('skip can be undone', true);
await A.page.click('.skip-open');
await A.page.click('.skip-box [data-skip="drop"]');
await A.page.waitForSelector('.skip-box.is-skipped');
await A.page.click('#view-course a[href="#path"]');
await A.page.waitForSelector('.progress-summary');
await sleep(300);
const dropped = await A.page.$$eval('.session-row', (n) => n.map((r) => r.querySelector('.session-state').textContent));
check('dropped topic marked in the path and not counted', dropped[1] === 'Dropped from the path' && new RegExp(`1 of ${ROWS.length - 1}\\b`).test(await A.page.textContent('.progress-summary')), dropped[1]);
await A.page.evaluate(() => (location.hash = '#'));
await A.page.waitForSelector('#next-session:not([hidden])');
await A.page.waitForFunction(() => !/S002/.test(document.querySelector('#next-title').textContent));
check('home skips the dropped session', new RegExp(ROWS[2].id).test(await A.page.textContent('#next-title')), await A.page.textContent('#next-title'));
// Tampered skip values are dropped by the codec
const revived = await A.page.evaluate(async () => {
  const { _test } = await import('./js/course.js');
  const doc = _test.reviveState({ sessions: { S001: { skip: { value: '<img src=x onerror=alert(1)>', updatedAt: 1 } }, S002: { skip: { value: 'drop', updatedAt: 'x' } }, S003: { skip: { value: 'later', updatedAt: 5, evil: 1 } } } }, 'm');
  return [doc.sessions.S001.skip, doc.sessions.S002.skip, doc.sessions.S003.skip];
});
check('tampered skip values rejected', revived[0] === null && revived[1] === null && JSON.stringify(revived[2]) === '{"value":"later","updatedAt":5}', JSON.stringify(revived));
// Old Italian routes still work: they redirect to the new ones
await A.page.evaluate(() => (location.hash = '#'));
await A.page.waitForSelector('#view-library:not([hidden])');
await A.page.evaluate(() => (location.hash = '#percorso'));
await A.page.waitForSelector('#view-course:not([hidden]) .progress-summary');
check('#percorso redirects to #path', (await A.page.evaluate(() => location.hash)) === '#path' && (await A.page.textContent('#course-title')) === 'Path', await A.page.evaluate(() => location.hash));
check('documents listed (method pages and roadmaps)', (await A.page.$$('.doc-links a')).length === N_DOCS, String((await A.page.$$('.doc-links a')).length));
await A.page.screenshot({ path: `${SHOTS}/c2-progress.png`, fullPage: false });
// A roadmap document renders with its table
await A.page.click('.doc-links a >> text=/^Roadmap · LinAlg/');
await A.page.waitForSelector('.md table');
check('roadmap document with table rendered', (await A.page.$$('.md table tr')).length > 3);

// Hostile markdown
await A.page.evaluate(() => (location.hash = '#doc=math/evil.md'));
await A.page.waitForSelector('.md h1 >> text=Evil');
await sleep(500);
const evil = await A.page.evaluate(() => ({
  pwned: window.__pwned,
  scripts: document.querySelectorAll('.md script, .md img, .md [onclick], .md [onerror]').length,
  jsLinks: [...document.querySelectorAll('.md a')].filter((a) => !/^(https?:|#|mailto:)/.test(a.getAttribute('href'))).length,
  text: document.querySelector('.md').textContent.includes('<script>'),
}));
check('hostile markdown shown as text, nothing executed', evil.pwned === undefined && evil.scripts === 0 && evil.jsLinks === 0 && evil.text, JSON.stringify(evil));

// All repository markdown renders without KaTeX errors
const all = await A.page.evaluate(async (paths) => {
  const { renderMarkdown } = await import('./js/markdown.js');
  const { loadMath } = await import('./js/cards.js');
  await loadMath();
  const bad = [];
  let math = 0;
  for (const [p, text] of paths) {
    const div = document.createElement('div');
    div.append(renderMarkdown(text, {}));
    math += div.querySelectorAll('.katex').length;
    for (const e of div.querySelectorAll('.katex-error')) bad.push(`${p}: ${e.textContent.slice(0, 40)}`);
    // leftover $ signs usually mean a formula was not recognized
    for (const c of div.querySelectorAll('code, pre')) c.remove(); // literal $ in code is fine
    const stray = div.textContent.match(/\$[^$\s][^$]{0,40}\$/);
    if (stray) bad.push(`${p}: stray ${stray[0]}`);
  }
  return { math, bad };
}, [...repo].filter(([k]) => k.endsWith('.md') && k.includes('/') && k !== 'math/evil.md').map(([k, v]) => [k, v.buf.toString()]));
check('every repository document renders its math', all.bad.length === 0 && all.math > 10, `${all.math} formulas; ${all.bad.slice(0, 4).join(' ; ')}`);

// Device B sees the same checklist
const B = await device({ ...devices['iPhone 13'] });
await B.page.evaluate(() => (location.hash = '#doc=math/sessions/S001.md'));
await B.page.waitForSelector('.stepper .step');
await sleep(1500);
check('device B sees the phase reached, the to-do and the errors', (await B.page.$$('.stepper .step.s-done')).length === 4 && /session done/i.test(await B.page.textContent('.step-hint')) && (await B.page.$$('.error-list li')).length === 1 && (await B.page.$$('.session-reminders .check-list li')).length === 1);
await B.page.screenshot({ path: `${SHOTS}/c3-phone-session.png` });
await B.page.evaluate(() => (location.hash = '#path'));
await B.page.waitForSelector('.progress-summary');
await sleep(400);
await B.page.screenshot({ path: `${SHOTS}/c4-phone-progress.png` });

check('no JS/CSP errors on A', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
check('no JS/CSP errors on B', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
