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
- The threat model is in `README.md` (section "Security"); update it when the attack surface changes.

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
   Optionally also against the real course: `CONTENT_DIR=/path/to/Learn node run-all.mjs review course`, and
   `CONTENT_DIR=/path/to/Learn SUBJECT=<folder> node run-all.mjs render` (every page and card of a subject renders).
4. Commit and push to `main` (or work on a branch, then merge it into `main` and delete it, remote and
   local: no leftover branches); CI (`.github/workflows/ci.yml`) tests and deploys to Pages.
   GitHub Actions are pinned to full commit SHAs.

Test fixtures in `tests/fixtures/` are synthetic: never copy private content from `Perruccio/Learn`
into this public repo.

## Content formats the app relies on (defined in the Learn repo)

- Subjects: every folder with a `PROGRESS.md` is a subject (`math/`, `quantfinance/`, ...), with its own
  sessions, flashcards, books, `state.json`. With several subjects the home (`#`) shows one card per
  subject (progress, next session, cards due) and `#s=<folder>` opens one; `#path` and `#review` take
  `&s=<folder>` (`#review` alone = all subjects). With one subject the app opens it directly. Its name is
  the first heading of `<folder>/README.md` (trailing "study" dropped), else the folder name. Uploads go
  to `<folder>/books` of the current subject. Paths below use `math/` as the example.
- `math/PROGRESS.md`: table rows `| [ ] | [S001](sessions/S001.md) | LinAlg-01 | Title |`;
  a row without a link = session not prepared yet. Track codes are words before the dash
  (`LinAlg`, `Prob`, `FuncAn`, `Stat`, `Opt`); anything else (e.g. `Mixed`) is grouped as `Mixed`.
- `math/sessions/S###.md`: numbered sections `## 1 · Review (10')`, `## 2 · Pretest (3')`,
  `## 3 · Theory (22')`, `## 4 · Exercises (25')` become the stepper (labels taken from the headings).
  Solutions in `math/solutions/S###.md`, method pages in `math/method/`, roadmaps in `math/roadmap/`.
- `math/flashcards/*.tsv`: Anki-style TSV with `#separator:tab` headers; session cards unlock
  when the session is ticked. `ERR-*` and `HL-*` files (and legacy `EVID-*`) are always active.
- `math/state.json`, `flashcards/progress.json`, `<pdf>.annotations.json`: written by the app.
  Books in `<subject>/books/` (default upload folder).
- Hash routes: `#read=<pdf>&page=n`, `#doc=<md>`, `#s=<subject>`, `#path`, `#review` (both with optional `&s=`), `#setup`; the old `#percorso`
  and `#ripasso` redirect to `#path` and `#review`.

## Repositories

- App: `perruccio-learn/Learn-app` (public; separate org for an isolated origin). The old
  `Perruccio/Learn-app` URL redirects to it.
- Content: `Perruccio/Learn` (private).
