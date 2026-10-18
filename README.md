# Learn Reader

Lettore PDF web per studiare dai libri del repository [`Perruccio/Learn`](https://github.com/Perruccio/Learn) (privato), con:

- lettura a schermo intero, zoom (anche pinch e Ctrl+rotella), indice del PDF, ricerca nel testo;
- evidenziazioni del testo in 4 colori, evidenziazioni ad area (per PDF scansionati e formule), note sulla pagina e note sulle evidenziazioni;
- ripresa dall'ultima pagina letta, su qualsiasi dispositivo;
- sincronizzazione su GitHub: ogni modifica è salvata subito sul dispositivo e sincronizzata in background pochi secondi dopo (e quando chiudi il libro o lasci l'app). Le modifiche fatte su dispositivi diversi vengono unite, annotazione per annotazione;
- PDF scaricati una sola volta e poi letti dalla cache del dispositivo (anche offline).
- **Percorso e sessioni nell'app**: avanzamento complessivo e per filone, pagina di ogni sessione (Markdown con formule) con una barra delle fasi (Ripasso · Domande · Teoria · Esercizi: un tocco sulla fase raggiunta), promemoria personali, soluzioni su richiesta, registro errori e pulsante "Segna la sessione come fatta". Stato in `<materia>/stato.json`, sincronizzato. GitHub non serve durante lo studio.
- **Flashcard con ripetizione spaziata** (algoritmo FSRS, quello delle versioni recenti di Anki) e formule LaTeX (KaTeX). Le carte sono file `flashcard/*.tsv` nel repository privato; quelle di una sessione si sbloccano quando la sessione è segnata come fatta in `PROGRESSI.md` (anche dal pulsante **Segna come fatta** nella libreria). Lo stato del ripasso è in `flashcard/progresso.json`, sincronizzato come le annotazioni.

**App:** <https://perruccio-learn.github.io/Learn-app/>

## Come funziona

Questo repository (pubblico) contiene solo il codice. I PDF e le annotazioni stanno nel repository privato, e l'app li legge e li scrive tramite l'API di GitHub con un token personale salvato nel browser.

Per ogni libro `cartella/nome.pdf` le annotazioni stanno in `cartella/nome.annotazioni.json`. Il file è JSON leggibile: un'annotazione per blocco, con pagina, colore, testo evidenziato, nota e posizione (in frazioni della pagina, quindi indipendente dallo zoom).

Link diretto a un libro e a una pagina:

```
https://perruccio-learn.github.io/Learn-app/#read=matematica/libri/axler-ladr-4ed.pdf&page=20
```

## Primo accesso (una volta per dispositivo)

1. Crea un *fine-grained token* su GitHub: **Settings → Developer settings → Fine-grained tokens → Generate new token**.
   - **Repository access:** *Only select repositories* → `Learn`.
   - **Permissions → Contents:** *Read and write*.
2. Apri l'app, incolla il token e premi **Connetti**.

Su iPhone e Android: dal browser usa **Condividi → Aggiungi alla schermata Home**. L'app si apre a schermo intero, come un'app normale.

## Sicurezza

### Cosa è pubblico e cosa no

Il sito e questo repository sono pubblici, ma contengono **solo codice**: nessun dato, nessun segreto. Chi apre l'app senza token vede solo la schermata di collegamento e non può leggere niente. PDF, annotazioni e flashcard stanno nel repository privato `Learn`, raggiungibile solo con il token, che resta nel browser dei tuoi dispositivi. Il fatto che il codice sia leggibile non indebolisce nulla: la sicurezza non si basa sul tenerlo nascosto.

### Rischi residui e contromisure

| Rischio | Contromisura |
|---|---|
| Furto del token tramite codice iniettato (PDF, carte, annotazioni) | CSP rigida, nessuno script esterno, contenuti validati e inseriti solo come testo (dettagli sotto) |
| L'app incorporata in una pagina malevola (clickjacking) | L'app si rifiuta di funzionare dentro un frame |
| Dispositivo condiviso, perso o rubato | Opzione "Ricorda su questo dispositivo" disattivabile; token con scadenza; revoca immediata su github.com → Settings → Fine-grained tokens |
| Furto del token: danni possibili | Il token vale per **un solo** repository e solo per i contenuti: niente impostazioni, niente altri repo |
| Altri siti GitHub Pages dello stesso account | Tutti i siti `perruccio.github.io/*` condividono la stessa origine e quindi lo stesso spazio del browser. **Non pubblicare altri siti Pages con script di terze parti**, oppure sposta l'app su un'origine dedicata (vedi sotto) |
| Compromissione dell'account GitHub (chi la ottiene può modificare il codice dell'app) | Autenticazione a due fattori sull'account GitHub (indispensabile) |

**Origine dedicata (consigliata).** Per isolare del tutto l'app, crea un'organizzazione GitHub gratuita (ad esempio `perruccio-learn`) e trasferisci lì `Learn-app`. L'app sarà su `perruccio-learn.github.io`, un'origine usata solo da lei.

### Difese tecniche

Un PDF è un file non fidato, quindi il reader adotta queste difese:

- **Il codice dei PDF non viene mai eseguito.** PDF.js gira senza motore di scripting, con `isEvalSupported: false` (la classe di attacchi di CVE-2024-4367) e con i moduli XFA disattivati. La versione inclusa (4.10.38) non è tra quelle colpite da CVE-2026-16633 (5.6.83–6.2.107), che comunque richiede lo scripting attivo.
- **Content Security Policy rigida.** Possono girare solo gli script di questo sito, senza `unsafe-inline` né `unsafe-eval`, e l'unico server raggiungibile è `api.github.com`. Anche se un PDF o un file di annotazioni riuscisse a iniettare codice, il browser non lo eseguirebbe e non potrebbe inviare dati altrove.
- **Link esterni sempre confermati.** Un link nel PDF mostra l'indirizzo completo e si apre solo dopo conferma, in una nuova scheda con `noopener` e `noreferrer`. I link `javascript:` vengono scartati.
- **Markdown sicuro.** Le pagine sono costruite con le API del DOM, senza mai interpretare HTML: tag, script e link `javascript:`/`data:` presenti nei file restano testo. I link verso altri file del repository restano dentro l'app.
- **Flashcard sicure.** Il testo delle carte è inserito come testo: sono ammessi solo `<b>`, `<i>`, `<u>`, `<code>` e `<br>`, ricostruiti senza attributi. Le formule passano da KaTeX con `trust: false` (niente `\href` o HTML). L'unica eccezione nella CSP è `style-src-attr 'unsafe-inline'`, necessaria a KaTeX per l'impaginazione delle formule: gli attributi di stile non possono eseguire codice.
- **Annotazioni validate.** I file `.annotazioni.json` vengono letti con una whitelist: campi sconosciuti scartati, colori e tipi controllati, coordinate solo numeriche, testi con lunghezza massima. Tutto il testo viene inserito come testo, mai come HTML.
- **Solo PDF veri.** Il caricamento controlla l'intestazione `%PDF-`, e un file che non è un PDF non viene aperto.
- **Nessuna dipendenza esterna.** Nessuna CDN e nessun servizio di terze parti: tutto il codice è in questo repository.
- **Token con accesso minimo.** Il token vale per un solo repository, con il solo permesso *Contents*, e resta nel browser del dispositivo.

## Sviluppo

Sito statico, senza build: HTML, CSS e moduli JavaScript in `js/`. Librerie incluse in `vendor/`: PDF.js 4.10.38 (build *legacy*, Apache-2.0), KaTeX 0.18.11 (MIT, caricato solo nel ripasso), ts-fsrs 5.4.2 (MIT).

```bash
python -m http.server 8000   # poi apri http://localhost:8000
```

Prima di ogni commit: `python scripts/stamp.py`. Aggiunge una versione ricavata dal contenuto (`?v=…`) a moduli e fogli di stile e aggiorna `version.json`. GitHub Pages fa tenere i file in cache per circa 10 minuti: con la versione, i browser caricano subito il codice nuovo e l'app aperta si accorge da sola dell'aggiornamento.

### Test

Test end-to-end con Playwright in `tests/` (dettagli in [`tests/README.md`](tests/README.md)): reader, sicurezza (PDF e markdown ostili, CSP), ripasso, pagine del corso, aggiornamento automatico. L'API di GitHub è simulata e i contenuti sono sintetici (`tests/fixtures/`): nel repo pubblico non entra niente del repo privato.

```bash
cd tests && npm ci && npx playwright install chromium && npm test
```

La CI (`.github/workflows/ci.yml`) esegue i test a ogni push e pull request e pubblica su GitHub Pages solo da `main` e solo se i test passano. Controlla anche che `scripts/stamp.py` sia stato eseguito. Le action sono fissate a commit SHA.
