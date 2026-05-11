/**
 * ilias-lasttest — instance configuration
 * ========================================
 *
 * 1) cp config.example.js config.js
 * 2) edit config.js for your ILIAS instance
 * 3) k6 run -e SMOKE=1 loadtest.js
 *
 * Every field can also be overridden at runtime via ENV variable —
 * useful for CI/CD where you don't want secrets in a checked-in file.
 *
 * config.js is in .gitignore. Don't commit it.
 */

export default {
  // ── Instance ────────────────────────────────────────────────────────────────
  // Base URL incl. ILIAS client subpath. No trailing slash.
  // ENV: BASE_URL
  baseUrl: "https://your-ilias.example.org/client",

  // Test object ref_id (visible in ILIAS URLs as ref_id=…).
  // ENV: REF_ID
  refId: "12345",

  // ILIAS client_id (the value of the client subpath, e.g. "default").
  // ENV: CLIENT_ID
  clientId: "default",

  // Shared password for all test accounts. For CI, prefer ENV PASSWORD.
  // ENV: PASSWORD
  password: "loadtest123",

  // ── Account pool ────────────────────────────────────────────────────────────
  // Accounts are addressed as `<prefix><idx-zero-padded-to-padLength>`.
  // VUs map round-robin onto idx ∈ [offset+1 .. offset+range].
  // Defaults below produce test011 .. test115.
  // ENV: ACCOUNT_PREFIX, ACCOUNT_PAD_LENGTH, ACCOUNT_OFFSET, ACCOUNT_RANGE
  accounts: {
    prefix: "test",
    padLength: 3,
    offset: 10,
    range: 105,
  },

  // ── Timing (seconds) ────────────────────────────────────────────────────────
  // Per-question think-time and number of autosaves per question.
  // SMOKE=1 collapses think-times to ~1 s.
  // ENV: THINK_MIN, THINK_MAX, AUTOSAVE_MIN, AUTOSAVE_MAX
  timing: {
    thinkMin: 25,
    thinkMax: 50,
    autosaveMin: 1,
    autosaveMax: 2,
  },
};
