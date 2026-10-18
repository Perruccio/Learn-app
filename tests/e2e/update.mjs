// Self-update: a newer version.json triggers exactly one reload (no loop).
import { APP, launch, reporter } from '../lib/env.mjs';

const { check, finish } = reporter();
const browser = await launch();
const ctx = await browser.newContext();
let fake = null;
await ctx.route('**/version.json*', (r) => (fake ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: fake }) }) : r.continue()));
const page = await ctx.newPage();
let loads = 0;
page.on('load', () => loads++);
await page.goto(APP);
await page.waitForTimeout(1500);
const before = loads;
fake = 'ffffffffffff';
await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(500);
// first check happened at start (same version, no reload); the throttle blocks a second check within 60s,
// so simulate a fresh start instead:
await page.reload();
await page.waitForTimeout(2500);
const n = loads - before;
check('app reloads itself once when a new version is deployed (no loop)', n === 2, `loads=${n}`);
check('then offers a manual update', /nuova versione/.test(await page.evaluate(() => document.querySelector('#toasts')?.textContent || '')));
await browser.close();
finish();
