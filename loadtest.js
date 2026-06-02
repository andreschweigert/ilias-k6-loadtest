/**
 * ilias-lasttest — k6 load test for ILIAS Standard Tests (Random Question Set)
 * =============================================================================
 *
 * Drives the HTTP test player end-to-end:
 *   login → goto → initTest → startTest → question loop → finishTest → logout
 *
 * Setup:
 *   1) cp config.example.js config.js
 *   2) edit config.js (baseUrl, refId, clientId, password, accounts)
 *   3) k6 run -e SMOKE=1 -e VUS=1 -e ITERATIONS=1 loadtest.js
 *
 * Stage 1 (Klausur-Andrang — 1 Student = 1 Session):
 *   k6 run -e VUS=200 loadtest.js
 *   → 200 VUs, jeder VU fährt GENAU EINE Session. Der Account-Pool muss
 *     ≥ VUS sein (sonst Abbruch im setup), damit kein VU einen Account
 *     wiederholt und fälschlich als "dirty" zählt.
 *   Hinweis: VUS über -e setzen, NICHT über --vus/--duration — letztere
 *   verwerfen den Scenario-Block und lassen die VUs loopen (→ dirty accounts).
 *
 * Logging:
 *   LOG_LEVEL=error|warn|info|debug (default: info; SMOKE forces debug).
 *
 * Other ENV variables:
 *   MAX_QUESTIONS   Loop safety net (default: 50). Hitting it fails the
 *                   max_questions_hit threshold and turns the run red.
 *   VUS             Anzahl gleichzeitiger Studierender (per-vu-iterations).
 *   ITERATIONS      Sessions PRO VU (default 1 = "1 Student, 1 Klausur").
 *                   >1 nur sinnvoll, wenn der Test mehrere Durchläufe erlaubt.
 *
 * Inventory:
 *   inventory.json must sit next to this script. It maps question titles to
 *   type-specific specs needed to build a valid autosave body without the
 *   server's answer data. Build it from your ILIAS pool's QTI export.
 *
 * Account hygiene:
 *   The script aborts a run if it detects a leftover open test on an account
 *   (markers: "Test fortsetzen" / "Resume Test" / cmd=resumePlayer /
 *   tst_already_passed). Metric: dirty_accounts. Reset accounts between
 *   stages — no auto-retry.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { parseHTML } from "k6/html";
import { Counter, Rate, Trend } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";
import config from "./config.js";

// ─── Inventory (init scope, loaded once) ────────────────────────────────────────
const INVENTORY = JSON.parse(open("./inventory.json"));
const INVENTORY_BY_TITLE = (() => {
  const map = {};
  for (const q of INVENTORY.questions) map[q.title] = q;
  return map;
})();

// ─── Configuration ──────────────────────────────────────────────────────────────
// Layered: code defaults ← config.js ← ENV. ENV wins (useful for CI secrets).

const BASE_URL   = __ENV.BASE_URL   || config.baseUrl;
const REF_ID     = __ENV.REF_ID     || String(config.refId);
const CLIENT_ID  = __ENV.CLIENT_ID  || config.clientId;
const PASSWORD   = __ENV.PASSWORD   || config.password;

if (!BASE_URL || !REF_ID || !CLIENT_ID || !PASSWORD) {
  throw new Error(
    "Missing required configuration. Set baseUrl/refId/clientId/password in config.js " +
    "or via ENV (BASE_URL, REF_ID, CLIENT_ID, PASSWORD)."
  );
}

const ACCOUNT_PREFIX     = __ENV.ACCOUNT_PREFIX     || config.accounts.prefix;
const ACCOUNT_PAD_LENGTH = parseInt(__ENV.ACCOUNT_PAD_LENGTH || config.accounts.padLength);
const ACCOUNT_OFFSET     = parseInt(__ENV.ACCOUNT_OFFSET     || config.accounts.offset);
const ACCOUNT_RANGE      = parseInt(__ENV.ACCOUNT_RANGE      || config.accounts.range);

const THINK_TIME_MIN = parseInt(__ENV.THINK_MIN    || config.timing.thinkMin);
const THINK_TIME_MAX = parseInt(__ENV.THINK_MAX    || config.timing.thinkMax);
const AUTOSAVES_MIN  = parseInt(__ENV.AUTOSAVE_MIN || config.timing.autosaveMin);
const AUTOSAVES_MAX  = parseInt(__ENV.AUTOSAVE_MAX || config.timing.autosaveMax);

// SMOKE shrinks think-times for fast end-to-end validation.
const SMOKE_MODE = __ENV.SMOKE === "1";

// ─── Logger ─────────────────────────────────────────────────────────────────────
// LOG_LEVEL=error|warn|info|debug (Default: info). Im SMOKE_MODE auf debug,
// damit Smoke-Läufe weiterhin alle Sequenz-Details zeigen.
const _LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const _LOG_LEVEL_NAME = (__ENV.LOG_LEVEL || (SMOKE_MODE ? "debug" : "info")).toLowerCase();
const _LOG_LEVEL = _LEVELS[_LOG_LEVEL_NAME] != null ? _LEVELS[_LOG_LEVEL_NAME] : _LEVELS.info;
const log = {
  error: (msg) => { if (_LOG_LEVEL >= _LEVELS.error) console.error(msg); },
  warn:  (msg) => { if (_LOG_LEVEL >= _LEVELS.warn)  console.warn(msg); },
  info:  (msg) => { if (_LOG_LEVEL >= _LEVELS.info)  console.log(msg); },
  debug: (msg) => { if (_LOG_LEVEL >= _LEVELS.debug) console.log(msg); },
};

// ─── Scenarios ──────────────────────────────────────────────────────────────────

const VUS_ENV = parseInt(__ENV.VUS || "1");
const ITER_ENV = parseInt(__ENV.ITERATIONS || "1");
const MAX_QUESTIONS = parseInt(__ENV.MAX_QUESTIONS || "50");

export const options = {
  scenarios: {
    exam_session: {
      // per-vu-iterations: jeder VU fährt `iterations` Sessions (default 1).
      // Modell "1 Student = 1 Session" → kein VU wiederholt einen Account,
      // also keine falschen dirty_accounts. iterations ist hier PRO VU
      // (nicht der Gesamt-Pool wie bei shared-iterations).
      executor: "per-vu-iterations",
      vus: VUS_ENV,
      iterations: ITER_ENV,
      maxDuration: "30m",
    },
  },
  thresholds: {
    http_req_failed:                              ["rate<0.05"],
    "http_req_duration{phase:login}":             ["p(95)<5000"],
    "http_req_duration{phase:test_start}":        ["p(95)<5000"],
    "http_req_duration{phase:show_question}":     ["p(95)<3000"],
    "http_req_duration{phase:autosave}":          ["p(95)<1500"],
    "http_req_duration{phase:next_question}":     ["p(95)<3000"],
    "http_req_duration{phase:finish}":            ["p(95)<5000"],
    login_duration:                               ["p(95)<5000"],
    test_start_duration:                          ["p(95)<5000"],
    // dirty Accounts sind ein Setup-Problem (Vorlauf nicht sauber beendet),
    // kein Last-Ergebnis — eine handvoll Prozent ist schon "rot".
    dirty_accounts:                               ["rate<0.01"],
    // Wenn der Loop MAX_QUESTIONS erreicht, ist entweder die Sequenz-Erkennung
    // kaputt oder MAX zu klein — beides muss laut auffallen, nicht im warn-Rauschen.
    max_questions_hit:                            ["count===0"],
  },
};

// ─── Custom Metrics ─────────────────────────────────────────────────────────────

const loginDuration      = new Trend("login_duration", true);
const testStartDuration  = new Trend("test_start_duration", true);
// Hinweis: show_question_duration als eigene Trend war irreführend, weil sie
// auch Client-Sleeps zwischen Auto-Saves mitmaß. Die reinen HTTP-Zeiten
// stecken in http_req_duration{phase:show_question}.
const autosaveDuration   = new Trend("autosave_duration", true);
const nextQuestionDuration = new Trend("next_question_duration", true);
const finishDuration     = new Trend("finish_duration", true);

const loginFailures      = new Counter("login_failures");
const testStartFailures  = new Counter("test_start_failures");
const questionFailures   = new Counter("question_failures");
const finishFailures     = new Counter("finish_failures");
const maxQuestionsHit    = new Counter("max_questions_hit");

const dirtyAccounts      = new Rate("dirty_accounts");
const runSuccess         = new Rate("run_success");

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getUsername() {
  // VU IDs are 1-based; map round-robin onto the account pool.
  // Defaults (offset=10, range=105, prefix="test", padLength=3) produce
  // VU1..VU105 → test011..test115.
  const idx = ((__VU - 1) % ACCOUNT_RANGE) + 1 + ACCOUNT_OFFSET;
  return ACCOUNT_PREFIX + String(idx).padStart(ACCOUNT_PAD_LENGTH, "0");
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function thinkTime() {
  if (SMOKE_MODE) return 1;
  return randInt(THINK_TIME_MIN, THINK_TIME_MAX);
}

/**
 * Extract the first regex capture group from a string, or null.
 * Shallow helper around String.match — just to centralize error handling.
 */
function extractFirst(body, pattern) {
  if (!body) return null;
  const m = body.match(pattern);
  return m ? m[1] : null;
}

/**
 * Decode HTML-encoded ampersands in URLs extracted from href/action attributes.
 * ILIAS gerne &amp; — muss für HTTP-Requests zu & werden.
 */
function htmlDecodeUrl(url) {
  if (!url) return url;
  return url.replace(/&amp;/g, "&");
}

/**
 * Parse Location header from a redirect response.
 * Resolves relative paths against BASE_URL if necessary.
 */
function getLocation(resp) {
  const loc = resp.headers["Location"] || resp.headers["location"];
  if (!loc) return null;
  if (loc.startsWith("http://") || loc.startsWith("https://")) return loc;
  if (loc.startsWith("/")) {
    // BASE_URL = https://host/dev1 — Location = /dev1/ilias.php?...
    const u = new URL(BASE_URL);
    return `${u.protocol}//${u.host}${loc}`;
  }
  // Relative zum BASE_URL
  return `${BASE_URL}/${loc}`;
}

/**
 * Detect whether the account has a "dirty" open test run.
 * Markers:
 *   - localized "resume test" button text (DE/EN — extend for other locales)
 *   - cmd=resumePlayer link (locale-independent)
 *   - tst_already_passed marker (locale-independent)
 */
const DIRTY_TEXT_MARKERS = [
  "Test fortsetzen", // de
  "Resume Test",     // en
];
const DIRTY_CODE_MARKERS = [
  "cmd=resumePlayer",
  "tst_already_passed",
];
function isAccountDirty(html) {
  if (!html) return false;
  for (const m of DIRTY_TEXT_MARKERS) if (html.indexOf(m) !== -1) return true;
  for (const m of DIRTY_CODE_MARKERS) if (html.indexOf(m) !== -1) return true;
  return false;
}

// ─── Phase 1: Login ─────────────────────────────────────────────────────────────

function doLogin(username) {
  const phaseStart = Date.now();

  // 1a. Login-Seite laden — setzt PHPSESSID-Cookie.
  const loginPage = http.get(`${BASE_URL}/login.php?cmd=force_login&lang=de`, {
    tags: { phase: "login", step: "page" },
  });
  if (loginPage.status !== 200) {
    log.error(`[${username}] Login-Seite nicht erreichbar: ${loginPage.status}`);
    loginFailures.add(1);
    return false;
  }

  // 1b. Credentials posten. Field-Namen aus LEA übernommen (identisches ILIAS-Login).
  const payload = {
    "login_form/input_3/input_4": username,
    "login_form/input_3/input_5": PASSWORD,
  };
  const loginResp = http.post(
    `${BASE_URL}/ilias.php?baseClass=ilstartupgui&cmd=post&fallbackCmd=doStandardAuthentication&lang=de`,
    payload,
    {
      tags: { phase: "login", step: "submit" },
      redirects: 5,
    }
  );

  loginDuration.add(Date.now() - phaseStart);

  const ok = check(loginResp, {
    "login → 200": (r) => r.status === 200,
    "login → Dashboard/Startseite": (r) =>
      r.url.toLowerCase().includes("dashboard") ||
      r.url.toLowerCase().includes("ilpersonaldesktopgui") ||
      // Nach erfolgreichem Login landet man nicht mehr auf login.php
      !r.url.includes("login.php"),
  });

  if (!ok) {
    log.error(`[${username}] Login fehlgeschlagen: status=${loginResp.status} url=${loginResp.url}`);
    loginFailures.add(1);
    return false;
  }

  return true;
}

// ─── Phase 2: Test starten ──────────────────────────────────────────────────────

/**
 * initTest → startTest → showQuestion(sequence=1)
 *
 * Gibt { activeId, cmdNode, firstSequence, firstHtml } zurück oder null bei Fehler.
 */
function startTest(username) {
  const phaseStart = Date.now();

  // 2a. initTest (GET) — 302 Redirect erwartet.
  //     Das initTest-URL-Pattern: Wir kennen cmdNode noch nicht → benutzen das
  //     Parent-Pattern mit baseClass=ilrepositorygui und cmdClass=ilobjtestgui
  //     oder direkt über ref_id. In der HAR kam initTest mit bereits gesetztem
  //     cmdNode — aber der erste Aufruf funktioniert auch ohne, weil ILIAS
  //     den Kontext über ref_id auflöst.
  //
  //     Wir navigieren zuerst zum Test-Objekt (ref_id=19248), holen uns das
  //     cmdNode aus dem HTML, und rufen dann initTest mit korrektem cmdNode.
  const initPageResp = http.get(
    `${BASE_URL}/goto.php?target=tst_${REF_ID}&client_id=${CLIENT_ID}`,
    {
      tags: { phase: "test_start", step: "goto" },
      redirects: 5,
    }
  );

  if (initPageResp.status !== 200) {
    log.error(`[${username}] Test-Objekt nicht erreichbar: ${initPageResp.status}`);
    testStartFailures.add(1);
    return null;
  }

  // Dirty-Check: hat der Account einen offenen Run?
  if (isAccountDirty(initPageResp.body)) {
    log.warn(`[${username}] Account ist DIRTY (offener Test-Run) — Abbruch`);
    dirtyAccounts.add(true);
    testStartFailures.add(1);
    return null;
  }
  dirtyAccounts.add(false);

  // cmdNode aus dem HTML extrahieren.
  const cmdNode = extractFirst(initPageResp.body, /cmdNode=([A-Za-z0-9:]+)/);
  if (!cmdNode) {
    log.error(`[${username}] cmdNode nicht gefunden auf Test-Objekt-Seite`);
    testStartFailures.add(1);
    return null;
  }
  log.debug(`[${username}] cmdNode=${cmdNode}`);

  // 2b. initTest aufrufen. Wir folgen Redirects NICHT manuell, weil ILIAS hier
  //     eine Kette initTest → startTest → showQuestion macht. Per redirects:5
  //     lassen wir k6 das durchwinken und prüfen die Ziel-URL.
  const initTestUrl =
    `${BASE_URL}/ilias.php?baseClass=ilrepositorygui` +
    `&cmdNode=${cmdNode}` +
    `&cmdClass=ilTestPlayerRandomQuestionSetGUI` +
    `&cmd=initTest&ref_id=${REF_ID}`;

  const initTestResp = http.get(initTestUrl, {
    tags: { phase: "test_start", step: "init" },
    redirects: 0, // Wir wollen die Location-Header manuell sehen.
  });

  if (initTestResp.status !== 302) {
    log.error(`[${username}] initTest: erwartet 302, got ${initTestResp.status}`);
    testStartFailures.add(1);
    return null;
  }

  const startTestUrl = getLocation(initTestResp);
  if (!startTestUrl) {
    log.error(`[${username}] initTest: kein Location-Header`);
    testStartFailures.add(1);
    return null;
  }

  // 2c. startTest — 302 Redirect auf showQuestion mit active_id in URL.
  const startTestResp = http.get(startTestUrl, {
    tags: { phase: "test_start", step: "start" },
    redirects: 0,
  });

  if (startTestResp.status !== 302) {
    log.error(`[${username}] startTest: erwartet 302, got ${startTestResp.status}`);
    testStartFailures.add(1);
    return null;
  }

  const firstShowUrl = getLocation(startTestResp);
  if (!firstShowUrl) {
    log.error(`[${username}] startTest: kein Location-Header`);
    testStartFailures.add(1);
    return null;
  }

  // active_id und sequence aus der Location-URL.
  const activeId = extractFirst(firstShowUrl, /active_id=(\d+)/);
  const firstSequence = extractFirst(firstShowUrl, /sequence=(\d+)/);

  if (!activeId || !firstSequence) {
    log.error(`[${username}] startTest: active_id/sequence nicht in Location: ${firstShowUrl}`);
    testStartFailures.add(1);
    return null;
  }

  log.debug(`[${username}] active_id=${activeId}, starting sequence=${firstSequence}`);

  // 2d. Erste showQuestion-Seite laden (die brauchen wir später eh für Iteration 2).
  const firstShowResp = http.get(firstShowUrl, {
    tags: { phase: "test_start", step: "show_first" },
  });

  if (firstShowResp.status !== 200) {
    log.error(`[${username}] erste showQuestion: status=${firstShowResp.status}`);
    testStartFailures.add(1);
    return null;
  }

  testStartDuration.add(Date.now() - phaseStart);

  return {
    activeId: activeId,
    cmdNode: cmdNode,
    firstSequence: parseInt(firstSequence),
    firstHtml: firstShowResp.body,
    firstUrl: firstShowUrl,
  };
}

// ─── Phase 3: Frage-Loop ────────────────────────────────────────────────────────

// Alle 14 Typen werden in Iteration 3 abgedeckt.
const SUPPORTED_TYPES = new Set([
  "single_choice", "multiple_choice", "kprim", "numeric",
  "formula", "textsubset", "ordering_h", "long_menu", "cloze",
  "ordering_v", "matching", "errortext"
]);

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sampleN(arr, n) {
  return shuffleArray(arr).slice(0, Math.min(n, arr.length));
}

// Alphanumerischer Zufalls-String für cloze-text-gaps.
function randomString(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  const actualLen = Math.max(1, Math.min(len, 10));
  for (let i = 0; i < actualLen; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

/**
 * Body-Generator pro Fragetyp. Liefert einen URL-encoded Body-String
 * (application/x-www-form-urlencoded).
 *
 * Alle Schemata basieren auf der HAR-Analyse (siehe Handover).
 * Bei unsupported types geben wir NUR formtimestamp zurück — der Server
 * antwortet mit 200, aber speichert keine Lösung.
 */
function buildAutoSaveBody(qtype, spec, formtimestamp, runtime) {
  const parts = [`formtimestamp=${formtimestamp}`];

  switch (qtype) {
    case "single_choice": {
      const pick = randomPick(spec.choices);
      parts.push(`multiple_choice_result=${encodeURIComponent(pick.ident)}`);
      break;
    }

    case "multiple_choice": {
      const min = spec.minnumber != null ? spec.minnumber : 1;
      const max = spec.maxnumber != null ? spec.maxnumber : spec.choices.length;
      const n = Math.max(1, min) + Math.floor(Math.random() * (max - Math.max(1, min) + 1));
      const picks = sampleN(spec.choices, n);
      for (const c of picks) {
        const enc = encodeURIComponent(c.ident);
        parts.push(`multiple_choice_result_${enc}=${enc}`);
      }
      break;
    }

    case "kprim": {
      // 4 Statements, jedes 0 oder 1.
      for (let i = 0; i < 4; i++) {
        parts.push(`kprim_choice_result_${i}=${Math.random() < 0.5 ? 0 : 1}`);
      }
      break;
    }

    case "numeric": {
      // spec.min/max können gleich sein (z.B. 4..4).
      const lo = spec.min != null ? spec.min : 0;
      const hi = spec.max != null ? spec.max : lo;
      const val = lo + Math.random() * (hi - lo);
      parts.push(`numeric_result=${val.toFixed(0)}`);
      break;
    }

    case "formula": {
      // result_$r1 — der $ muss URL-encoded werden.
      // Für Lasttest: einen Wert im r1-Bereich nehmen (wir wissen v1 ja nicht
      // runtime, aber ILIAS validiert die Formel erst beim Scoring).
      const lo = spec.r1.rangemin;
      const hi = spec.r1.rangemax;
      const val = Math.floor(lo + Math.random() * (hi - lo));
      parts.push(`${encodeURIComponent("result_$r1")}=${val}`);
      break;
    }

    case "textsubset": {
      for (let i = 0; i < spec.inputs; i++) {
        const val = randomPick(spec.accepted_pool);
        parts.push(`TEXTSUBSET_${i}=${encodeURIComponent(val)}`);
      }
      break;
    }

    case "ordering_h": {
      // Tokens mit {::} joinen (nicht spec.separator direkt!).
      const shuffled = shuffleArray(spec.tokens);
      const joined = shuffled.join("{::}");
      parts.push(`orderresult=${encodeURIComponent(joined)}`);
      break;
    }

    case "long_menu": {
      spec.dropdowns.forEach((dd, i) => {
        const val = randomPick(dd.options);
        parts.push(`${encodeURIComponent(`answer[${i}]`)}=${encodeURIComponent(val)}`);
      });
      break;
    }

    case "cloze": {
      spec.gaps.forEach((g, i) => {
        let val;
        if (g.kind === "select") {
          val = randomPick(g.options).ident;
        } else if (g.kind === "numeric") {
          const lo = g.minnumber || 0;
          const hi = g.maxnumber || lo;
          val = Math.floor(lo + Math.random() * (hi - lo + 1));
        } else {
          // text
          val = randomString(g.columns || 4);
        }
        parts.push(`gap_${i}=${encodeURIComponent(val)}`);
      });
      break;
    }

    case "ordering_v": {
      // Runtime-Idents aus dem HTML. Wenn keine gefunden → Empty (Fallback).
      const idents = runtime && runtime.ordering_idents ? runtime.ordering_idents : [];
      if (idents.length === 0) {
        log.warn("[ordering_v] keine Runtime-Idents im HTML gefunden");
        break;
      }
      // Reihenfolge zufällig: wir shuffeln die Reihenfolge der key-value-pairs
      // im Body (die Body-Reihenfolge = User-Anordnung).
      const shuffled = shuffleArray(idents);
      for (const el of shuffled) {
        const keyContent = encodeURIComponent(`order_elems[content][${el.ident}]`);
        const keyIndent  = encodeURIComponent(`order_elems[indentation][${el.ident}]`);
        parts.push(`${keyContent}=${encodeURIComponent(el.text)}`);
        parts.push(`${keyIndent}=0`);
      }
      break;
    }

    case "matching": {
      const qid = runtime && runtime.matching_qid;
      if (!qid) {
        log.warn("[matching] keine Runtime-qid im HTML gefunden");
        break;
      }
      // Pro Term aus spec.terms: ein (1:1) oder mehrere (n:n) items zuordnen.
      for (const term of spec.terms) {
        const itemsToAssign = spec.mode === "1:1"
          ? [randomPick(spec.items)]
          : sampleN(spec.items, randInt(1, Math.min(3, spec.items.length)));
        for (const item of itemsToAssign) {
          const key = encodeURIComponent(`matching[${qid}][${term.ident}][${item.ident}]`);
          parts.push(`${key}=${item.ident}`);
        }
      }
      break;
    }

    case "errortext": {
      const qid = runtime && runtime.errortext_qid;
      const nWords = runtime && runtime.errortext_n_words;
      if (!qid || !nWords) {
        log.warn("[errortext] qid oder word-count im HTML nicht gefunden");
        break;
      }
      // 3-8 zufällige Positionen aus [0, nWords-1] auswählen (als "markierte
      // Fehler").
      const count = randInt(3, 8);
      const positions = new Set();
      while (positions.size < count && positions.size < nWords) {
        positions.add(Math.floor(Math.random() * nWords));
      }
      const sorted = [...positions].sort((a, b) => a - b);
      const key = `qst_${qid}`;
      parts.push(`${key}=${sorted.join(",")}`);
      break;
    }

    default:
      log.warn(`[buildAutoSaveBody] unknown qtype: ${qtype}`);
  }

  return parts.join("&");
}

/**
 * Parse one showQuestion HTML response.
 *
 * Strategie: k6/html (Goquery-basiert) als primärer Pfad — DOM-Selektoren
 * statt Regex auf Markup. Wenn ein Selector nichts findet, fallen wir auf
 * Regex zurück und loggen eine Warnung mit Hinweis auf den fehlgeschlagenen
 * Selector. So sehen wir bei Smoke-Läufen, ob ILIAS-Markup-Änderungen die
 * Selectors brechen, statt still kaputte Daten zu produzieren.
 *
 * Extrahiert:
 *   - title (→ Inventar-Lookup)
 *   - formtimestamp
 *   - typspezifische Runtime-IDs:
 *     * matching_qid (für matching)
 *     * errortext_qid + errortext_n_words (für errortext)
 *     * ordering_idents (für ordering_v, Array von {ident, text})
 */
function parseShowQuestion(html) {
  const doc = parseHTML(html);

  // ── title ──
  // Primär: erstes <h1> innerhalb des Frage-Containers; Fallback: erstes <h1>
  // im gesamten Dokument; Last-Resort: Regex.
  let title = doc.find("h1").first().text();
  if (title) title = title.trim();
  if (!title) {
    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (titleMatch) {
      title = titleMatch[1].trim();
      log.warn("[parser] title via Regex-Fallback (h1-Selector leer)");
    }
  }

  // ── formtimestamp ──
  let formtimestamp = doc.find('input[name="formtimestamp"]').attr("value") || null;
  if (!formtimestamp) {
    const tsMatch = html.match(/formtimestamp[^>]*value="(\d+)"/);
    if (tsMatch) {
      formtimestamp = tsMatch[1];
      log.warn("[parser] formtimestamp via Regex-Fallback");
    }
  }

  // ── matching_qid ──
  // ILIAS rendert <div id="ilMatchingQuestionContainer_<qid>" data-type="ilMatchingQuestion" data-id="<qid>">.
  // Vorzugsweise data-id (semantisch); dann ID-Prefix; dann Hidden-Input;
  // dann Regex über alle Encodings.
  let matching_qid = null;
  const matchContainer = doc.find('[data-type="ilMatchingQuestion"]').first();
  if (matchContainer.size() > 0) {
    matching_qid = matchContainer.attr("data-id") || null;
    if (!matching_qid) {
      const idAttr = matchContainer.attr("id") || "";
      const m = idAttr.match(/ilMatchingQuestionContainer_(\d+)/);
      if (m) matching_qid = m[1];
    }
  }
  if (!matching_qid) {
    const containerM = html.match(/ilMatchingQuestionContainer_(\d+)/);
    if (containerM) {
      matching_qid = containerM[1];
      log.warn("[parser] matching_qid via Regex-Fallback (data-type-Selector leer)");
    } else {
      const hiddenM = html.match(/matching\[(\d+)\]\[/) ||
                      html.match(/matching%5B(\d+)%5D%5B/);
      if (hiddenM) matching_qid = hiddenM[1];
    }
  }

  // ── errortext_qid + n_words ──
  // qst_<qid> kommt als Hidden-Input. Wortanzahl = max(data-pos)+1 über alle
  // Errortext-Wort-Spans/Anchors.
  let errortext_qid = null;
  const qstInput = doc.find('input[name^="qst_"]').first();
  if (qstInput.size() > 0) {
    const nm = qstInput.attr("name") || "";
    const m = nm.match(/^qst_(\d+)$/);
    if (m) errortext_qid = m[1];
  }
  if (!errortext_qid) {
    const errtxtQidM = html.match(/name="qst_(\d+)"/);
    if (errtxtQidM) {
      errortext_qid = errtxtQidM[1];
      log.warn("[parser] errortext_qid via Regex-Fallback");
    }
  }

  let errortext_n_words = 0;
  // k6/html: each() liefert nackte Element-Objekte ohne .attr() — daher
  // toArray() (gibt Selection-Wrapper zurück, die .attr() haben).
  for (const sel of doc.find("[data-pos]").toArray()) {
    const p = parseInt(sel.attr("data-pos"));
    if (!isNaN(p) && p + 1 > errortext_n_words) errortext_n_words = p + 1;
  }
  if (errortext_qid && errortext_n_words === 0) {
    // Fallback: Regex (falls k6/html data-pos nicht zurückgibt)
    const posMatches = html.matchAll(/data-pos="(\d+)"/g);
    for (const pm of posMatches) {
      const p = parseInt(pm[1]);
      if (p + 1 > errortext_n_words) errortext_n_words = p + 1;
    }
    if (errortext_n_words > 0) {
      log.warn("[parser] errortext n_words via Regex-Fallback");
    } else {
      // Konservativer Default — siehe QTI 129 Wörter Basis-Variante.
      errortext_n_words = 50;
      log.warn("[parser] errortext n_words=0 → Default 50");
    }
  }

  // ── ordering_v idents ──
  // Hidden-Inputs name="order_elems[content][<ident>]" value="<text>".
  // k6/html liefert das Attribut wörtlich (ohne URL-Decoding), Regex-Fallback
  // deckt URL-encodete Varianten ab.
  const ordering_idents = [];
  for (const sel of doc.find('input[name^="order_elems[content]"]').toArray()) {
    const nm = sel.attr("name") || "";
    const val = sel.attr("value") || "";
    const m = nm.match(/order_elems\[content\]\[(\d+)\]/);
    if (m) ordering_idents.push({ ident: m[1], text: val });
  }
  if (ordering_idents.length === 0) {
    const orderIdentRe = /name="order_elems\[content\]\[(\d+)\]"[^>]*value="([^"]*)"/g;
    for (const m of html.matchAll(orderIdentRe)) {
      ordering_idents.push({ ident: m[1], text: m[2] });
    }
    if (ordering_idents.length > 0) {
      log.warn("[parser] ordering_idents via Regex-Fallback");
    } else {
      // URL-encodete Variante (ILIAS encoded manchmal die [])
      const orderIdentReEnc = /order_elems%5Bcontent%5D%5B(\d+)%5D[^=]*=([^&"]+)/g;
      for (const m of html.matchAll(orderIdentReEnc)) {
        ordering_idents.push({ ident: m[1], text: decodeURIComponent(m[2]) });
      }
    }
  }

  return {
    title,
    formtimestamp,
    matching_qid,
    errortext_qid,
    errortext_n_words,
    ordering_idents,
  };
}

/**
 * Gibt true zurück wenn die Frage korrekt verarbeitet werden konnte,
 * false bei Fatal (z.B. unknown title).
 * Das Skript läuft auch bei unknown title weiter — überspringt dann halt
 * die Auto-Saves und ruft direkt nextQuestion.
 */
function playOneQuestion(username, cmdNode, activeId, sequence, html) {
  const parsed = parseShowQuestion(html);

  // Übersichts-/Zwischenseiten ("Übersicht Testdurchlauf") haben kein
  // Frage-Form und damit auch keinen formtimestamp. Echte Fragen haben den
  // immer. Das ist deutlich robuster als ein h2-Text-Match (Sidebars/Drawer
  // einer Frage-Seite können den Übersichts-Header mit-rendern).
  if (!parsed.formtimestamp) {
    log.debug(`[${username}] seq=${sequence}: keine Frage-Form (Übersicht/Zwischenseite) — weiter zu nextQuestion`);
    // Diagnose: alle relevanten Action-URLs der Übersicht loggen, damit wir
    // den richtigen "weiter zur Frage"-Klick einbauen können.
    const dDoc = parseHTML(html);
    const cmds = new Set();
    for (const a of dDoc.find("a[href*=cmd=]").toArray().slice(0, 25)) {
      const href = (a.attr("href") || "").replace(/&amp;/g, "&");
      const m = href.match(/cmd=([A-Za-z0-9_]+)/);
      if (m) cmds.add(`a:${m[1]} (txt="${(a.text() || "").trim().slice(0, 40)}")`);
    }
    for (const f of dDoc.find("form[action*=cmd=]").toArray().slice(0, 10)) {
      const act = (f.attr("action") || "").replace(/&amp;/g, "&");
      const m = act.match(/cmd=([A-Za-z0-9_]+)/);
      if (m) cmds.add(`form:${m[1]}`);
    }
    log.debug(`[${username}] seq=${sequence} overview commands: ${[...cmds].join(" | ")}`);
    return { ok: true, qtype: "overview" };
  }

  if (!parsed.title) {
    log.warn(`[${username}] seq=${sequence}: Titel nicht extrahiert`);
    // Diagnose: alle h1/h2/h3 loggen, damit wir den richtigen Selector finden.
    const doc = parseHTML(html);
    const dump = (sel) => doc.find(sel).toArray().slice(0, 5)
      .map(s => `${sel}="${(s.text() || "").trim().slice(0, 80)}"`).join(" | ");
    log.debug(`[${username}] seq=${sequence} headings: ${dump("h1")} || ${dump("h2")} || ${dump("h3")}`);
    log.debug(`[${username}] seq=${sequence} body-snippet: ${html.slice(0, 1500).replace(/\s+/g, " ")}`);
    questionFailures.add(1);
    return { ok: false, html };
  }

  const q = INVENTORY_BY_TITLE[parsed.title];
  if (!q) {
    log.warn(`[${username}] seq=${sequence}: Titel "${parsed.title}" nicht im Inventar`);
    questionFailures.add(1);
    return { ok: false, html };
  }

  if (!parsed.formtimestamp) {
    log.warn(`[${username}] seq=${sequence} (${q.type}): formtimestamp fehlt`);
    questionFailures.add(1);
    return { ok: false, html };
  }

  // Auto-Save(s) senden — nur wenn Typ unterstützt.
  const numAutosaves = SUPPORTED_TYPES.has(q.type)
    ? randInt(AUTOSAVES_MIN, AUTOSAVES_MAX)
    : 1; // unsupported: ein Empty-Ping reicht

  // CSRF-Hinweis: ILIAS 9.x verlangt aktuell kein Form-/CSRF-Token auf
  // autosave und nextQuestion (rtoken nur am Logout). Falls eine spätere
  // ILIAS-Version das ändert, äußert sich das hier in 403/redirect-back-to-login
  // — dann muss aus parseShowQuestion ein rtoken/csrf_token mitgegeben werden.
  const autosaveUrl =
    `${BASE_URL}/ilias.php?baseClass=ilrepositorygui` +
    `&cmdNode=${cmdNode}` +
    `&cmdClass=ilTestPlayerRandomQuestionSetGUI` +
    `&cmd=autosave&ref_id=${REF_ID}` +
    `&sequence=${sequence}&active_id=${activeId}&pmode=edit`;

  for (let i = 0; i < numAutosaves; i++) {
    const body = buildAutoSaveBody(q.type, q.spec, parsed.formtimestamp, parsed);
    const autosaveResp = http.post(autosaveUrl, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      tags: { phase: "autosave", qtype: q.type },
    });
    autosaveDuration.add(autosaveResp.timings.duration);
    if (autosaveResp.status !== 200) {
      log.warn(`[${username}] autosave seq=${sequence} ${q.type}: ${autosaveResp.status}`);
    }
    if (SMOKE_MODE) {
      sleep(0.5);
    } else if (numAutosaves > 1 && i < numAutosaves - 1) {
      // In Echt-Setup: Autosaves alle ~30s. Wir halbieren die Thinktime und
      // verteilen sie zwischen den Saves.
      sleep(randInt(10, 20));
    }
  }

  return { ok: true, qtype: q.type };
}

/**
 * Der Haupt-Loop: showQuestion → autosave(s) → nextQuestion.
 * Läuft bis kein nextQuestion-Redirect mehr kommt (letzte Frage erreicht)
 * oder bis MAX_QUESTIONS (Safety-Net).
 */
function runQuestionLoop(username, session) {
  let sequence = session.firstSequence;
  let html = session.firstHtml;
  let questionsSeen = 0;
  const seenSequences = new Set();

  while (questionsSeen < MAX_QUESTIONS) {
    questionsSeen++;

    // Wiederholung erkennen BEVOR wir nochmal Auto-Saves dafür feuern.
    if (seenSequences.has(sequence)) {
      log.info(`[${username}] seq=${sequence} bereits gesehen — Test-Zyklus komplett, abbrechen`);
      break;
    }
    seenSequences.add(sequence);

    // 3a. Frage bearbeiten (autosave N× mit typspezifischem Body).
    // Hinweis: playOneQuestion macht intern ggf. sleep(10-20s) zwischen
    // Auto-Saves — die Trend "show_question_duration" wäre irreführend, weil
    // sie Client-Sleeps mitmessen würde. Die echte HTTP-Zeit der
    // showQuestion-GETs steckt in http_req_duration{phase:show_question}.
    const result = playOneQuestion(username, session.cmdNode, session.activeId, sequence, html);

    log.debug(`[${username}] seq=${sequence}: ${result.qtype || "?"} ${result.ok ? "✓" : "skip"}`);

    // 3b. Thinktime vor nextQuestion.
    sleep(thinkTime());

    // 3c. nextQuestion (GET, 302 erwartet).
    const nextUrl =
      `${BASE_URL}/ilias.php?baseClass=ilrepositorygui` +
      `&cmdNode=${session.cmdNode}` +
      `&cmdClass=ilTestPlayerRandomQuestionSetGUI` +
      `&cmd=nextQuestion&ref_id=${REF_ID}` +
      `&sequence=${sequence}&active_id=${session.activeId}&pmode=edit`;

    const nextResp = http.get(nextUrl, {
      tags: { phase: "next_question" },
      redirects: 0,
    });
    nextQuestionDuration.add(nextResp.timings.duration);

    if (nextResp.status === 302) {
      const newLoc = getLocation(nextResp);
      const newSeqStr = extractFirst(newLoc, /sequence=(\d+)/);
      if (!newSeqStr) {
        log.warn(`[${username}] nextQuestion Location ohne sequence: ${newLoc}`);
        break;
      }
      const newSeq = parseInt(newSeqStr);

      // Check VOR dem show-Request ob wir diese Frage schon gesehen haben.
      // Wenn ja: wir holen trotzdem die Seite für Logout-rtoken und brechen ab.
      if (seenSequences.has(newSeq)) {
        log.info(`[${username}] nextQuestion → seq=${newSeq} (bereits gesehen) — Zyklus komplett`);
        const wrapResp = http.get(newLoc, { tags: { phase: "show_question", step: "wrap" } });
        return { finalHtml: wrapResp.body, questionsSeen, lastSequence: sequence };
      }

      const nextShowResp = http.get(newLoc, {
        tags: { phase: "show_question", step: "followup" },
      });
      if (nextShowResp.status !== 200) {
        log.error(`[${username}] nextShow seq=${newSeq}: ${nextShowResp.status}`);
        questionFailures.add(1);
        return { finalHtml: html, questionsSeen, lastSequence: sequence };
      }
      sequence = newSeq;
      html = nextShowResp.body;
    } else if (nextResp.status === 200) {
      log.info(`[${username}] nextQuestion lieferte 200 (statt 302) — Test wohl zu Ende`);
      return { finalHtml: nextResp.body, questionsSeen, lastSequence: sequence };
    } else {
      log.error(`[${username}] nextQuestion: status=${nextResp.status}`);
      questionFailures.add(1);
      return { finalHtml: html, questionsSeen, lastSequence: sequence };
    }
  }

  if (questionsSeen >= MAX_QUESTIONS) {
    log.error(`[${username}] MAX_QUESTIONS (${MAX_QUESTIONS}) erreicht — Loop abgebrochen`);
    maxQuestionsHit.add(1);
  }
  return { finalHtml: html, questionsSeen, lastSequence: sequence };
}

// ─── Phase 4: Test beenden ──────────────────────────────────────────────────────

/**
 * finishTest ist zweistufig:
 *   1. GET cmd=finishTest → 200 mit Bestätigungs-Dialog-HTML
 *   2. POST cmd=finishTest mit finalization_confirmed=confirmed → 302
 *   3. GET afterTestPassFinished → 302 → testScreen
 *
 * Gibt das HTML der Ergebnis-Seite zurück (für Logout-rtoken) oder null bei
 * Fatal-Fehler.
 */
function finishTest(username, session, lastSequence) {
  const phaseStart = Date.now();

  const baseUrl =
    `${BASE_URL}/ilias.php?baseClass=ilrepositorygui` +
    `&cmdNode=${session.cmdNode}` +
    `&cmdClass=ilTestPlayerRandomQuestionSetGUI` +
    `&ref_id=${REF_ID}` +
    `&sequence=${lastSequence}&active_id=${session.activeId}`;

  // 4a. GET finishTest → Bestätigungs-Dialog
  const dialogResp = http.get(`${baseUrl}&cmd=finishTest`, {
    tags: { phase: "finish", step: "dialog" },
  });
  if (dialogResp.status !== 200) {
    log.error(`[${username}] finishTest-Dialog: status=${dialogResp.status}`);
    finishFailures.add(1);
    return null;
  }

  // 4b. POST finishTest mit finalization_confirmed=confirmed
  const confirmResp = http.post(
    `${baseUrl}&cmd=finishTest&finalization_confirmed=confirmed`,
    null,
    {
      tags: { phase: "finish", step: "confirm" },
      redirects: 0,
    }
  );

  if (confirmResp.status !== 302) {
    // ILIAS macht manchmal auch 200 direkt wenn der Test schon quittiert wurde.
    if (confirmResp.status === 200) {
      log.warn(`[${username}] finishTest-Confirm: 200 statt 302 — Test möglicherweise schon beendet`);
      finishDuration.add(Date.now() - phaseStart);
      return confirmResp.body;
    }
    log.error(`[${username}] finishTest-Confirm: status=${confirmResp.status}`);
    finishFailures.add(1);
    return null;
  }

  // 4c. Redirect folgen: afterTestPassFinished → testScreen
  let nextUrl = getLocation(confirmResp);
  let resultHtml = null;
  let followCount = 0;
  while (nextUrl && followCount < 5) {
    followCount++;
    const r = http.get(nextUrl, {
      tags: { phase: "finish", step: `follow_${followCount}` },
      redirects: 0,
    });
    if (r.status === 302) {
      nextUrl = getLocation(r);
    } else if (r.status === 200) {
      resultHtml = r.body;
      break;
    } else {
      log.warn(`[${username}] finishTest follow ${followCount}: status=${r.status}`);
      break;
    }
  }

  finishDuration.add(Date.now() - phaseStart);
  return resultHtml;
}

// ─── Phase 5: Logout ────────────────────────────────────────────────────────────

function doLogout(username, html) {
  // rtoken aus dem zuletzt gesehenen HTML extrahieren.
  const rtoken = extractFirst(html, /rtoken=([a-f0-9]{64})/);
  if (!rtoken) {
    log.warn(`[${username}] Logout: kein rtoken gefunden — versuche showLogout direkt`);
    http.get(
      `${BASE_URL}/ilias.php?baseClass=ilstartupgui&cmd=showLogout&lang=de&client_id=${CLIENT_ID}`,
      { tags: { phase: "logout" } }
    );
    return;
  }

  const logoutUrl =
    `${BASE_URL}/logout.php?baseClass=ilstartupgui&cmd=doLogout&rtoken=${rtoken}&lang=de`;
  http.get(logoutUrl, { tags: { phase: "logout", step: "do" }, redirects: 5 });

  http.get(
    `${BASE_URL}/ilias.php?baseClass=ilstartupgui&cmd=showLogout&lang=de&client_id=${CLIENT_ID}`,
    { tags: { phase: "logout", step: "show" } }
  );
}

// ─── Setup (läuft einmal vor allen VUs) ──────────────────────────────────────────

/**
 * Pool-Sizing-Guard für das Modell "1 Student = 1 Session".
 * Jeder VU braucht einen eigenen Account — getUsername() mappt
 * ((__VU-1) % range) + 1 + offset, d.h. ab VUS > range teilen sich zwei VUs
 * denselben Account und treten sich gegenseitig in den Test-Run (→ dirty).
 *
 * Greift nur, wenn VUS über -e VUS=… kommt. Wird --vus auf der CLI gesetzt,
 * verwirft k6 ohnehin den Scenario-Block (siehe Header-Kommentar) — dann
 * stimmt VUS_ENV nicht mehr und der Guard kann es nicht prüfen.
 */
export function setup() {
  if (VUS_ENV > ACCOUNT_RANGE) {
    throw new Error(
      `VUS (${VUS_ENV}) > Account-Pool-Range (${ACCOUNT_RANGE}). ` +
      `Im Modell "1 Student = 1 Session" braucht jeder VU einen eigenen Account. ` +
      `ACCOUNT_RANGE erhöhen oder VUS senken.`
    );
  }
  const firstIdx = ACCOUNT_OFFSET + 1;
  const lastIdx = ACCOUNT_OFFSET + Math.min(VUS_ENV, ACCOUNT_RANGE);
  log.info(
    `[setup] ${VUS_ENV} VU(s), 1 Session/VU. Accounts ` +
    `${ACCOUNT_PREFIX}${String(firstIdx).padStart(ACCOUNT_PAD_LENGTH, "0")}` +
    `..${ACCOUNT_PREFIX}${String(lastIdx).padStart(ACCOUNT_PAD_LENGTH, "0")} ` +
    `(Pool-Range ${ACCOUNT_RANGE}).`
  );
}

// ─── Main VU Flow ───────────────────────────────────────────────────────────────

export default function () {
  const username = getUsername();
  log.info(`[${username}] ════ START (VU ${__VU}, Iter ${__ITER}) ════`);

  // PHASE 1: Login
  if (!doLogin(username)) {
    runSuccess.add(false);
    return;
  }
  log.info(`[${username}] ✓ Login`);
  sleep(randInt(1, 3));

  // PHASE 2: Test starten
  const session = startTest(username);
  if (!session) {
    runSuccess.add(false);
    // Best-effort Logout (kein rtoken, aber showLogout geht immer)
    doLogout(username, null);
    return;
  }
  log.info(`[${username}] ✓ Test gestartet (active_id=${session.activeId})`);

  // PHASE 3: Frage-Loop
  const loopResult = runQuestionLoop(username, session);
  log.info(`[${username}] ✓ Loop fertig: ${loopResult.questionsSeen} Fragen, letzte seq=${loopResult.lastSequence}`);

  // PHASE 4: Test beenden
  const resultHtml = finishTest(username, session, loopResult.lastSequence);
  if (resultHtml) {
    log.info(`[${username}] ✓ Test beendet`);
  } else {
    log.warn(`[${username}] Finish unklar — Logout wird trotzdem versucht`);
  }

  // PHASE 5: Logout
  doLogout(username, resultHtml || loopResult.finalHtml || session.firstHtml);
  log.info(`[${username}] ✓ Logout`);

  runSuccess.add(true);
  log.info(`[${username}] ════ ENDE ════`);
}

// ─── Summary ────────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  return {
    "stdout": textSummary(data, { indent: " ", enableColors: true }),
  };
}
