# ilias-lasttest

Ein [k6](https://k6.io/)-Lasttest für [ILIAS](https://www.ilias.de/)-Standardtests mit Random Question Set. Fährt den HTTP-Test-Player komplett durch (Login → Test-Start → Frage-Loop mit Autosaves → Beenden → Logout) und liefert pro Phase Latenz-Trends, Failure-Counter sowie Account-Hygiene-Metriken.

## Status

Frühe Phase. Das Skript läuft produktiv gegen eine konkrete ILIAS-9-Instanz an der FAU (StudOn). Generalisierung für andere Deployments ist auf der Roadmap. Beiträge willkommen.

## Was das Skript macht

Pro Virtual User wird eine vollständige Klausur-Session gefahren:

1. **Login** über das ILIAS-Standard-Login-Formular
2. **Test starten**: `goto.php` → `initTest` → `startTest` → erste `showQuestion`
3. **Frage-Loop**: jede gerenderte Frage wird geparst, ein typspezifischer Autosave-Body gebaut (1–2 Saves pro Frage mit realistischer Bearbeitungszeit) und per `nextQuestion` weiterzogen
4. **Beenden**: zweistufiger `finishTest` (Dialog + Bestätigung) → Ergebnis-Seite
5. **Logout** über `rtoken`

Unterstützte Fragetypen (echte Autosave-Bodies):

`single_choice`, `multiple_choice`, `kprim`, `numeric`, `formula`, `textsubset`, `ordering_h`, `ordering_v`, `long_menu`, `cloze`, `matching`, `errortext`.

Bewusst nicht unterstützt (nur Empty-Ping, keine Antwortdaten): `imagemap`, `fileupload`, `text_question`.

## Repo-Aufbau

```
.
├── loadtest.js              # k6-HTTP-Lasttest (Test-Player end-to-end)
├── browser-canary.js        # k6/browser-Canary (echter Chromium, UI-Validierung)
├── run-canary.sh            # Launcher für den Canary (headless/xvfb/visible)
├── config.example.js        # Vorlage für die Instanz-Konfiguration
├── inventory.json           # Frage-Inventar (Title → Type-Spec)
├── README.md
└── LICENSE                  # GPL-3.0
```

Modularisierung (`lib/`, `test/`, `fixtures/`) und ein QTI-XML-zu-Inventory-Konverter unter `scripts/` sind als Roadmap-Punkte geplant.

## Voraussetzungen

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 
- Eine ILIAS-9.x-Instanz mit konfiguriertem Standardtest (Random Question Set)
- Test-Accounts mit Berechtigung auf den Test
- Ein passendes Inventar-JSON für den zugrundeliegenden Fragenpool (siehe „Inventar-Format")

## Quickstart

```bash
# 1) Instanz konfigurieren
cp config.example.js config.js
$EDITOR config.js       # baseUrl, refId, clientId, password, accounts

# 2) Smoke-Lauf (1 VU, 1 Iteration, kurze Bearbeitungszeiten, Debug-Logs)
k6 run -e SMOKE=1 -e VUS=1 -e ITERATIONS=1 loadtest.js

# 3) Stufe 1 (Klausur-Andrang: 200 Studierende, jeder genau eine Session)
k6 run -e VUS=200 loadtest.js
```

> **Wichtig:** VUs immer über `-e VUS=…` setzen, **nicht** über `--vus`/`--duration`.
> Der Scenario-Block nutzt den `per-vu-iterations`-Executor (jeder VU fährt
> genau eine Klausur-Session — Modell „1 Student = 1 Session"). Setzt man
> `--vus`/`--duration` auf der CLI, verwirft k6 den Scenario-Block, die VUs
> loopen, fahren denselben Account mehrfach und produzieren falsche
> `dirty_accounts`-Treffer. Der `setup()`-Guard bricht außerdem ab, wenn
> `VUS` größer als der Account-Pool ist.

## Konfiguration

Schichten: Code-Defaults ← `config.js` ← ENV-Variable. ENV gewinnt (praktisch für CI, wenn Secrets nicht in einer Datei liegen sollen).

### Felder in `config.js`

| Feld                       | ENV                  | Bedeutung                                                       |
| -------------------------- | -------------------- | --------------------------------------------------------------- |
| `baseUrl`                  | `BASE_URL`           | ILIAS-Basis-URL inkl. Client-Subpfad (ohne abschließenden `/`)  |
| `refId`                    | `REF_ID`             | `ref_id` des Test-Objekts                                       |
| `clientId`                 | `CLIENT_ID`          | ILIAS-`client_id`                                               |
| `password`                 | `PASSWORD`           | Gemeinsames Passwort der Test-Accounts                          |
| `accounts.prefix`          | `ACCOUNT_PREFIX`     | Account-Namens-Präfix (Default `test`)                          |
| `accounts.padLength`       | `ACCOUNT_PAD_LENGTH` | Null-Padding-Breite des Index (Default `3` → `test011`)         |
| `accounts.offset`          | `ACCOUNT_OFFSET`     | Niedrigster Account-Index                                       |
| `accounts.range`           | `ACCOUNT_RANGE`      | Pool-Größe für die VU-Verteilung                                |
| `timing.thinkMin`/`Max`    | `THINK_MIN`/`MAX`    | Bearbeitungszeit pro Frage in Sekunden                          |
| `timing.autosaveMin`/`Max` | `AUTOSAVE_MIN`/`MAX` | Anzahl Autosaves pro Frage                                      |

### Nur über ENV (Laufzeit)

| Variable        | Default                  | Bedeutung                                                              |
| --------------- | ------------------------ | ---------------------------------------------------------------------- |
| `VUS`           | `1`                      | Gleichzeitige Studierende (`per-vu-iterations`-Executor). Muss ≤ Account-Pool sein. |
| `ITERATIONS`    | `1`                      | Sessions **pro VU** (Default 1 = „1 Student, 1 Klausur"). >1 nur bei Tests mit mehreren erlaubten Durchläufen. |
| `SMOKE`         | leer                     | `1` setzt Bearbeitungszeiten auf ~1 s und erzwingt `LOG_LEVEL=debug`   |
| `LOG_LEVEL`     | `info` (Smoke: `debug`)  | `error` / `warn` / `info` / `debug`                                    |
| `MAX_QUESTIONS` | `50`                     | Safety-Net für den Frage-Loop; Erreichen färbt den Run rot             |

## Account-Pool

VUs werden round-robin auf Accounts `<prefix><idx>` gemappt. Mit den Defaults (`prefix=test`, `padLength=3`, `offset=10`, `range=105`) ergeben sich `test011`–`test115` für VU 1–105. Reserviere einen separaten Bereich für Browser-Canaries (z.B. `test001`–`test010`).

**Pool muss ≥ VUS sein.** Im Modell „1 Student = 1 Session" fährt jeder VU genau eine Klausur mit einem eigenen Account. Ist `VUS` größer als `range`, würden sich zwei VUs denselben Account teilen und sich gegenseitig in den Test-Run treten — der `setup()`-Guard bricht den Lauf deshalb mit einer Fehlermeldung ab. Für 200 gleichzeitige Studierende also `range ≥ 200`.

Das Skript bricht den Run pro Account ab, sobald es einen offenen Test-Run erkennt — Marker: `Test fortsetzen` (DE) / `Resume Test` (EN), `cmd=resumePlayer`, `tst_already_passed`. Diese fließen in die `dirty_accounts`-Rate. Zwischen Lauf-Stufen Accounts manuell zurücksetzen.

## Browser-Canary

`browser-canary.js` ist die Ergänzung zum HTTP-Lasttest: statt rohe HTTP-Requests zu feuern, fährt es einen **echten Chromium-Browser** durch eine komplette Test-Session und klickt jede Frage typgerecht an (Single-/Multiple-Choice, Kprim, Numeric, Formula, Textsubset, Cloze, Long-Menu, Ordering H/V, **Matching per Drag-&-Drop**, Errortext). Zweck: validieren, dass die **UI unter HTTP-Last noch bedienbar** ist — JS-/Rendering-Fehler, die der reine HTTP-Pfad nie sieht.

```bash
# Sichtbarer Browser, 1 VU — zum Zuschauen
K6_BROWSER_HEADLESS=false k6 run -e VUS=1 browser-canary.js

# Headless, 2 Canary-VUs parallel zum HTTP-Lasttest
k6 run -e VUS=2 browser-canary.js
```

- **Chromium erforderlich** — k6/browser startet es selbst, es muss aber installiert sein.
- **Eigener Account-Bereich**: Der Canary nutzt `CANARY_OFFSET`/`CANARY_RANGE` (Default `test001`–`test010`), getrennt vom HTTP-Last-Pool aus `config.js` (`offset`/`range`). So teilen sich Browser- und HTTP-VUs nie denselben Account. Halte die beiden Bereiche überschneidungsfrei (Default: HTTP ab `test011`, Canary `test001`–`test010`).
- Eigene Metriken: `browser_login_duration`, `browser_test_start_duration`, `browser_question_duration`, `browser_finish_duration`, `browser_run_success`, `browser_questions_by_type`, `browser_question_errors`. Bei Handler-/Phasenfehlern wird ein Screenshot nach `/tmp/canary-*.png` geschrieben.
- ENV: `THINK_MIN`/`THINK_MAX` (Bearbeitungszeit, Default 3–6 s), `MAX_QUESTIONS`, `K6_BROWSER_HEADLESS`.

### Viele Sessions parallel — und Optimierung

Jede Chromium-Instanz kostet real **~300–700 MB RAM + CPU**, sichtbare Fenster zusätzlich Compositor-Overhead. „Viele gleichzeitige Browser" skaliert also nur begrenzt — und meist braucht man es nicht: **Headless-Chromium nutzt dieselbe Engine, führt dasselbe JS aus und rendert identisch.** Für die Validierung bekommst du headless die gleiche Aussagekraft; sichtbar ist nur zum Zuschauen.

Der Launcher `run-canary.sh` setzt die Flags, die viele parallele Instanzen erst praktikabel machen (allen voran `disable-dev-shm-usage` — ohne das crasht Chromium unter Last, wenn `/dev/shm` vollläuft) und bietet drei Modi:

```bash
./run-canary.sh 20               # 20 VUs, headless        → skaliert am besten
MODE=xvfb    ./run-canary.sh 20  # 20 VUs, headful im virtuellen Display (Server ohne Monitor)
MODE=visible ./run-canary.sh 2   # echte Fenster auf einem Desktop (nur wenige!)
```

- **Headless (1):** der skalierbare Default. Obergrenze grob `(freies RAM in GB) / 0.6` VUs — 16 GB frei ≈ 25 VUs. Hochtasten und dabei `free -h` / `htop` beobachten.
- **Xvfb (2):** echter *headful*-Renderpfad ohne Monitor, für Server. Braucht `xvfb-run` (`apt-get install -y xvfb`). Nützlich, falls die Instanz headless-Browser anders behandelt.
- **Visible (3):** echte Fenster — zwangsläufig auf eine Handvoll begrenzt, nur für lokales Debugging.

Eigene Flags via `K6_BROWSER_ARGS` überschreiben die Defaults des Launchers. **Architektur-Hinweis:** Für reine Server-Last brauchst du keine N Browser — fahr den HTTP-Lasttest auf hunderte VUs *und* ein paar (2–10) Canaries parallel als „echte Nutzer"-Sonden. Hunderte echte Browser sind ein eigenes Client-seitiges Last-Problem, keine Server-Validierung.

## Inventar-Format

`./inventory.json` wird beim Skript-Start einmalig geladen. Die Datei mappt Frage-Titel auf typspezifische Specs, mit denen sich gültige Autosave-Bodies bauen lassen ohne dass der Server-State der Antworten bekannt sein muss.

```json
{
  "_meta": { "ilias_version": "9.x", "total_questions": 360 },
  "questions": [
    {
      "title": "Single-Choice 1",
      "type": "single_choice",
      "spec": { "choices": [ { "ident": "12345" }, { "ident": "67890" } ] }
    },
    {
      "title": "Numerische Antwort 1",
      "type": "numeric",
      "spec": { "min": 0, "max": 10 }
    }
  ]
}
```

Ein QTI-XML-zu-Inventar-Konverter ist als geplante `scripts/`-Ergänzung auf der Roadmap. Bis dahin wird das Inventar extern aus dem QTI-Export des Fragenpools gebaut.

## Metriken & Thresholds

Eigene Metriken (zusätzlich zu den k6-Standards):

- `login_duration`, `test_start_duration`, `autosave_duration`, `next_question_duration`, `finish_duration` (Trends)
- `login_failures`, `test_start_failures`, `question_failures`, `finish_failures`, `max_questions_hit` (Counter)
- `dirty_accounts`, `run_success` (Rates)

Thresholds, die den Run rot färben:

- `http_req_failed` > 5 %
- p95-Latenz > 5 s für login / test_start / finish, > 3 s für show_question / next_question, > 1,5 s für autosave
- `dirty_accounts`-Rate > 1 %
- `max_questions_hit` > 0

Nach ein paar Baseline-Läufen gegen die eigene Instanz kalibrieren.

## Reporting & Grafana

Beide Skripte erzeugen am Lauf-Ende (`handleSummary`) neben der Terminal-Zusammenfassung zusätzlich:

- **`summary.html`** (HTTP-Test) bzw. **`summary-browser.html`** (Canary) — ein im Browser öffenbarer Report ([k6-reporter](https://github.com/benc-uk/k6-reporter), wird zur Laufzeit per Import geladen).
- **`summary.json`** / **`summary-browser.json`** — die vollständigen Metriken als JSON für maschinelle Auswertung oder Lauf-zu-Lauf-Vergleiche.

Beide Datei-Arten sind via `.gitignore` (`summary*.html` / `summary*.json`, zusätzlich greift `*.html`) vom Commit ausgeschlossen — sie können Last-/Instanz-Details enthalten.

Für **Time-Series-Historie und Grafana-Dashboards** schreibt k6 die Metriken live in eine TSDB, statt nur die Endsumme zu erzeugen:

```bash
# InfluxDB v1
k6 run --out influxdb=http://localhost:8086/k6 loadtest.js

# Prometheus (Remote Write) — experimentell, aber stabil im Einsatz
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  k6 run --out experimental-prometheus-rw loadtest.js
```

In Grafana dann das offizielle k6-Dashboard importieren (InfluxDB: ID **2587**, Prometheus: ID **19665**). Die Phasen-Tags (`phase:login`, `phase:autosave`, …) und beim Canary `browser_questions_by_type{qtype:…}` lassen sich dort direkt aufschlüsseln.

## Wie der Parser arbeitet

Primär läuft das HTML-Parsing über `k6/html` (Goquery-basiert). Wenn ein Selector ins Leere greift, fällt der Parser auf Regex zurück und loggt eine `[parser] … via Regex-Fallback`-Warnung. Tauchen solche Warnungen auf, hat sich das ILIAS-Markup verschoben und die Selektoren brauchen ein Update — die Warnungen sagen dir, wo.

Pro Frage wird extrahiert:

- `title` — aktuell der Lookup-Key ins Inventar 
- `formtimestamp` — Hidden-Input auf jeder echten Frage-Seite
- `matching_qid` — bei Matching-Fragen aus `[data-type="ilMatchingQuestion"][data-id]`
- `errortext_qid` + `n_words` — aus `input[name^=qst_]` und der Anzahl `[data-pos]`-Elemente
- `ordering_idents` — aus `input[name^="order_elems[content]"]`

## ToDo & bekannte Probleme

### Bekannte Probleme

- **Erste Frage wird übersprungen** bei Tests, deren Konfiguration eine Pflicht-Übersichtsseite („Übersicht Testdurchlauf") zwischen Test-Start und Frage 1 erzwingt (z.B. Random-Set-Tests mit Taxonomien). Das Skript erkennt die Übersichtsseite zwar (kein `formtimestamp`) und ruft `nextQuestion`, springt damit aber von der Übersicht direkt zu Frage 2 — Frage 1 fällt unter den Tisch. Lösungsskizze: auf der Übersichtsseite den „Test fortsetzen"/„Test starten"-Befehl (`cmd=resumePlayer` oder vergleichbar) extrahieren und gezielt diesen Endpoint aufrufen, bevor `nextQuestion` zum Zug kommt.
- **`errortext n_words` fällt auf Default `50`** zurück, wenn das Markup keine `data-pos`-Attribute liefert. Sollte stattdessen aus dem QTI-Pool ins Inventar übernommen werden.
- **Skip-Typen lösen `unknown qtype`-Warnings aus**: `imagemap`, `fileupload`, `text_question` sind im Inventar als `_skip:true` markiert und werden absichtlich nur per Empty-Ping bedient. Der Builder-Switch warnt trotzdem — sollte vor dem Switch abgefangen werden.

### ToDo

- Generischer Einsatz auf beliebigen ILIAS-Deployments (nur über Konfig, ohne Skript-Änderungen)
- QTI-XML-zu-Inventar-Konverter unter `scripts/`
- Modularer Aufbau (`lib/parsers.js`, `lib/builders.js`, …) 
- Reproduzierbare Zufälligkeit über `SEED`-ENV
- Browser-Canary-Skript als Ergänzung zum HTTP-Lasttest
- Inventar-Lookup auf stabile QTI-Ident statt freitextlichem Title

## Mitwirken

Pull Requests sind willkommen. Besonders gesucht:

- Support für weitere ILIAS-Versionen
- Echte Autosave-Bodies für die aktuell übersprungenen Typen (`imagemap`, `fileupload`, `text_question`)
- Stabilere Selektor-Anker für den Parser

## Lizenz

[GPL-3.0](LICENSE)
