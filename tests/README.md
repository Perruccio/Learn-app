# Tests

End-to-end tests for Learn Reader. Each suite drives Chromium through Playwright against the static app,
with `api.github.com` mocked inside the browser context (no network, no token, no real repository).

| Suite | What it covers |
|---|---|
| `reader` | PDF rendering, highlights, notes, sync between two devices, offline queue, conflicts |
| `security` | malicious PDF (JS, XFA, links), CSP, sanitization of synced JSON |
| `review` | flashcards: unlock on session completion, FSRS review, KaTeX, hostile card content, sync |
| `course` | progress page, session stepper, to-dos, error log, solutions, completion, hostile markdown |
| `subjects` | several subjects: home dashboard, per-subject library, path, review, upload folder, hostile `s=` |
| `upload` | PDF upload via the Git Data API, concurrent push, rejected inputs |
| `update` | a newer `version.json` reloads the app exactly once |
| `perf` | optional benchmark, runs only with `BIG_PDF=/path/to/large.pdf` |

## Run

```bash
npm ci
npx playwright install chromium   # or PW_CHROMIUM_PATH=/path/to/chrome
npm test                          # all suites; or: node run-all.mjs course review
```

`run-all.mjs` starts `serve.mjs` (static server on port 8765) unless `APP_URL` is set.

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:8765/` | app under test |
| `CONTENT_DIR` | `fixtures/content` | Learn-like content root (contains `math/`) |
| `PW_CHROMIUM_PATH` | Playwright's Chromium | browser binary |
| `BIG_PDF` | unset | large PDF for `perf` |

The fixtures are synthetic: never copy content from the private Learn repository into this public repo.
Expectations are derived from the content, so the same suites also run on a local clone of the real
course: `CONTENT_DIR=/path/to/Learn node run-all.mjs review course`.

Screenshots go to `shots/` (git-ignored).
