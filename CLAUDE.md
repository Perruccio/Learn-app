# Learn Reader: guide for Claude

Static web app (GitHub Pages, https://perruccio-learn.github.io/Learn-app/) for studying from the private
repo `Perruccio/Learn`: PDF reader with synced highlights/notes, flashcards (FSRS), course pages
(sessions, progress, error log). Owner: Francesco. Talk to him in Italian; code, comments, docstrings
and commit messages in English. Keep answers concise.

## Security first (non-negotiable)

Security always comes before features and speed. The app is public and runs with a GitHub token
that can write to the private repo, so:

- Never weaken the CSP in `index.html` (no inline scripts, no `eval`, no new origins in
  `connect-src` beyond `https://api.github.com`, no CDNs: vendor every library in `vendor/`).
- PDF.js stays locked down: `isEvalSupported: false`, `enableXfa: false`, no scripting; external
  links need confirmation and open with `noopener`.
- Everything read from the repo (JSON, TSV, markdown) is untrusted: sanitize with whitelists, build
  DOM nodes (never `innerHTML` with data), KaTeX with `trust: false`.
- The token lives only in the browser (localStorage/sessionStorage); never log it or send it
  anywhere except `api.github.com`.
- Add a test to `tests/e2e/security.mjs` (or the relevant suite) for every new input path.
- The threat model is in `README.md` (section "Sicurezza"); update it when the attack surface changes.

## Constraints

- No build step: plain ES modules in `js/`, CSS in `css/`. Do not add a bundler or npm runtime deps.
- The app must stay fast: lazy-load heavy code (KaTeX via `loadMath()`), no long tasks while scrolling.
- Local-first sync (`js/sync.js`): debounced pushes, per-item last-writer-wins by `updatedAt`.
  New synced state needs a codec with whitelist sanitization.
- Vendored libraries: pin exact versions at least two weeks old; record license and version in README.

## Workflow

1. Change code.
2. Run `python scripts/stamp.py` (cache busting; CI fails if forgotten).
3. Run the tests: `cd tests && npm ci && PW_CHROMIUM_PATH=... node run-all.mjs`
   (in Claude cloud sessions use `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`, or
   `/opt/pw-browsers/chromium/chrome-linux/chrome` if that is a directory layout; never run `playwright install` there).
   Optionally also against the real course: `CONTENT_DIR=/path/to/Learn node run-all.mjs review course`.
4. Commit and push to `main`; CI (`.github/workflows/ci.yml`) tests and deploys to Pages.
   GitHub Actions are pinned to full commit SHAs.

Test fixtures in `tests/fixtures/` are synthetic: never copy private content from `Perruccio/Learn`
into this public repo.

## Content formats the app relies on (defined in the Learn repo)

- `matematica/PROGRESSI.md`: table rows `| [ ] | [S001](sessioni/S001.md) | LA-01 | Title |`;
  a row without a link = session not prepared yet.
- `matematica/sessioni/S###.md`: numbered sections `## 1 · Ripasso (10')` … `## 4 · Esercizi (25')`
  become the stepper.
- `matematica/flashcard/*.tsv`: Anki-style TSV with `#separator:tab` headers; session cards unlock
  when the session is ticked. `ERR-*` and `EVID-*` files are always active.
- `matematica/stato.json`, `flashcard/progresso.json`, `<pdf>.annotazioni.json`: written by the app.

## Repositories

- App: `perruccio-learn/Learn-app` (public; separate org for an isolated origin). The old
  `Perruccio/Learn-app` URL redirects to it.
- Content: `Perruccio/Learn` (private).
