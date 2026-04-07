const http = require("http");
const https = require("https");
const crypto = require("crypto");
const DEFAULT_CORE_PORT = process.env.MORK_CORE_PORT || process.env.PORT || "8790";
const BASE = (process.env.MORK_CORE_URL || `http://localhost:${DEFAULT_CORE_PORT}`).replace(/\/+$/, "");
console.log("[morkReporter] BASE =", BASE);
const AUTH_HEADER_NAME = process.env.MORK_CORE_AUTH_HEADER || ""; // e.g. "x-api-key"
const AUTH_HEADER_VALUE = process.env.MORK_CORE_AUTH || ""; // value
const EVENT_COOLDOWN_MS = Number(process.env.MORK_REPORT_COOLDOWN_MS || 15_000);
const MAX_EVENT_BYTES = Number(process.env.MORK_REPORT_MAX_BYTES || 16_000);
const MIN_POST_GAP_MS = Number(process.env.MORK_REPORT_MIN_POST_GAP_MS || 250);
const FAILURE_LOG_COOLDOWN_MS = Number(process.env.MORK_REPORT_FAILURE_LOG_COOLDOWN_MS || 30_000);
const CORE_RECHECK_MS = Number(process.env.MORK_REPORT_CORE_RECHECK_MS || 30_000);

const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const agentFor = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:"
      ? new https.Agent({ keepAlive: true, maxSockets: 16 })
      : new http.Agent({ keepAlive: true, maxSockets: 16 });
  } catch {
    return undefined;
  }
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetry(err, res) {

  if (err) return true;
  if (res && res.status >= 500) return true;

  return false;
}

function safeJsonBytes(obj, maxBytes = MAX_EVENT_BYTES) {

  let s;
  try {
    s = JSON.stringify(obj);
  } catch {
    return JSON.stringify({ error: "payload_not_serializable" });
  }

  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;

  const trimmed = deepTrim(obj, { maxString: 500, maxArray: 50, depth: 4 });
  s = JSON.stringify(trimmed);

  if (Buffer.byteLength(s, "utf8") > maxBytes) {
    return JSON.stringify({ error: "payload_too_large", note: "trim_failed" });
  }

  return s;
}

function deepTrim(value, { maxString = 500, maxArray = 50, depth = 4 } = {}) {
  if (depth <= 0) return "[trimmed]";
  if (value == null) return value;

  if (typeof value === "string") {
    return value.length > maxString ? value.slice(0, maxString) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArray);
    return sliced.map((v) => deepTrim(v, { maxString, maxArray, depth: depth - 1 }));
  }

  if (typeof value === "object") {
    const out = {};
    const keys = Object.keys(value);
    for (const k of keys) {
      out[k] = deepTrim(value[k], { maxString, maxArray, depth: depth - 1 });
    }
    return out;
  }

  return String(value);
}

function buildHeaders(extra = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (AUTH_HEADER_NAME && AUTH_HEADER_VALUE) {
    headers[AUTH_HEADER_NAME] = AUTH_HEADER_VALUE;
  }
  return headers;
}

const _dedupe = new Map(); // key -> lastSentMs
const _pathNextAt = new Map(); // path -> next allowed POST ms
const _failureLogState = new Map(); // path -> { lastLogAt, suppressed }
let _coreReachable = null;
let _coreCheckedAt = 0;
let _coreSuppressedUntil = 0;

function hashKey(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 16);
}

function canSend(dedupeKey) {
  if (!dedupeKey) return true;
  const now = Date.now();
  const last = _dedupe.get(dedupeKey) || 0;
  if (now - last < EVENT_COOLDOWN_MS) return false;
  _dedupe.set(dedupeKey, now);

  if (_dedupe.size > 5000) {
    const cutoff = now - EVENT_COOLDOWN_MS * 4;
    for (const [k, ts] of _dedupe.entries()) {
      if (ts < cutoff) _dedupe.delete(k);
    }
  }
  return true;
}

async function waitForPathGap(path) {
  if (!MIN_POST_GAP_MS || MIN_POST_GAP_MS <= 0) return;
  const now = Date.now();
  const nextAllowedAt = _pathNextAt.get(path) || 0;
  if (nextAllowedAt > now) {
    await sleep(nextAllowedAt - now);
  }
  _pathNextAt.set(path, Date.now() + MIN_POST_GAP_MS);
}

function logPostFailure(path, message) {
  const now = Date.now();
  const state = _failureLogState.get(path) || { lastLogAt: 0, suppressed: 0 };
  const since = now - state.lastLogAt;

  if (since >= FAILURE_LOG_COOLDOWN_MS) {
    const suffix = state.suppressed > 0 ? ` (suppressed ${state.suppressed} similar failures)` : "";
    console.warn("[morkReporter] failed:", `${path}: ${message}${suffix}`);
    _failureLogState.set(path, { lastLogAt: now, suppressed: 0 });
    return;
  }

  _failureLogState.set(path, { ...state, suppressed: state.suppressed + 1 });
}

async function ensureCoreReachable() {
  const now = Date.now();
  if (_coreReachable === false && now < _coreSuppressedUntil) {
    return false;
  }
  if (_coreReachable !== null && now - _coreCheckedAt < CORE_RECHECK_MS) {
    return _coreReachable;
  }
  _coreReachable = await getOk("/health", { timeoutMs: 900 });
  _coreCheckedAt = now;
  if (!_coreReachable) {
    _coreSuppressedUntil = now + CORE_RECHECK_MS;
  }
  return _coreReachable;
}

async function postJson(path, body, { retries = 2, timeoutMs = 2500, dedupeKey } = {}) {
  const url = `${BASE}${path}`;
  const agent = agentFor(url);

  if (dedupeKey && !canSend(dedupeKey)) return true; // treat as ok; we intentionally suppressed
  if (!(await ensureCoreReachable())) return false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    let t;
    try {
      await waitForPathGap(path);
      const controller = new AbortController();
      t = setTimeout(() => controller.abort(), timeoutMs);

      const payload = safeJsonBytes(body);

      res = await fetchFn(url, {
        method: "POST",
        headers: buildHeaders(),
        body: payload,
        signal: controller.signal,
        // node-fetch supports agent; native fetch in Node ignores unknown fields safely
        agent,
      });

      clearTimeout(t);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = `MorkCore ${res.status} ${path}: ${text.slice(0, 200)}`;

        if (shouldRetry(null, res) && attempt < retries) {
          await sleep(250 * (attempt + 1));
          continue;
        }

        logPostFailure(path, msg);
        return false;
      }

      _coreReachable = true;
      _coreCheckedAt = Date.now();
      return true;
    } catch (e) {
      const timedOut = e?.name === "AbortError";
      const msg = timedOut ? `timeout after ${timeoutMs}ms` : e?.message || String(e);
      if (attempt === retries) {
        _coreReachable = false;
        _coreCheckedAt = Date.now();
        _coreSuppressedUntil = Date.now() + CORE_RECHECK_MS;
        logPostFailure(path, msg);
        return false;
      }
      await sleep(250 * (attempt + 1));
    } finally {
      if (t) clearTimeout(t);
    }
  }

  return false;
}

async function getOk(path, { timeoutMs = 1200 } = {}) {
  const url = `${BASE}${path}`;
  const agent = agentFor(url);

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
      agent,
      headers: AUTH_HEADER_NAME && AUTH_HEADER_VALUE ? { [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE } : undefined,
    });

    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
async function morkArbEvent(evt) {
  if (!evt) return false;
  return postJson("/arb/event", evt, { retries: 1, timeoutMs: 2500 });
}

async function morkGetPolicy(mint) {
  const url = `${BASE}/arb/policy?mint=${encodeURIComponent(mint || "")}`;
  const agent = agentFor(url);

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);

    const res = await fetchFn(url, { method: "GET", signal: controller.signal, agent });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.policy || null;
  } catch {
    return null;
  }
}

async function morkMemory({
  type = "fact",
  content,
  entities = [],
  importance = 0.2,
  source = "arb",
} = {}) {
  if (!content) return false;
  const dedupeKey = hashKey(`mem:${type}:${content}`);
  return postJson(
    "/memory/ingest",
    { type, content, entities, importance, source },
    { dedupeKey }
  );
}

async function morkTick(reason = "arb_event") {
  const dedupeKey = hashKey(`tick:${reason}`);
  return postJson("/planner/tick", { reason }, { retries: 1, timeoutMs: 2500, dedupeKey });
}

async function morkPing() {
  const ok = await getOk("/health", { timeoutMs: 900 });
  _coreReachable = ok;
  _coreCheckedAt = Date.now();
  if (!ok) {
    _coreSuppressedUntil = Date.now() + CORE_RECHECK_MS;
  }
  return ok;
}

const OPPORTUNITY_PATH = process.env.MORK_OPPORTUNITY_PATH || "/market/opportunity";
async function morkOpportunity({
  symbol,
  inMint,
  spendUsd,
  edgePct,
  netUsd,
  grossUsd,
  slippageBps,
  routeHint,
  confidence = 0.5,
  meta = {},
  source = "arb",
} = {}) {
  if (!symbol) return false;

  const dedupeKey = hashKey(
    `opp:${symbol}:${inMint || ""}:${Number(spendUsd || 0).toFixed(2)}:${Number(netUsd || 0).toFixed(4)}`
  );

  return postJson(
    OPPORTUNITY_PATH,
    {
      ts: Date.now(),
      symbol,
      inMint,
      spendUsd,
      edgePct,
      netUsd,
      grossUsd,
      slippageBps,
      routeHint,
      confidence,
      meta,
      source,
    },
    { retries: 1, timeoutMs: 2000, dedupeKey }
  );
}

const BALANCES_PATH = process.env.MORK_BALANCES_PATH || "/wallet/balances";
async function morkBalances({
  pubkey,
  sol,
  usdc,
  bbq,
  extra = {},
  source = "arb",
} = {}) {
  if (!pubkey) return false;
  const dedupeKey = hashKey(
    `bal:${pubkey}:${Number(sol || 0).toFixed(4)}:${Number(usdc || 0).toFixed(4)}:${Number(bbq || 0).toFixed(4)}`
  );

  return postJson(
    BALANCES_PATH,
    { ts: Date.now(), pubkey, sol, usdc, bbq, extra, source },
    { retries: 0, timeoutMs: 1500, dedupeKey }
  );
}

const EXEC_PATH = process.env.MORK_EXEC_PATH || "/market/execution";
async function morkExecution({
  symbol,
  sig,
  ok,
  spendUsd,
  netUsd,
  reason,
  meta = {},
  source = "arb",
} = {}) {
  if (!symbol) return false;
  const dedupeKey = sig ? hashKey(`execsig:${sig}`) : hashKey(`exec:${symbol}:${ok}:${reason || ""}`);
  return postJson(
    EXEC_PATH,
    { ts: Date.now(), symbol, sig, ok: !!ok, spendUsd, netUsd, reason, meta, source },
    { retries: 1, timeoutMs: 2000, dedupeKey }
  );
}
async function morkWalletSnapshot(snapshot) {
  if (!snapshot) return false;
  return postJson("/wallet/snapshot", snapshot, { retries: 1, timeoutMs: 2000 });
}

async function morkSignal({
  kind = "trade_signal",
  symbol,
  mint,
  confidence = 0.3,
  thesis,
  numbers = {},
  risk = "unknown",
  source = "arb",
} = {}) {
  if (!symbol && !mint) return false;
  return postJson(
    "/signals/ingest",
    { kind, symbol, mint, confidence, thesis, numbers, risk, source, ts: new Date().toISOString() },
    { retries: 1, timeoutMs: 2000 }
  );
}

module.exports = {
  morkMemory,
  morkTick,
  morkPing,
  morkArbEvent,
  morkGetPolicy,
  morkOpportunity,
  morkBalances,
  morkExecution,
  morkWalletSnapshot,
  morkSignal,
};
