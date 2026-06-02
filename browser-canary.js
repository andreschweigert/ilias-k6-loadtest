/**
 * k6/browser Canary Test — ILIAS 9 Standard-Test (Random Question Set)
 * ====================================================================
 *
 * Ergänzung zum HTTP-Lasttest (loadtest.js): fährt einen ECHTEN Chromium-
 * Browser durch eine komplette Test-Session (Login → Start → Frage-Loop mit
 * typspezifischer DOM-Interaktion → Beenden → Logout). Validiert, dass die UI
 * unter HTTP-Last noch bedienbar ist — fängt JS-/Rendering-Fehler, die der
 * reine HTTP-Pfad nie sieht.
 *
 * Setup (wie loadtest.js):
 *   1) cp config.example.js config.js   (falls noch nicht vorhanden)
 *   2) config.js für die Instanz ausfüllen (baseUrl, refId, password, accounts)
 *   3) Chromium muss installiert sein — k6/browser startet es.
 *
 * Usage (sichtbarer Browser, 1 VU, zum Anschauen):
 *   K6_BROWSER_HEADLESS=false k6 run -e VUS=1 browser-canary.js
 *
 * Usage (Headless-Canary, 2 VUs parallel zum HTTP-Lasttest):
 *   k6 run -e VUS=2 browser-canary.js
 *
 * Account-Pool: Der Canary nutzt einen EIGENEN Bereich (CANARY_OFFSET /
 *   CANARY_RANGE, Default test001–test010), getrennt vom HTTP-Last-Pool aus
 *   config.js — sonst teilen sich Browser- und HTTP-VUs denselben Account.
 *
 * Inventar: inventory.json muss neben dem Skript liegen (Init-Scope via open()).
 */

import { browser } from "k6/browser";
import { check } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import config from "./config.js";

// ─── Inventory (Init-Scope) ─────────────────────────────────────────────────────
const INVENTORY = JSON.parse(open("./inventory.json"));
const INVENTORY_BY_TITLE = (() => {
  const map = {};
  for (const q of INVENTORY.questions) map[q.title] = q;
  return map;
})();

// ─── Configuration ──────────────────────────────────────────────────────────────
// Layered: config.js ← ENV (ENV gewinnt). Keine Secrets im Skript.

const BASE_URL = __ENV.BASE_URL || config.baseUrl;
const REF_ID   = __ENV.REF_ID   || String(config.refId);
const PASSWORD = __ENV.PASSWORD || config.password;

if (!BASE_URL || !REF_ID || !PASSWORD) {
  throw new Error(
    "Fehlende Konfiguration. baseUrl/refId/password in config.js setzen " +
    "oder via ENV (BASE_URL, REF_ID, PASSWORD)."
  );
}

// Browser-Canary nutzt einen EIGENEN Account-Bereich, getrennt vom HTTP-Last-
// Pool (config.accounts), damit sich Browser- und HTTP-VUs nicht denselben
// Account teilen. Default: test001–test010 (CANARY_OFFSET=0, CANARY_RANGE=10).
const ACCOUNT_PREFIX = __ENV.ACCOUNT_PREFIX         || config.accounts.prefix;
const ACCOUNT_PAD    = parseInt(__ENV.ACCOUNT_PAD_LENGTH || config.accounts.padLength);
const ACCOUNT_OFFSET = parseInt(__ENV.CANARY_OFFSET || "0");
const ACCOUNT_RANGE  = parseInt(__ENV.CANARY_RANGE  || "10");

// Thinktime pro Frage (simuliert User-Verhalten). Browser-Canary ist
// meistens kürzer als HTTP-Test weil wir nur validieren, nicht Last erzeugen.
const THINK_MIN = parseInt(__ENV.THINK_MIN || "3");
const THINK_MAX = parseInt(__ENV.THINK_MAX || "6");

// Safety-Net gegen Endlos-Loop
const MAX_QUESTIONS = parseInt(__ENV.MAX_QUESTIONS || "50");

// ─── Scenarios ──────────────────────────────────────────────────────────────────

const VUS = parseInt(__ENV.VUS || "1");
const ITER = parseInt(__ENV.ITERATIONS || VUS);

export const options = {
  scenarios: {
    browser_canary: {
      executor: "shared-iterations",
      options: {
        browser: { type: "chromium" },
      },
      vus: VUS,
      iterations: ITER,
      maxDuration: "30m",
    },
  },
  thresholds: {
    checks: ["rate>0.9"],
    browser_login_duration: ["p(95)<8000"],
    browser_test_start_duration: ["p(95)<10000"],
    // Threshold skaliert mit der Thinktime: oberer Bound + 15s Puffer für
    // DOM-Interaktion, Auto-Saves, Submit/Navigation.
    browser_question_duration: [`p(95)<${(parseInt(__ENV.THINK_MAX || "6") + 15) * 1000}`],
    browser_finish_duration: ["p(95)<10000"],
  },
};

// ─── Custom Metrics ─────────────────────────────────────────────────────────────

const loginDur        = new Trend("browser_login_duration", true);
const testStartDur    = new Trend("browser_test_start_duration", true);
const questionDur     = new Trend("browser_question_duration", true);
const finishDur       = new Trend("browser_finish_duration", true);
const runSuccess      = new Rate("browser_run_success");
const questionsByType = new Counter("browser_questions_by_type");
const questionErrors  = new Counter("browser_question_errors");

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getUsername() {
  const idx = ((__VU - 1) % ACCOUNT_RANGE) + 1 + ACCOUNT_OFFSET;
  return ACCOUNT_PREFIX + String(idx).padStart(ACCOUNT_PAD, "0");
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sleepSec(s) {
  await new Promise((r) => setTimeout(r, s * 1000));
}

function errStr(e) {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

async function safeEvaluate(page, fn, arg, label) {
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    console.log(`[safeEval:${label}] ${errStr(e)}`);
    return null;
  }
}

// ─── Phase 1: Login ─────────────────────────────────────────────────────────────

async function doLogin(page, username) {
  const start = Date.now();
  await page.goto(`${BASE_URL}/login.php?cmd=force_login&lang=de`, {
    waitUntil: "networkidle",
  });

  // Akkordeon für "Lokales Benutzerkonto" ggf. aufklappen
  await safeEvaluate(page, () => {
    const accs = document.querySelectorAll('[role="button"][aria-expanded="false"]');
    for (const a of accs) {
      if ((a.textContent || "").toLowerCase().includes("lokal")) {
        a.click();
        return;
      }
    }
  }, null, "accordion");
  await sleepSec(1);

  // Form-Submit im Evaluate (robuster als page.fill, wenn Input-Namen
  // Schrägstriche enthalten, wie bei ILIAS)
  const submit = await safeEvaluate(page, ({u, p}) => {
    const user = document.querySelector('input[name="login_form/input_3/input_4"]');
    const pass = document.querySelector('input[name="login_form/input_3/input_5"]');
    if (!user || !pass) return { ok: false };
    user.value = u;
    pass.value = p;
    for (const ev of ["input", "change"]) {
      user.dispatchEvent(new Event(ev, { bubbles: true }));
      pass.dispatchEvent(new Event(ev, { bubbles: true }));
    }
    user.closest("form").submit();
    return { ok: true };
  }, { u: username, p: PASSWORD }, "login-submit");

  if (!submit || !submit.ok) {
    console.error(`[${username}] Login-Submit fehlgeschlagen`);
    return false;
  }

  // Auf Navigation warten (URL nicht mehr login.php)
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const u = page.url();
      if (u && !u.includes("login.php")) break;
    } catch {}
    await sleepSec(0.3);
  }
  try { await page.waitForLoadState("load", { timeout: 10000 }); } catch {}

  loginDur.add(Date.now() - start);

  let url = "";
  try { url = page.url(); } catch {}
  const ok = url && !url.includes("login.php");
  check(page, { "login → weg von login.php": () => ok });
  return ok;
}

// ─── Phase 2: Test starten ──────────────────────────────────────────────────────

// Wartet bis der Frage-Player (#taForm) sichtbar ist. true/false statt Throw.
async function waitForPlayer(page, timeout) {
  try {
    await page.locator("#taForm").waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

// Erkennt die Pflicht-Übersichtsseite (kein taForm, aber Player-Navigations-
// Links bzw. cmd=outQuestionSummary in der URL).
async function isOverviewPage(page) {
  let url = "";
  try { url = page.url(); } catch {}
  if (url.includes("outQuestionSummary") || url.includes("outTestSummary")) return true;
  return !!(await safeEvaluate(page, () =>
    !document.getElementById("taForm") &&
    !!document.querySelector(
      'a[href*="cmd=resumePlayer"], a[href*="cmd=startTestPlayer"], ' +
      'a[href*="cmd=gotoQuestion"], a[href*="cmd=showQuestion"]'
    ), null, "is-overview"));
}

// Navigiert von der Übersichtsseite in den Frage-Player. Probiert
// locale-unabhängige Player-Command-Links in Prioritäts-Reihenfolge, dann
// einen Text-Button als Fallback.
async function enterPlayerFromOverview(page, username) {
  const candidates = [
    'a[href*="cmd=resumePlayer"]',
    'a[href*="cmd=startTestPlayer"]',
    'a[href*="cmd=gotoQuestion"]',
    'a[href*="cmd=showQuestion"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 2000 });
      await loc.click();
      return true;
    } catch {}
  }
  const btn = page
    .locator("a, button")
    .filter({ hasText: /Test fortsetzen|Bearbeitung fortsetzen|erste Frage|Zur Frage/i })
    .first();
  try {
    await btn.waitFor({ state: "visible", timeout: 2000 });
    await btn.click();
    return true;
  } catch {}
  console.warn(`[${username}] kein Übersicht→Frage-Element gefunden`);
  return false;
}

// Diagnose bei Fehlschlag: alle cmd=-Links und Buttons der aktuellen Seite
// loggen, damit der richtige "weiter zur Frage"-Selektor ablesbar ist.
async function dumpOverviewDiagnostics(page, username) {
  let url = "";
  try { url = page.url(); } catch {}
  const info = await safeEvaluate(page, () => {
    const out = { links: [], buttons: [] };
    for (const a of Array.from(document.querySelectorAll('a[href*="cmd="]')).slice(0, 30)) {
      const m = (a.getAttribute("href") || "").match(/cmd=([A-Za-z0-9_]+)/);
      out.links.push(`${m ? m[1] : "?"} :: ${(a.textContent || "").trim().slice(0, 40)}`);
    }
    for (const b of Array.from(document.querySelectorAll('button, input[type="submit"]')).slice(0, 20)) {
      out.buttons.push((b.textContent || b.value || "").trim().slice(0, 40));
    }
    return out;
  }, null, "overview-dump");
  console.log(`[${username}] DIAGNOSE url=${url}`);
  if (info) {
    console.log(`[${username}] cmd-Links: ${info.links.join(" | ")}`);
    console.log(`[${username}] Buttons:   ${info.buttons.join(" | ")}`);
  }
}

async function startTest(page, username) {
  const start = Date.now();

  // Direkt zum Test navigieren
  await page.goto(`${BASE_URL}/goto.php?target=tst_${REF_ID}`, {
    waitUntil: "load",
  });

  // Dirty-Check
  const dirty = await safeEvaluate(page, () => {
    const body = document.body?.textContent || "";
    return body.includes("Test fortsetzen") ||
           document.querySelector('a[href*="cmd=resumePlayer"]') !== null;
  }, null, "dirty-check");
  if (dirty) {
    console.warn(`[${username}] Account ist dirty — Abbruch`);
    return null;
  }

  // "Test starten"-Button finden (variable Beschriftung: "Test starten",
  // "Prüfung starten" oder "Bearbeitung starten")
  const startBtn = page
    .locator('button, input[type="submit"]')
    .filter({ hasText: /Test starten|Prüfung starten|Test beginnen|starten/ })
    .first();

  try {
    await startBtn.waitFor({ state: "visible", timeout: 10000 });
    await startBtn.click();
  } catch (e) {
    console.error(`[${username}] Start-Button nicht gefunden: ${errStr(e)}`);
    try { await page.screenshot({ path: `/tmp/canary-start-${username}-${Date.now()}.png` }); } catch {}
    return null;
  }

  // Eventuell Bestätigungs-Modal
  await sleepSec(1);
  const modalConfirm = page
    .locator('.modal button, [role="dialog"] button, .modal input[type="submit"]')
    .filter({ hasText: /Ja|Starten|Bestätigen|Weiter|starten/ })
    .first();
  try {
    await modalConfirm.waitFor({ state: "visible", timeout: 3000 });
    await modalConfirm.click();
  } catch {
    // Kein Modal → ok
  }

  // Warten auf den Frage-Player (#taForm). Manche Test-Konfigurationen
  // (Random-Set mit Taxonomien o.ä.) rendern nach dem Start zuerst eine
  // Pflicht-Übersichtsseite ("Übersicht Testdurchlauf", cmd=outQuestionSummary)
  // statt direkt der ersten Frage — dann von dort gezielt in den Player.
  let inPlayer = await waitForPlayer(page, 15000);

  if (!inPlayer && (await isOverviewPage(page))) {
    console.log(`[${username}] Übersichtsseite erkannt — navigiere in erste Frage`);
    if (await enterPlayerFromOverview(page, username)) {
      inPlayer = await waitForPlayer(page, 15000);
    }
  }

  if (!inPlayer) {
    console.error(`[${username}] taForm nicht erreicht`);
    await dumpOverviewDiagnostics(page, username);
    try { await page.screenshot({ path: `/tmp/canary-taform-${username}-${Date.now()}.png` }); } catch {}
    return null;
  }

  testStartDur.add(Date.now() - start);
  return true;
}

// ─── Phase 3: Fragen-Handler ────────────────────────────────────────────────────

/**
 * Jeder Handler:
 *   - bekommt `page` und `spec` (aus Inventar)
 *   - macht die Eingabe/Interaktion im DOM
 *   - gibt { ok: bool } zurück
 *
 * Strategie durchgehend: Für alle Typen nutzen wir wo möglich direkte
 * DOM-Value-Setzung via page.evaluate — das ist schneller UND robuster als
 * Drag-Drop-Simulation. Für SC/MC/Kprim machen wir echte Klicks, damit die
 * UI-Events (change, onclick) getriggert werden (wichtig für den Canary-
 * Zweck: Wir wollen ja validieren dass die JS-Event-Handler funktionieren).
 */

async function handleSingleChoice(page, spec) {
  const pick = randomPick(spec.choices);
  const targetId = `answer_${pick.ident}`;
  await page.locator(`#${targetId}`).click();
  return { ok: true };
}

async function handleMultipleChoice(page, spec) {
  const min = spec.minnumber != null ? spec.minnumber : 1;
  const max = spec.maxnumber != null ? spec.maxnumber : spec.choices.length;
  const n = Math.max(1, min) + Math.floor(Math.random() * (max - Math.max(1, min) + 1));
  const shuffled = [...spec.choices].sort(() => Math.random() - 0.5).slice(0, n);
  for (const c of shuffled) {
    await page.locator(`#answer_${c.ident}`).click();
    await sleepSec(0.1);
  }
  return { ok: true };
}

async function handleKprim(page, spec) {
  // Pro Statement-Index 0..3 eine der beiden Radio-Boxen klicken.
  // Die radios haben name="kprim_choice_result_N", value="0" oder "1".
  // Da die ids doppelt vergeben sind (id=N), wählen wir per name+value.
  for (let i = 0; i < 4; i++) {
    const val = Math.random() < 0.5 ? "0" : "1";
    await page.locator(`input[name="kprim_choice_result_${i}"][value="${val}"]`).click();
    await sleepSec(0.1);
  }
  return { ok: true };
}

async function handleNumeric(page, spec) {
  const lo = spec.min != null ? spec.min : 0;
  const hi = spec.max != null ? spec.max : lo;
  const val = Math.floor(lo + Math.random() * (hi - lo + 1));
  await page.locator('input[name="numeric_result"]').fill(String(val));
  return { ok: true };
}

async function handleFormula(page, spec) {
  const lo = spec.r1.rangemin;
  const hi = spec.r1.rangemax;
  const val = Math.floor(lo + Math.random() * (hi - lo));
  // name="result_$r1" — der $ muss im CSS-Selector escaped werden.
  await page.locator('input[name="result_\\$r1"]').fill(String(val));
  return { ok: true };
}

async function handleTextsubset(page, spec) {
  for (let i = 0; i < spec.inputs; i++) {
    const val = randomPick(spec.accepted_pool);
    await page.locator(`input[name="TEXTSUBSET_${i}"]`).fill(val);
    await sleepSec(0.1);
  }
  return { ok: true };
}

async function handleLongMenu(page, spec) {
  // 4 Dropdowns mit Autocomplete. Wir setzen einfach einen Wert via fill.
  // Die ILIAS-Validierung beim Scoring checkt gegen die Options-Liste, aber
  // der POST nimmt beliebige Strings an.
  for (let i = 0; i < spec.dropdowns.length; i++) {
    const val = randomPick(spec.dropdowns[i].options);
    await page.locator(`input[name="answer[${i}]"]`).fill(val);
    await sleepSec(0.1);
  }
  return { ok: true };
}

async function handleCloze(page, spec) {
  for (let i = 0; i < spec.gaps.length; i++) {
    const g = spec.gaps[i];
    if (g.kind === "select") {
      const opt = randomPick(g.options);
      await page.locator(`select[name="gap_${i}"]`).selectOption(opt.ident);
    } else if (g.kind === "numeric") {
      const lo = g.minnumber || 0;
      const hi = g.maxnumber || lo;
      const val = Math.floor(lo + Math.random() * (hi - lo + 1));
      await page.locator(`input[name="gap_${i}"]`).fill(String(val));
    } else {
      // text
      const chars = "abcdefghijk";
      let s = "";
      const len = Math.max(1, Math.min(g.columns || 4, 8));
      for (let k = 0; k < len; k++) s += chars[Math.floor(Math.random() * chars.length)];
      await page.locator(`input[name="gap_${i}"]`).fill(s);
    }
    await sleepSec(0.1);
  }
  return { ok: true };
}

async function handleOrderingH(page, spec) {
  // ILIAS synchronisiert den Hidden-Input "orderresult" beim Submit aus der
  // aktuellen DOM-Reihenfolge der <li> in <ul id="horizontal_<qid>">.
  // Hidden-Input-Manipulation wird überschrieben → wir ordnen im DOM um.
  // Per appendChild wird das Element NICHT kopiert sondern verschoben, daher
  // ist ein Fisher-Yates auf den children der einfachste Weg.
  const r = await safeEvaluate(page, () => {
    const ul = document.querySelector('ul[id^="horizontal_"]');
    if (!ul) return { ok: false, reason: "no horizontal ul" };
    const items = Array.from(ul.children).filter(c => c.tagName === "LI");
    if (items.length === 0) return { ok: false, reason: "no li children" };
    // shuffle
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    // Neu einhängen in neuer Reihenfolge
    for (const li of items) ul.appendChild(li);
    // change-Event auf dem ul oder hidden input, damit ILIAS' eigener
    // Listener (falls vorhanden) mitbekommt dass sich was geändert hat.
    const hidden = document.querySelector('input[name="orderresult"]');
    if (hidden) {
      // Manche ILIAS-Versionen lesen den value vorab — wir setzen ihn proaktiv
      // aus der neuen DOM-Reihenfolge.
      const newVal = items.map(li => {
        const span = li.querySelector('.ilOrderingValue') || li.querySelector('span');
        return span ? span.textContent.trim() : "";
      }).join("{::}");
      hidden.value = newVal;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true, count: items.length };
  }, null, "ordering_h-reorder");
  return { ok: r && r.ok };
}

async function handleOrderingV(page, spec) {
  // Vertikales Ordering: <ul class="dd-list"> mit <li class="dd-item" data-id>.
  // Die Hidden-Inputs order_elems[content][IDENT] sind schon im DOM; ILIAS
  // liest die Reihenfolge beim Submit aus der DOM-Reihenfolge der <li>-Kinder
  // (nicht aus den Hidden-Input-Werten direkt). Also: <li> umhängen.
  const r = await safeEvaluate(page, () => {
    const ul = document.querySelector('ul.dd-list.ilc_qordul_OrderList');
    if (!ul) return { ok: false, reason: "no dd-list ul" };
    const items = Array.from(ul.children).filter(
      c => c.tagName === "LI" && c.classList.contains("dd-item")
    );
    if (items.length === 0) return { ok: false, reason: "no dd-items" };
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    for (const li of items) ul.appendChild(li);
    return { ok: true, count: items.length };
  }, null, "ordering_v-reorder");
  return { ok: r && r.ok };
}

async function handleMatching(page, spec) {
  // v3: Statischer Plan (wie v1), aber mit den v2-Verbesserungen
  // (6 Steps, 25%-Drop-Position, per-Drag Scroll) und größerem Delay
  // zwischen Drags, damit ILIAS' State-Update-Callbacks zuverlässig
  // fertig sind bevor wir den nächsten Drag starten.
  //
  // Das Term-Div bleibt nach einem Drop im Pool (ILIAS clont intern) — bei
  // 1:1 manchmal auch einfach ein Kopie-verhalten, aber auf jeden Fall ist
  // document.getElementById("term_<iid>") auch nach mehrfachen Drops noch da.

  /**
   * Führt genau einen Drag-Drop per echter Maus-Sequenz aus.
   * Gibt true zurück bei Erfolg, false falls Elemente nicht gefunden.
   */
  async function dragItemToTerm(termIdent, itemIdent) {
    // Boxes direkt vor dem Drag holen, inkl. Scroll.
    const boxes = await safeEvaluate(page, ({ tid, iid }) => {
      const src = document.getElementById(`term_${iid}`);
      const dst = document.getElementById(`definition_${tid}`);
      if (!src || !dst) return null;
      // Source zuerst in Viewport scrollen
      src.scrollIntoView({ block: "center", behavior: "instant" });
      const sr = src.getBoundingClientRect();
      const dr = dst.getBoundingClientRect();
      return {
        sx: sr.left + sr.width / 2,
        sy: sr.top + sr.height / 2,
        // Drop in oberes Viertel — stabiler als geometrische Mitte
        dx: dr.left + dr.width / 2,
        dy: dr.top + dr.height * 0.25,
      };
    }, { tid: termIdent, iid: itemIdent }, "matching-boxes");

    if (!boxes) return false;

    // Maus-Sequenz mit Zwischenschritten
    await page.mouse.move(boxes.sx, boxes.sy);
    await sleepSec(0.1);
    await page.mouse.down();
    await sleepSec(0.15); // Grab-Phase
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = boxes.sx + (boxes.dx - boxes.sx) * t;
      const y = boxes.sy + (boxes.dy - boxes.sy) * t;
      await page.mouse.move(x, y);
      await sleepSec(0.05);
    }
    await sleepSec(0.15); // Target einrasten
    await page.mouse.up();
    return true;
  }

  // Plan erstellen (deterministisch am Anfang, wie v1)
  const plan = [];
  for (const term of spec.terms) {
    const n = spec.mode === "1:1"
      ? 1
      : 1 + Math.floor(Math.random() * Math.min(3, spec.items.length));
    const shuf = [...spec.items].sort(() => Math.random() - 0.5).slice(0, n);
    for (const item of shuf) {
      plan.push({ tid: term.ident, iid: item.ident });
    }
  }

  let assigned = 0;
  for (const pair of plan) {
    const ok = await dragItemToTerm(pair.tid, pair.iid);
    if (ok) {
      assigned++;
    } else {
      console.warn(`[matching ${spec.mode}] drag für term=${pair.tid}/item=${pair.iid} fehlgeschlagen`);
    }
    // WICHTIG: großer Delay zwischen Drags, damit ILIAS' Drop-Callback
    // (State-Update, eventuelle DOM-Rerenders) vollständig durch ist.
    // 800ms ist pragmatisch — fühlt sich langsam an, ist aber robust.
    await sleepSec(0.8);
  }

  return { ok: assigned > 0, assigned };
}

async function handleErrortext(page, spec) {
  // Errortext: Worte sind <a class="ilc_qetitem_ErrorTextItem"> — klickbar.
  // ILIAS toggelt beim Klick eine "markiert"-Klasse und serialisiert die
  // markierten Positionen beim Submit in den Hidden-Input qst_<qid>.
  // Wir klicken also 3-8 zufällige Wörter an.
  //
  // Anmerkung: Wir nutzen hier page.evaluate mit direkten click() calls statt
  // echte page.locator().click(), weil das sonst pro Wort ein eigener Roundtrip
  // wird — bei 5-8 Wörtern wären das 5-8 Sekunden Roundtrip-Latenz, und wir
  // wollen trotzdem die echten Event-Handler triggern.
  const r = await safeEvaluate(page, () => {
    const items = Array.from(document.querySelectorAll('a.ilc_qetitem_ErrorTextItem'));
    if (items.length === 0) return { ok: false, reason: "no errortext items" };
    const count = 3 + Math.floor(Math.random() * 6); // 3-8
    const indices = new Set();
    while (indices.size < count && indices.size < items.length) {
      indices.add(Math.floor(Math.random() * items.length));
    }
    let clicked = 0;
    for (const idx of indices) {
      items[idx].click();
      clicked++;
    }
    return { ok: true, clicked, total: items.length };
  }, null, "errortext-click");
  return { ok: r && r.ok };
}

// Handler-Dispatch
const HANDLERS = {
  single_choice: handleSingleChoice,
  multiple_choice: handleMultipleChoice,
  kprim: handleKprim,
  numeric: handleNumeric,
  formula: handleFormula,
  textsubset: handleTextsubset,
  long_menu: handleLongMenu,
  cloze: handleCloze,
  ordering_h: handleOrderingH,
  ordering_v: handleOrderingV,
  matching: handleMatching,
  errortext: handleErrortext,
};

// ─── Frage-Loop ─────────────────────────────────────────────────────────────────

async function playQuestionAndNext(page, username) {
  const start = Date.now();

  // Titel aus <h1>
  const title = await safeEvaluate(page, () => {
    const h1 = document.querySelector("h1");
    return h1 ? h1.textContent.trim() : null;
  }, null, "title");

  if (!title) {
    console.warn(`[${username}] kein H1-Titel gefunden`);
    questionErrors.add(1);
    return { ok: false, done: true };
  }

  const q = INVENTORY_BY_TITLE[title];
  if (!q) {
    console.warn(`[${username}] Titel "${title}" nicht im Inventar`);
    questionErrors.add(1);
    return { ok: false, done: true };
  }

  const handler = HANDLERS[q.type];
  if (!handler) {
    console.warn(`[${username}] kein Handler für ${q.type}`);
    questionErrors.add(1);
  } else {
    try {
      await handler(page, q.spec);
      questionsByType.add(1, { qtype: q.type });
    } catch (e) {
      console.error(`[${username}] Handler ${q.type} Fehler: ${errStr(e)}`);
      questionErrors.add(1);
      try { await page.screenshot({ path: `/tmp/canary-${q.type}-${username}-${Date.now()}.png` }); } catch {}
    }
  }

  console.log(`[${username}] ${q.type}: "${title}" ✓`);

  // Thinktime
  await sleepSec(randInt(THINK_MIN, THINK_MAX));

  // Den richtigen Next-Button finden. Auf der LETZTEN Frage gibt's kein
  // "Speichern und Weiter", sondern "Speichern und Test beenden".
  // Wir versuchen beide Labels — ILIAS zeigt je nach Fortschritt nur einen.
  const weiterBtn = page
    .locator('button, input[type="submit"]')
    .filter({ hasText: /Speichern und Weiter/ })
    .first();
  const beendenBtn = page
    .locator('button, input[type="submit"]')
    .filter({ hasText: /Speichern und Test beenden|Test beenden/ })
    .first();

  // Erst versuchen "Speichern und Weiter" zu klicken (kurzes Timeout,
  // damit wir schnell auf "Test beenden" umsteigen können).
  let clicked = false;
  let isLastQuestion = false;
  try {
    await weiterBtn.waitFor({ state: "visible", timeout: 2000 });
    await weiterBtn.click();
    clicked = true;
  } catch {
    // Wahrscheinlich letzte Frage — "Test beenden"-Button versuchen.
    try {
      await beendenBtn.waitFor({ state: "visible", timeout: 5000 });
      await beendenBtn.click();
      clicked = true;
      isLastQuestion = true;
    } catch (e) {
      console.error(`[${username}] weder Weiter noch Test-beenden-Button gefunden: ${errStr(e)}`);
      return { ok: false, done: true };
    }
  }

  // URL vor Klick wurde nicht gemerkt — wir warten einfach auf das nächste
  // load-Event oder bis die Frage-h1 sich geändert hat.
  try { await page.waitForLoadState("load", { timeout: 10000 }); } catch {}
  await sleepSec(0.5);

  questionDur.add(Date.now() - start);

  // Bei letzter Frage signalisieren wir done=true — finishTest übernimmt dann
  // den Confirm-Dialog.
  return { ok: true, done: isLastQuestion, qtype: q.type, isLast: isLastQuestion };
}

async function runQuestionLoop(page, username) {
  const seenTitles = new Set();
  let count = 0;

  while (count < MAX_QUESTIONS) {
    count++;

    // Aktuellen Titel prüfen (Wiederholungs-Schutz)
    const title = await safeEvaluate(page, () => {
      const h1 = document.querySelector("h1");
      return h1 ? h1.textContent.trim() : null;
    }, null, "loop-title");

    if (title && seenTitles.has(title)) {
      console.log(`[${username}] "${title}" bereits gesehen — Loop-Ende`);
      break;
    }
    if (title) seenTitles.add(title);

    // Sind wir noch im taForm? Wenn nicht, Test ist zu Ende.
    const inForm = await safeEvaluate(page, () => {
      return !!document.getElementById("taForm");
    }, null, "inform");
    if (!inForm) {
      console.log(`[${username}] taForm nicht mehr präsent — Test scheint beendet`);
      break;
    }

    const r = await playQuestionAndNext(page, username);
    if (r.done) break;
  }

  return { questionsSeen: count };
}

// ─── Phase 4: Test beenden ──────────────────────────────────────────────────────

async function finishTest(page, username) {
  const start = Date.now();

  // Wenn wir hier landen, haben wir (in playQuestionAndNext) schon auf
  // "Speichern und Test beenden" geklickt — jetzt sollte der
  // Bestätigungs-Dialog "Ja, ich will den Test beenden" sichtbar sein.
  // ILIAS benutzt dafür ein Modal mit einem primären Submit-Button.
  const confirmBtn = page
    .locator('button, input[type="submit"]')
    .filter({ hasText: /Ja, ich will den Test beenden|Test wirklich beenden|Ja, beenden/ })
    .first();

  try {
    await confirmBtn.waitFor({ state: "visible", timeout: 8000 });
    console.log(`[${username}] Confirm-Dialog gefunden — klicke "Ja, Test beenden"`);
    await confirmBtn.click();
  } catch (e) {
    // Fallback: vielleicht ist das Modal schon weg oder gar nicht aufgekommen.
    // Dann nochmal auf irgendeinen "Test beenden"-Button suchen.
    console.log(`[${username}] Kein "Ja, beenden"-Dialog sichtbar — prüfe ob Test bereits beendet`);
    const anyEnd = page
      .locator('button, input[type="submit"]')
      .filter({ hasText: /Speichern und Test beenden|Test beenden/ })
      .first();
    try {
      await anyEnd.waitFor({ state: "visible", timeout: 3000 });
      await anyEnd.click();
      // Dann nochmal nach Confirm suchen
      await sleepSec(1);
      try {
        await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
        await confirmBtn.click();
      } catch {}
    } catch {
      console.log(`[${username}] Test scheint schon beendet oder auf Ergebnis-Seite`);
    }
  }

  try { await page.waitForLoadState("load", { timeout: 15000 }); } catch {}
  await sleepSec(1);
  finishDur.add(Date.now() - start);
  return true;
}

// ─── Phase 5: Logout ────────────────────────────────────────────────────────────

async function doLogout(page) {
  try {
    await page.goto(
      `${BASE_URL}/ilias.php?baseClass=ilstartupgui&cmd=showLogout&lang=de`,
      { waitUntil: "load" }
    );
  } catch {}
}

// ─── Main VU Flow ───────────────────────────────────────────────────────────────

export default async function () {
  const username = getUsername();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[${username}] ════ START (VU ${__VU}) ════`);
  let success = false;

  try {
    if (!(await doLogin(page, username))) throw new Error("Login failed");
    console.log(`[${username}] ✓ Login`);
    await sleepSec(randInt(1, 2));

    if (!(await startTest(page, username))) throw new Error("Test-Start failed");
    console.log(`[${username}] ✓ Test gestartet`);

    const loop = await runQuestionLoop(page, username);
    console.log(`[${username}] ✓ Loop fertig: ${loop.questionsSeen} Fragen`);

    await finishTest(page, username);
    console.log(`[${username}] ✓ Test beendet`);

    success = true;
  } catch (e) {
    console.error(`[${username}] ERROR: ${errStr(e)}`);
    try { await page.screenshot({ path: `/tmp/canary-fatal-${username}-${Date.now()}.png` }); } catch {}
  } finally {
    try { await doLogout(page); } catch {}
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    runSuccess.add(success);
    console.log(`[${username}] ════ ENDE ════`);
  }
}

// ─── Summary / Reporting ──────────────────────────────────────────────────────
// stdout-Textsummary wie gehabt + HTML-Report (Grafana-unabhängig, im Browser
// öffenbar) + JSON für maschinelle Auswertung. Dateien sind via .gitignore
// (summary*.html / summary*.json) vom Commit ausgeschlossen.

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "summary-browser.html": htmlReport(data, { title: "ILIAS Browser-Canary" }),
    "summary-browser.json": JSON.stringify(data, null, 2),
  };
}
