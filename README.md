# Learn Reader

Lettore PDF web per studiare dai libri del repository [`Perruccio/Learn`](https://github.com/Perruccio/Learn) (privato), con:

- lettura a schermo intero, zoom (anche pinch e Ctrl+rotella), indice del PDF, ricerca nel testo;
- evidenziazioni del testo in 4 colori, evidenziazioni ad area (per PDF scansionati e formule), note sulla pagina e note sulle evidenziazioni;
- ripresa dall'ultima pagina letta, su qualsiasi dispositivo;
- sincronizzazione su GitHub: ogni modifica è salvata subito sul dispositivo e sincronizzata in background pochi secondi dopo (e quando chiudi il libro o lasci l'app). Le modifiche fatte su dispositivi diversi vengono unite, annotazione per annotazione;
- PDF scaricati una sola volta e poi letti dalla cache del dispositivo (anche offline).
- **Flashcard con ripetizione spaziata** (algoritmo FSRS, quello delle versioni recenti di Anki) e formule LaTeX (KaTeX). Le carte sono file `flashcard/*.tsv` nel repository privato; quelle di una sessione si sbloccano quando la sessione è segnata come fatta in `PROGRESSI.md` (anche dal pulsante **Segna come fatta** nella libreria). Lo stato del ripasso è in `flashcard/progresso.json`, sincronizzato come le annotazioni.

**App:** <https://perruccio.github.io/Learn-app/>

## Come funziona

Questo repository (pubblico) contiene solo il codice. I PDF e le annotazioni stanno nel repository privato, e l'app li legge e li scrive tramite l'API di GitHub con un token personale salvato nel browser.

Per ogni libro `cartella/nome.pdf` le annotazioni stanno in `cartella/nome.annotazioni.json`. Il file è JSON leggibile: un'annotazione per blocco, con pagina, colore, testo evidenziato, nota e posizione (in frazioni della pagina, quindi indipendente dallo zoom).

Link diretto a un libro e a una pagina:

```
https://perruccio.github.io/Learn-app/#read=matematica/libri/axler-ladr-4ed.pdf&page=20
```

## Primo accesso (una volta per dispositivo)

1. Crea un *fine-grained token* su GitHub: **Settings → Developer settings → Fine-grained tokens → Generate new token**.
   - **Repository access:** *Only select repositories* → `Learn`.
   - **Permissions → Contents:** *Read and write*.
2. Apri l'app, incolla il token e premi **Connetti**.

Su iPhone e Android: dal browser usa **Condividi → Aggiungi alla schermata Home**. L'app si apre a schermo intero, come un'app normale.

## Sicurezza

Un PDF è un file non fidato, quindi il reader adotta queste difese:

- **Il codice dei PDF non viene mai eseguito.** PDF.js gira senza motore di scripting, con `isEvalSupported: false` (la classe di attacchi di CVE-2024-4367) e con i moduli XFA disattivati. La versione inclusa (4.10.38) non è tra quelle colpite da CVE-2026-16633 (5.6.83–6.2.107), che comunque richiede lo scripting attivo.
- **Content Security Policy rigida.** Possono girare solo gli script di questo sito, senza `unsafe-inline` né `unsafe-eval`, e l'unico server raggiungibile è `api.github.com`. Anche se un PDF o un file di annotazioni riuscisse a iniettare codice, il browser non lo eseguirebbe e non potrebbe inviare dati altrove.
- **Link esterni sempre confermati.** Un link nel PDF mostra l'indirizzo completo e si apre solo dopo conferma, in una nuova scheda con `noopener` e `noreferrer`. I link `javascript:` vengono scartati.
- **Flashcard sicure.** Il testo delle carte è inserito come testo: sono ammessi solo `<b>`, `<i>`, `<u>`, `<code>` e `<br>`, ricostruiti senza attributi. Le formule passano da KaTeX con `trust: false` (niente `\\href` o HTML). L'unica eccezione nella CSP è `style-src-attr 'unsafe-inline'`, necessaria a KaTeX per l'impaginazione delle formule: gli attributi di stile non possono eseguire codice.
- **Annotazioni validate.** I file `.annotazioni.json` vengono letti con una whitelist: campi sconosciuti scartati, colori e tipi controllati, coordinate solo numeriche, testi con lunghezza massima. Tutto il testo viene inserito come testo, mai come HTML.
- **Solo PDF veri.** Il caricamento controlla l'intestazione `%PDF-`, e un file che non è un PDF non viene aperto.
- **Nessuna dipendenza esterna.** Nessuna CDN e nessun servizio di terze parti: tutto il codice è in questo repository.
- **Token con accesso minimo.** Il token vale per un solo repository, con il solo permesso *Contents*, e resta nel browser del dispositivo.

## Sviluppo

Sito statico, senza build: HTML, CSS e moduli JavaScript in `js/`. Librerie incluse in `vendor/`: PDF.js 4.10.38 (build *legacy*, Apache-2.0), KaTeX 0.18.11 (MIT, caricato solo nel ripasso), ts-fsrs 5.4.2 (MIT).

```bash
python -m http.server 8000   # poi apri http://localhost:8000
```
