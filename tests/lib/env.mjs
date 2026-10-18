// Shared test environment: paths, app URL, browser launch, result reporting.
import fs from 'fs';
import path from 'path';
import { chromium, devices } from 'playwright';

export { devices };

export const TESTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const ROOT = path.resolve(TESTS, '..');
export const FIXTURES = path.join(TESTS, 'fixtures');
export const APP = process.env.APP_URL || 'http://localhost:8765/';
export const ORIGIN = new URL(APP).origin;
/** Root of a Learn-like content repository (synthetic fixtures by default, never private data). */
export const CONTENT_DIR = process.env.CONTENT_DIR || path.join(FIXTURES, 'content');
export const SHOTS = path.join(TESTS, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

/** Chromium from Playwright, or a specific binary via PW_CHROMIUM_PATH. */
export function launch() {
  const executablePath = process.env.PW_CHROMIUM_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}

export function reporter() {
  const results = [];
  return {
    check(name, cond, extra = '') {
      results.push(!!cond);
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    },
    finish() {
      const passed = results.filter(Boolean).length;
      console.log(`\n${passed}/${results.length} passed`);
      process.exit(passed === results.length ? 0 : 1);
    },
  };
}
