require("dotenv").config();
const fetch = require("node-fetch");
const fs = require("fs");

// ---- constants ----
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote"; // works for you (200 OK)
const TOKENS_CSV_URL =
  "https://raw.githubusercontent.com/igneous-labs/jup-token-list/main/validated-tokens.csv";
const TOKENS_CSV_CACHE = "tokens_validated.csv";

const USDC = {
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
};
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // for sanity test

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function pickHeaderIndex(headers, candidates) {
  const lower = headers.map((h) => String(h || "").trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

function isSkippable(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("TOKEN_NOT_TRADABLE") ||
    msg.includes("NO_ROUTES_FOUND") ||
    msg.includes("COULD_NOT_FIND_ANY_ROUTE") ||
    msg.includes("CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD")
  );
}

async function getQuote(inputMint, outputMint, amount, slippageBps = 50) {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());

  // jitter
  await sleep(80 + Math.floor(Math.random() * 120));

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "sol-arb-bot/0.1" },
    });

    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Number(ra) * 1000 : 900 * (attempt + 1) ** 2;
      await sleep(waitMs + Math.floor(Math.random() * 300));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jupiter quote error: ${res.status} ${res.statusText}${body ? " | " + body : ""}`);
    }

    return await res.json();
  }

  throw new Error("Jupiter quote error: 429 Too Many Requests (gave up after retries)");
}

async function sanityCheck() {
  const amount = "1000000"; // 1 USDC
  const u =
    `${QUOTE_URL}?inputMint=${USDC.mint}&outputMint=${USDT_MINT}&amount=${amount}&slippageBps=50`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Sanity check failed (${r.status}): ${txt}`);
  console.log("Sanity check OK: USDC→USDT quote reachable");
}

async function loadValidatedTokens() {
  let csvText = null;

  if (fs.existsSync(TOKENS_CSV_CACHE)) {
    csvText = fs.readFileSync(TOKENS_CSV_CACHE, "utf8");
  } else {
    const res = await fetch(TOKENS_CSV_URL, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`Token list error: ${res.status} ${res.statusText}`);
    csvText = await res.text();
    fs.writeFileSync(TOKENS_CSV_CACHE, csvText);
  }

  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("Token CSV looks empty");

  const headers = parseCsvLine(lines[0]);

  // robust header mapping (CSV formats vary)
  const idxName = pickHeaderIndex(headers, ["name"]);
  const idxSymbol = pickHeaderIndex(headers, ["symbol", "ticker"]);
  const idxMint = pickHeaderIndex(headers, ["address", "mint", "mintaddress", "token_address"]);
  const idxDecimals = pickHeaderIndex(headers, ["decimals", "decimal"]);

  if (idxSymbol === -1 || idxMint === -1 || idxDecimals === -1) {
    throw new Error(
      `Could not map CSV columns. Headers seen: ${headers.join(", ")}`
    );
  }

  const tokens = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const symbol = (cols[idxSymbol] || "").trim();
    const mint = (cols[idxMint] || "").trim();
    const decimals = Number((cols[idxDecimals] || "").trim());
    const name = idxName !== -1 ? (cols[idxName] || "").trim() : "";

    if (!symbol || !mint || !Number.isFinite(decimals)) continue;
    if (symbol.length > 12) continue; // small sanity
    if (mint === USDC.mint) continue;

    tokens.push({ name, symbol, mint, decimals });
  }

  // sort “common-ish” tickers first as a heuristic
  tokens.sort((a, b) => a.symbol.length - b.symbol.length);

  return tokens;
}

async function main() {
  const TARGET = 500;
  const OUTFILE = "whitelist.json";

  await sanityCheck();

  console.log("Loading validated token list...");
  const tokens = await loadValidatedTokens();
  console.log(`Validated tokens loaded: ${tokens.length}`);

  console.log(`Building whitelist (target=${TARGET}) using Jupiter quotes...`);

  const whitelist = [];
  const bad = new Set();
  let attempts = 0;

  for (const t of tokens) {
    if (whitelist.length >= TARGET) break;
    if (bad.has(t.mint)) continue;

    attempts++;
    if (attempts % 50 === 0) {
      console.log(`attempted ${attempts}/${tokens.length} | whitelisted ${whitelist.length}/${TARGET}`);
    }

    try {
      // Probe: 1 USDC -> token (most reliable)
      const json = await getQuote(USDC.mint, t.mint, "1000000", 50);

      // lite-api returns quote JSON directly (not {data:[...]})
      // Ensure it has a route plan / outAmount
      if (!json || !json.outAmount || !json.routePlan || json.routePlan.length === 0) {
        bad.add(t.mint);
        continue;
      }

      whitelist.push({
        symbol: `${t.symbol}/USDC`,
        inMint: t.mint,
        inDecimals: t.decimals,
        outMint: USDC.mint,
        outDecimals: USDC.decimals,
        probeUsd: 25,
      });

      // write partial progress every 25 adds so you can watch it fill
      if (whitelist.length % 25 === 0) {
        fs.writeFileSync(OUTFILE, JSON.stringify(whitelist, null, 2));
        console.log(`  -> ${whitelist.length}/${TARGET} added (saved partial)`);
      }
    } catch (e) {
      // show first few failures so we can see what's up (if anything)
      if (whitelist.length < 3) {
        console.log(`fail ${t.symbol} ${t.mint} | ${String(e.message).slice(0, 220)}`);
      }
      if (isSkippable(e)) bad.add(t.mint);
    }

    // throttle to avoid 429
    await sleep(100 + Math.floor(Math.random() * 150));
  }

  fs.writeFileSync(OUTFILE, JSON.stringify(whitelist, null, 2));
  console.log(`Done. Saved ${whitelist.length} markets to ${OUTFILE}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
