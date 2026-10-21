# Learn Reader

Web PDF reader for studying from the books of the [`Perruccio/Learn`](https://github.com/Perruccio/Learn) repository (private), with:

- full-screen reading, zoom (pinch and Ctrl+wheel too), PDF table of contents, text search;
- text highlights in 4 colors, area highlights (for scanned PDFs and formulas), notes on the page and notes on highlights;
- resume from the last page read, on any device;
- sync through GitHub: every change is saved on the device right away and synced in the background a few seconds later (and when you close the book or leave the app). Changes made on different devices are merged, annotation by annotation;
- PDFs downloaded only once and then read from the device cache (offline too).
- **Path and sessions in the app**: overall and per-track progress, a page for each session (Markdown with formulas) with a phase bar (Review · Pretest · Theory · Exercises: one tap on the phase reached), personal reminders, "Skip this topic" (to recover later or dropped for good: no exercises, reviews or flashcards), solutions on demand, error log and a "Mark session as done" button. State in `<subject>/state.json`, synced. GitHub is not needed while studying.
- **Flashcards with spaced repetition** (FSRS algorithm, the one in recent Anki versions) and LaTeX formulas (KaTeX). Cards are `flashcards/*.tsv` files in the private repository; the cards of a session unlock when the session is marked as done in `PROGRESS.md` (also from the **Mark session as done** button on the session page). `ERR-*` (error log) and `HL-*` (PDF highlights) files are always active. Review state is in `flashcards/progress.json`, synced like annotations.

**App:** <https://perruccio-learn.github.io/Learn-app/>

## How it works

This repository (public) contains only the code. PDFs and annotations live in the private repository, and the app reads and writes them through the GitHub API with a personal token saved in the browser.

For every book `folder/name.pdf` the annotations are in `folder/name.annotations.json`. The file is readable JSON: one annotation per block, with page, color, highlighted text, note and position (as fractions of the page, so independent of zoom).

Direct link to a book and a page:

```
https://perruccio-learn.github.io/Learn-app/#read=math/books/axler-ladr-4ed.pdf&page=20
```

Other routes: `#path` (progress), `#review` (flashcards), `#doc=<file.md>`, `#setup`. The old `#percorso` and `#ripasso` still work and redirect to `#path` and `#review`.

## First access (once per device)

1. Create a *fine-grained token* on GitHub: **Settings → Developer settings → Fine-grained tokens → Generate new token**.
   - **Repository access:** *Only select repositories* → `Learn`.
   - **Permissions → Contents:** *Read and write*.
2. Open the app, paste the token and press **Connect**.

On iPhone and Android: in the browser use **Share → Add to Home Screen**. The app opens full screen, like a regular app.

## Security

### What is public and what is not

The site and this repository are public, but they contain **only code**: no data, no secrets. Anyone opening the app without a token sees only the connection screen and cannot read anything. PDFs, annotations and flashcards live in the private `Learn` repository, reachable only with the token, which stays in the browser of your devices. The code being readable weakens nothing: security does not rely on keeping it hidden.

### Residual risks and countermeasures

| Risk | Countermeasure |
|---|---|
| Token theft through injected code (PDFs, cards, annotations) | Strict CSP, no external scripts, content validated and inserted only as text (details below) |
| The app embedded in a malicious page (clickjacking) | The app refuses to run inside a frame |
| Shared, lost or stolen device | "Remember on this device" option can be turned off; token with expiration; immediate revocation on github.com → Settings → Fine-grained tokens |
| Token theft: possible damage | The token is valid for **one** repository and only for its contents: no settings, no other repos |
| Other GitHub Pages sites of the same account | All `perruccio.github.io/*` sites share the same origin and therefore the same browser storage. **Do not publish other Pages sites with third-party scripts**, or move the app to a dedicated origin (see below) |
| GitHub account compromise (whoever gets it can change the app's code) | Two-factor authentication on the GitHub account (essential) |

**Dedicated origin (recommended).** To isolate the app completely, create a free GitHub organization (for example `perruccio-learn`) and transfer `Learn-app` there. The app will be on `perruccio-learn.github.io`, an origin used only by it.

### Technical defenses

A PDF is an untrusted file, so the reader applies these defenses:

- **PDF code is never executed.** PDF.js runs without a scripting engine, with `isEvalSupported: false` (the attack class of CVE-2024-4367) and with XFA forms disabled. The bundled version (4.10.38) is not among those affected by CVE-2026-16633 (5.6.83–6.2.107), which in any case requires scripting to be enabled.
- **Strict Content Security Policy.** Only this site's scripts can run, without `unsafe-inline` or `unsafe-eval`, and the only reachable server is `api.github.com`. Even if a PDF or an annotation file managed to inject code, the browser would not run it and it could not send data anywhere else.
- **External links always confirmed.** A link in the PDF shows the full address and opens only after confirmation, in a new tab with `noopener` and `noreferrer`. `javascript:` links are discarded.
- **Safe Markdown.** Pages are built with DOM APIs, never interpreting HTML: tags, scripts and `javascript:`/`data:` links in the files stay text. Links to other files of the repository stay inside the app.
- **Safe flashcards.** Card text is inserted as text: only `<b>`, `<i>`, `<u>`, `<code>` and `<br>` are allowed, rebuilt without attributes. Formulas go through KaTeX with `trust: false` (no `\href` or HTML). The only exception in the CSP is `style-src-attr 'unsafe-inline'`, needed by KaTeX to lay out formulas: style attributes cannot run code.
- **Validated annotations and state.** `.annotations.json`, `state.json` and `progress.json` files are read with a whitelist: unknown fields dropped, colors and types checked, coordinates numeric only, texts with a maximum length. All text is inserted as text, never as HTML.
- **Real PDFs only.** Upload checks the `%PDF-` header, and a file that is not a PDF is not opened.
- **No external dependencies.** No CDN and no third-party service: all the code is in this repository.
- **Least-privilege token.** The token is valid for one repository only, with only the *Contents* permission, and stays in the device's browser.

## Development

Static site, no build: HTML, CSS and JavaScript modules in `js/`. Libraries bundled in `vendor/`: PDF.js 4.10.38 (*legacy* build, Apache-2.0), KaTeX 0.18.11 (MIT, loaded only when formulas are shown), ts-fsrs 5.4.2 (MIT).

```bash
python -m http.server 8000   # then open http://localhost:8000
```

Before every commit: `python scripts/stamp.py`. It adds a content-derived version (`?v=…`) to modules and stylesheets and updates `version.json`. GitHub Pages lets files be cached for about 10 minutes: with the version, browsers load the new code right away and an open app notices the update on its own.

### Tests

End-to-end tests with Playwright in `tests/` (details in [`tests/README.md`](tests/README.md)): reader, security (hostile PDFs and markdown, CSP), review, course pages, automatic update. The GitHub API is mocked and the content is synthetic (`tests/fixtures/`): nothing from the private repo enters the public repo.

```bash
cd tests && npm ci && npx playwright install chromium && npm test
```

CI (`.github/workflows/ci.yml`) runs the tests on every push and pull request and publishes to GitHub Pages only from `main` and only if the tests pass. It also checks that `scripts/stamp.py` was run. Actions are pinned to commit SHAs.
