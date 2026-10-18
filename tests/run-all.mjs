// Runs every end-to-end suite against a local static server; exit code 1 if any suite fails.
// Usage: node run-all.mjs [suite ...]   (env: APP_URL, CONTENT_DIR, PW_CHROMIUM_PATH, BIG_PDF)
import { spawn } from 'child_process';
import path from 'path';
import { serve } from './serve.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ALL = ['reader', 'security', 'review', 'course', 'update', 'perf'];
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const server = process.env.APP_URL ? null : await serve();

const run = (name) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'e2e', `${name}.mjs`)], { stdio: 'inherit', env: process.env });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

const outcome = {};
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  outcome[s] = await run(s);
}
server?.close();
console.log('\n=== summary ===');
for (const [s, ok] of Object.entries(outcome)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}`);
process.exit(Object.values(outcome).every(Boolean) ? 0 : 1);
