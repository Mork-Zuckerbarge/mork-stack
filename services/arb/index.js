require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { enforceBbqGateOrExit, getWalletSnapshot } = require("./morkWalletSense");
const { morkWalletSnapshot, morkSignal } = require("./morkReporter");
const JUP_API_KEY = process.env.JUP_API_KEY;
const { morkMemory, morkTick, morkPing, morkArbEvent, morkGetPolicy } = require("./morkReporter");

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  AddressLookupTableAccount,
} = require("@solana/web3.js");

const { RPC_URL, LOOP_DELAY_MS, MIN_EDGE_PCT, MIN_ABS_PROFIT_USD } = require("./config");
const RPC_URLS = [
  ...new Set(
    String(process.env.SOLANA_RPC_URLS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .concat([RPC_URL])
  ),
];
let rpcCursor = 0;

function createRpcConnection(url) {
  return new Connection(url, {
    commitment: "processed",
    disableRetryOnRateLimit: true,
  });
}

let connection = createRpcConnection(RPC_URLS[rpcCursor]);

function rotateRpcConnection(reason = "rate_limit") {
  if (RPC_URLS.length <= 1) return connection.rpcEndpoint;
  rpcCursor = (rpcCursor + 1) % RPC_URLS.length;
  connection = createRpcConnection(RPC_URLS[rpcCursor]);
  const endpoint = connection.rpcEndpoint;
  console.log(`⚠️ Switched RPC endpoint (${reason}) -> ${endpoint}`);
  return endpoint;
}
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const FEE_SOL_MIN = Number(process.env.FEE_SOL_MIN || 0.03);
const FEE_SOL_TARGET = Number(process.env.FEE_SOL_TARGET || 0.08);
const FEE_CHECK_EVERY_MS = Number(process.env.FEE_CHECK_EVERY_MS || 300000);
const TOPUP_SLIPPAGE_BPS = Number(process.env.TOPUP_SLIPPAGE_BPS || 50);
const ARMED = process.env.ARMED === "true";
const CANDIDATE_WINDOW_MS = Number(process.env.CANDIDATE_WINDOW_MS || 10 * 60_000); // 10 minutes
const CANDIDATE_THRESHOLD = Number(process.env.CANDIDATE_THRESHOLD || 3);          // 3 hits in window
const candidateHits = new Map(); // mint -> [timestamps]
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const MIN_BBQ_REQUIRED = Number(process.env.MIN_BBQ_REQUIRED || 1000);
const PAPER = String(process.env.PAPER || "true").toLowerCase() === "true";
const MAX_TRADES_PER_HOUR = Number(process.env.MAX_TRADES_PER_HOUR || 6);
const MINT_COOLDOWN_MS = Number(process.env.MINT_COOLDOWN_MS || 180000);
const MAX_CONSECUTIVE_FAILS = Number(process.env.MAX_CONSECUTIVE_FAILS || 10);
const DAILY_LOSS_LIMIT_USD = Number(process.env.DAILY_LOSS_LIMIT_USD || 5);
const DAILY_PROFIT_TARGET_USD = Number(process.env.DAILY_PROFIT_TARGET_USD || 0);
const MIN_SOL_FOR_FEES = Number(process.env.MIN_SOL_FOR_FEES || 0.01);

const gov = {
  hourBucketStart: Date.now(),
  tradesThisHour: 0,
  consecutiveFails: 0,
  mintCooldownUntil: new Map(), // mint -> timestamp
  dayKey: new Date().toISOString().slice(0, 10),
  pnlTodayUsd: 0, // realized (or paper-realized)
};

function rotateGovernorWindows() {
  const now = Date.now();

  if (now - gov.hourBucketStart >= 60 * 60 * 1000) {
    gov.hourBucketStart = now;
    gov.tradesThisHour = 0;
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  if (dayKey !== gov.dayKey) {
    gov.dayKey = dayKey;
    gov.pnlTodayUsd = 0;
    gov.consecutiveFails = 0;
  }
}

async function riskAuthorize({ mint, symbol, spendUsd, netUsd, edgePct }, connection, walletPubkey) {
  rotateGovernorWindows();
  const now = Date.now();

  if (gov.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    return { ok: false, reason: `HALT: consecutiveFails=${gov.consecutiveFails} >= ${MAX_CONSECUTIVE_FAILS}` };
  }

  const cdUntil = gov.mintCooldownUntil.get(mint) || 0;
  if (now < cdUntil) {
    return { ok: false, reason: `Cooldown active for mint (wait ${Math.ceil((cdUntil - now) / 1000)}s)` };
  }

  if (gov.tradesThisHour >= MAX_TRADES_PER_HOUR) {
    return { ok: false, reason: `Rate limit: tradesThisHour=${gov.tradesThisHour} >= ${MAX_TRADES_PER_HOUR}` };
  }

  if (gov.pnlTodayUsd <= -Math.abs(DAILY_LOSS_LIMIT_USD)) {
    return { ok: false, reason: `Daily loss limit hit: pnlTodayUsd=${gov.pnlTodayUsd.toFixed(4)} <= -${Math.abs(DAILY_LOSS_LIMIT_USD)}` };
  }

  if (DAILY_PROFIT_TARGET_USD > 0 && gov.pnlTodayUsd >= DAILY_PROFIT_TARGET_USD) {
    return { ok: false, reason: `Daily profit target reached: pnlTodayUsd=${gov.pnlTodayUsd.toFixed(4)} >= ${DAILY_PROFIT_TARGET_USD}` };
  }

  const sol = (await connection.getBalance(walletPubkey)) / 1e9;
  if (sol < MIN_SOL_FOR_FEES) {
    return { ok: false, reason: `Not enough SOL for fees: SOL=${sol.toFixed(4)} < ${MIN_SOL_FOR_FEES}` };
  }

  return { ok: true };
}
function morkTradeDecision(payload) {
  return morkMemory({
    type: "fact",
    content: JSON.stringify({ kind: "trade_decision", ...payload }),
    entities: ["arb:trade_decision", payload.mint ? `mint:${payload.mint}` : "mint:unknown"],
    importance: 0.85,
    source: "arb",
  }).catch(() => {});
}

function morkTradeResult(payload) {
  return morkMemory({
    type: "fact",
    content: JSON.stringify({ kind: "trade_result", ...payload }),
    entities: ["arb:trade_result", payload.mint ? `mint:${payload.mint}` : "mint:unknown"],
    importance: 0.95,
    source: "arb",
  }).catch(() => {});
}

function morkRouteResearch(payload) {
  return morkMemory({
    type: "fact",
    content: JSON.stringify({ kind: "route_research", ...payload }),
    entities: [
      "arb:route_research",
      payload.mint ? `mint:${payload.mint}` : "mint:unknown",
      payload.symbol ? `symbol:${payload.symbol}` : "symbol:unknown",
    ],
    importance: 0.7,
    source: "arb",
  }).catch(() => {});
}

function recordTradeAttempt({ mint }) {
  rotateGovernorWindows();
  gov.tradesThisHour += 1;
  gov.mintCooldownUntil.set(mint, Date.now() + MINT_COOLDOWN_MS);
}

function recordTradeResult({ ok, realizedPnlUsd }) {
  rotateGovernorWindows();
  if (ok) {
    gov.consecutiveFails = 0;
    if (Number.isFinite(realizedPnlUsd)) gov.pnlTodayUsd += realizedPnlUsd;
  } else {
    gov.consecutiveFails += 1;
  }
}

const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

function tapLine(chunk) {
  try {
    let line = chunk;

    if (Buffer.isBuffer(line)) line = line.toString("utf8");
    line = String(line || "").trim();
    if (!line) return;

    if (line.length > 600) line = line.slice(0, 600) + "…";

   const isSignal =
     line.includes("➡️  CANDIDATE") ||
     line.includes("✅ TRADE SENT") ||
     line.includes("⛔ BLACKLIST") ||
     line.includes("FATAL") ||
     line.includes("ERROR");

    if (!isSignal) return;

   const importance =
    line.includes("✅ TRADE SENT") ? 0.95 :
    line.includes("➡️  CANDIDATE") ? 0.7 :
    line.includes("⛔ BLACKLIST") ? 0.5 :
    0.9; // errors/fatal

    morkMemory({
      type: "fact",
      content: line,
      entities: ["arb:logline"],
      importance,
      source: "arb",
    }).catch(() => {});
  } catch {}
}

const _stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, cb) => {
  tapLine(chunk);
  return _stdoutWrite(chunk, encoding, cb);
};

const _stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, cb) => {
  tapLine(chunk);
  return _stderrWrite(chunk, encoding, cb);
};

(async () => {
  const ok = await morkPing();
  console.log(`[morkReporter] core reachable: ${ok}`);

  morkMemory({
    type: "fact",
    content: `ARB BOT BOOT: ${new Date().toISOString()}`,
    entities: ["arb:boot"],
    importance: 0.7,
    source: "arb",
  }).catch(() => {});
})();

function jupHeaders(extra = {}) {
  const h = {
    Accept: "application/json",
    "User-Agent": "sol-arb-bot/0.1",
    ...(JUP_API_KEY ? { "x-api-key": JUP_API_KEY } : {}),
  };

  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) continue;
    h[k] = v;
  }
  return h;
}

async function getUsdcBalance(connection, ownerPubkey) {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    ownerPubkey,
    { mint: new PublicKey(USDC_MINT) }
  );
  return accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
}

function deserializeInstruction(ix) {
  if (!ix) return null;
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function getAddressLookupTableAccounts(connection, keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (unique.length === 0) return [];

  const infos = await connection.getMultipleAccountsInfo(
    unique.map((k) => new PublicKey(k))
  );

  const out = [];
  for (let i = 0; i < unique.length; i++) {
    const info = infos[i];
    if (!info) continue;
    out.push(
      new AddressLookupTableAccount({
        key: new PublicKey(unique[i]),
        state: AddressLookupTableAccount.deserialize(info.data),
      })
    );
  }
  return out;
}

async function getSwapInstructions(quoteResponse, userPublicKey) {
  const maxLamports = Number(process.env.PRIORITY_FEE_MAX_LAMPORTS || 5000);
  const priorityLevel = String(process.env.PRIORITY_FEE_LEVEL || "medium"); // low|medium|high|veryHigh

  const res = await fetchFn(`${JUP_BASE_URL}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: jupHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,

      // #2: Add priority fee guidance (helps CU pressure / busy blocks)
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel,
          maxLamports,
        },
      },
    }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Jupiter swap-instructions error: ${res.status} ${res.statusText}${body ? " | " + body : ""}`
    );
  }

  const json = JSON.parse(body);
  if (json?.error) throw new Error(`Failed to get swap instructions: ${json.error}`);
  return json;
}

async function sendV0Tx(connection, wallet, instructions, altAddresses) {
  const alts = await getAddressLookupTableAccounts(connection, altAddresses || []);
  const { blockhash } = await connection.getLatestBlockhash("processed");

  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(alts);

  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    commitment: "processed",
  });

  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const prettyErr = JSON.stringify(sim.value.err);

    console.log("🧾 Simulation logs:");
    for (const line of logs) console.log("   ", line);

    throw new Error(`Simulation failed: ${prettyErr}`);
  }

  return await connection.sendTransaction(tx, { maxRetries: 3 });
}

async function sendVersionedTx(connection, wallet, swapTxB64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  tx.sign([wallet]);

  const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);

  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  return sig;
}

async function ensureFeeBalance(connection, wallet) {
  const sol = (await connection.getBalance(wallet.publicKey)) / 1e9;
  if (sol >= FEE_SOL_MIN) return;

  const need = Math.max(0, FEE_SOL_TARGET - sol);
  console.log(`⚙️ Fee top-up needed. SOL=${sol.toFixed(4)}; targeting +${need.toFixed(4)} SOL`);

  const usdcBal = await getUsdcBalance(connection, wallet.publicKey);
  if (usdcBal <= 0.5) {
    console.log("⚠️ Not enough USDC to top up SOL fees.");
    return;
  }

  const inAmountUsdc = Math.min(5, usdcBal); // $5 cap for now
  const inUnits = BigInt(Math.floor(inAmountUsdc * 1e6));

  const quote = await getQuote(USDC_MINT, SOL_MINT, inUnits, TOPUP_SLIPPAGE_BPS);
  if (!quote) {
    console.log("⚠️ Could not quote USDC→SOL top-up.");
    return;
  }

  const outSol = Number(quote.outAmount) / 1e9;
  console.log(`↳ top-up quote: spend ~$${inAmountUsdc.toFixed(2)} USDC → ~${outSol.toFixed(4)} SOL`);

  if (!ARMED) {
    console.log("↳ dry-run top-up (ARMED=false)");
    return;
  }

  const ins = await getSwapInstructions(quote, wallet.publicKey.toBase58());

  const ixs = [];
  for (const ix of (ins.computeBudgetInstructions || [])) ixs.push(deserializeInstruction(ix));
  for (const ix of (ins.setupInstructions || [])) ixs.push(deserializeInstruction(ix));
  if (ins.tokenLedgerInstruction) ixs.push(deserializeInstruction(ins.tokenLedgerInstruction));
  ixs.push(deserializeInstruction(ins.swapInstruction));
  if (ins.cleanupInstruction) ixs.push(deserializeInstruction(ins.cleanupInstruction));

  const finalIxs = ixs.filter(Boolean);
  const sig = await sendV0Tx(connection, wallet, finalIxs, ins.addressLookupTableAddresses || []);
  console.log(`✅ fee top-up sent: ${sig}`);
}

const JUP_BASE_URL = process.env.JUP_BASE_URL || "https://api.jup.ag";
const QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

const USDC = {
  symbol: "USDC",
  mint: USDC_MINT,
  decimals: 6,
};

const TOKENS_CSV_URL =
  "https://raw.githubusercontent.com/igneous-labs/jup-token-list/main/validated-tokens.csv";
const TOKENS_CSV_CACHE = "tokens_validated.csv";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRpcRateLimitError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes('"code": 429') || msg.includes(" 429 ") || msg.includes("Too many requests");
}

async function withRetry(label, fn, { attempts = 4, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRpcRateLimitError(err) || i === attempts - 1) break;
      rotateRpcConnection(label);
      const waitMs = baseDelayMs * (i + 1) ** 2 + Math.floor(Math.random() * 250);
      console.log(`⚠️ ${label} rate-limited (attempt ${i + 1}/${attempts}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const WALLET_PATH = process.env.WALLET_PATH;
const DEFAULT_PAPER_MAX_TRADE_USDC = Number(process.env.DEFAULT_PAPER_MAX_TRADE_USDC || 5);
const MAX_TRADE_USDC = Number(process.env.MAX_TRADE_USDC || 0);
const WALLET_SECRET_KEY = process.env.MORK_WALLET_SECRET_KEY;

function parseSecretKey(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "number")) return null;
    return Uint8Array.from(parsed);
  } catch {
    return null;
  }
}

function loadKeypair() {
  if (WALLET_PATH) {
    const secret = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }

  if (WALLET_SECRET_KEY) {
    const secret = parseSecretKey(WALLET_SECRET_KEY);
    if (!secret) {
      throw new Error("Invalid MORK_WALLET_SECRET_KEY (must be a JSON array of bytes)");
    }
    return Keypair.fromSecretKey(secret);
  }

  throw new Error("Wallet not configured. Set WALLET_PATH or MORK_WALLET_SECRET_KEY.");
}

function resolveWalletSource() {
  if (WALLET_PATH) return `WALLET_PATH=${WALLET_PATH}`;
  if (WALLET_SECRET_KEY) return "MORK_WALLET_SECRET_KEY";
  return "none";
}

const wallet = loadKeypair();
console.log("Bot wallet:", wallet.publicKey.toBase58());
console.log("Wallet source:", resolveWalletSource());
console.log("ARMED:", ARMED);

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

const DEFAULT_WHITELIST = [
  {
    symbol: "SOL/USDC",
    inMint: SOL_MINT,
    inDecimals: 9,
    outMint: USDC_MINT,
    outDecimals: 6,
    probeUsd: 25,
  },
];

function loadWhitelist(file = "whitelist.json") {
  const absolutePath = path.isAbsolute(file) ? file : path.join(__dirname, file);

  if (!fs.existsSync(absolutePath)) {
    console.log(
      `⚠️ whitelist file missing at ${absolutePath}. Falling back to built-in starter whitelist (${DEFAULT_WHITELIST.length} market).`
    );
    return DEFAULT_WHITELIST;
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const markets = JSON.parse(raw);

  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error(`Whitelist is empty or invalid: ${absolutePath}`);
  }
  return markets;
}

function isRoutePlanNotConsumeAllAmountError(err) {
  const msg = String(err?.message || "");
  return msg.includes("ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT");
}

function isTokenNotTradableError(err) {
  const msg = String(err?.message || "");
  return msg.includes("TOKEN_NOT_TRADABLE");
}

function isNoRouteError(err) {
  const msg = String(err?.message || "");
  return msg.includes("NO_ROUTES_FOUND") || msg.includes("COULD_NOT_FIND_ANY_ROUTE");
}

function isTooSmallAmountError(err) {
  const msg = String(err?.message || "");
  return msg.includes("CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD");
}

function isSkippableJupError(err) {
  return (
    isTokenNotTradableError(err) ||
    isNoRouteError(err) ||
    isTooSmallAmountError(err) ||
    isRoutePlanNotConsumeAllAmountError(err)
  );
}

async function printBalances(connection, walletPubkey) {
  const solLamports = await connection.getBalance(walletPubkey);
  console.log("SOL balance:", solLamports / 1e9);

  const usdcMintPk = new PublicKey(USDC_MINT);
  const accounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
    mint: usdcMintPk,
  });

  const usdc =
    accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

  console.log("USDC balance:", usdc);
}

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 50);
const EXECUTION_BUFFER_USD = Number(process.env.EXECUTION_BUFFER_USD || 0.03);
function getEffectiveMaxTradeUsdc() {
  const configuredMaxTrade = Number(process.env.MAX_TRADE_USDC || 0);
  return configuredMaxTrade > 0 ? configuredMaxTrade : (PAPER ? DEFAULT_PAPER_MAX_TRADE_USDC : 0);
}

function filterTokens(tokens) {
  const filtered = (tokens || []).filter((t) => {
    if (!t?.address || !t?.symbol || typeof t.decimals !== "number") return false;
    if (t.symbol.length > 10) return false;
    if (t.address === USDC.mint) return false;
    return true;
  });

  filtered.sort((a, b) => a.symbol.length - b.symbol.length);
  return filtered;
}

async function scanMarketA(m) {
  const maxTrade = getEffectiveMaxTradeUsdc();
  if (!maxTrade || maxTrade <= 0) return null;

  const TX_COST_USD = Number(process.env.TX_COST_USD || 0.01);
  const MIN_NET = Number(process.env.MIN_NET_PROFIT_USD || 0.02);

  const spendUsd = Math.min(Number(m.probeUsd || 5), maxTrade);
  const inUsdcUnits = BigInt(Math.floor(spendUsd * 1e6));
  if (inUsdcUnits <= 0n) return null;

  let q1;
  try {
    q1 = await getQuote(USDC_MINT, m.inMint, inUsdcUnits, SLIPPAGE_BPS);
  } catch (e) {
    if (isSkippableJupError(e)) return null;
    throw e;
  }
  if (!q1?.outAmount) return null;

  const tokenOutUnits = BigInt(q1.outAmount);
  if (tokenOutUnits <= 0n) return null;

  let q2;
  try {
    q2 = await getQuote(m.inMint, USDC_MINT, tokenOutUnits, SLIPPAGE_BPS);
  } catch (e) {
    if (isSkippableJupError(e)) return null;
    throw e;
  }
  if (!q2?.outAmount) return null;

  const outUsdc = Number(q2.outAmount) / 1e6;
  const gross = outUsdc - spendUsd;
  const net = gross - TX_COST_USD;
  const edgePct = (gross / spendUsd) * 100;

  const good = net >= MIN_NET && edgePct >= MIN_EDGE_PCT;

  return {
    good,
    edgePct,
    usdNotional: spendUsd,
    approxUsdProfit: gross,
    netUsdProfit: net,
    spendUsd,
  };
}

async function getQuote(inputMint, outputMint, amount, slippageBps = SLIPPAGE_BPS) {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", String(slippageBps));
  const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 24);
  url.searchParams.set("maxAccounts", String(MAX_ACCOUNTS));

  await sleep(80 + Math.floor(Math.random() * 180));

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchFn(url.toString(), {
      method: "GET",
      headers: jupHeaders({ "Content-Type": undefined }), // GET doesn't need JSON content-type
    });

    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Number(ra) * 1000 : 900 * (attempt + 1) ** 2;
      await sleep(waitMs + Math.floor(Math.random() * 250));
      continue;
    }

    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(
        `Jupiter quote error: ${res.status} ${res.statusText}${bodyText ? " | " + bodyText : ""}`
      );
    }

    const json = bodyText ? JSON.parse(bodyText) : null;
    if (!json || !json.outAmount || !json.inAmount) return null;
    return json;
  }

  throw new Error("Jupiter quote error: 429 Too Many Requests (gave up after retries)");
}

async function loadStrictTokens() {
  let text;

  if (fs.existsSync(TOKENS_CSV_CACHE)) {
    text = fs.readFileSync(TOKENS_CSV_CACHE, "utf8");
  } else {
    const res = await fetchFn(TOKENS_CSV_URL, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`Token list error: ${res.status} ${res.statusText}`);
    text = await res.text();
    fs.writeFileSync(TOKENS_CSV_CACHE, text);
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const tokens = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 4) continue;

    const name = cols[0];
    const symbol = cols[1];
    const address = cols[2];
    const decimals = Number(cols[3]);

    if (!symbol || !address || !Number.isFinite(decimals)) continue;
    tokens.push({ name, symbol, address, decimals });
  }

  return filterTokens(tokens);
}

function buildWatchlistTop200(tokens) {
  const top = tokens.slice(0, 200);
  const PROBE_USD = 25;

  return top.map((t) => ({
    symbol: `${t.symbol}/USDC`,
    inMint: t.address,
    inDecimals: t.decimals,
    outMint: USDC.mint,
    outDecimals: USDC.decimals,
    probeUsd: PROBE_USD,
  }));
}

async function scanMarket(m) {
  const MIN_BASE_UNITS = BigInt(1_000_000);

  const probeDecimals = Math.min(6, m.inDecimals);
  const probeCandidate = BigInt(10) ** BigInt(probeDecimals);
  const probeIn = probeCandidate < MIN_BASE_UNITS ? MIN_BASE_UNITS : probeCandidate;

  let q1;
  try {
    q1 = await getQuote(m.inMint, m.outMint, probeIn, SLIPPAGE_BPS);
  } catch (e) {
    if (isSkippableJupError(e)) return null;
    throw e;
  }
  if (!q1) return null;

  const probeOutUSDC = Number(q1.outAmount) / 10 ** m.outDecimals;
  const probeInTok = Number(q1.inAmount) / 10 ** m.inDecimals;
  if (probeInTok <= 0) return null;

  const approxPriceUsd = probeOutUSDC / probeInTok;
  if (!isFinite(approxPriceUsd) || approxPriceUsd <= 0) return null;

  const targetTok = m.probeUsd / approxPriceUsd;
  const computedIn = BigInt(Math.floor(targetTok * 10 ** m.inDecimals));
  const inUnits = computedIn < MIN_BASE_UNITS ? MIN_BASE_UNITS : computedIn;

  let fwd;
  try {
    fwd = await getQuote(m.inMint, m.outMint, inUnits, SLIPPAGE_BPS);
  } catch (e) {
    if (isRoutePlanNotConsumeAllAmountError(e)) {
      const smaller = inUnits / 2n;
      if (smaller > 0n) fwd = await getQuote(m.inMint, m.outMint, smaller, SLIPPAGE_BPS);
      else return null;
    } else if (isSkippableJupError(e)) {
      return null;
    } else {
      throw e;
    }
  }
  if (!fwd) return null;

  const usdcUnits = BigInt(fwd.outAmount);

  let back;
  try {
    back = await getQuote(m.outMint, m.inMint, usdcUnits, SLIPPAGE_BPS);
  } catch (e) {
    if (isSkippableJupError(e)) return null;
    throw e;
  }
  if (!back) return null;

  const startTok = Number(inUnits) / 10 ** m.inDecimals;
  const endTok = Number(back.outAmount) / 10 ** m.inDecimals;

  if (!isFinite(startTok) || startTok <= 0) return null;
  if (!isFinite(endTok) || endTok <= 0) return null;

  const edgePct = ((endTok - startTok) / startTok) * 100;
  const usdNotional = Number(usdcUnits) / 10 ** m.outDecimals;

  const approxUsdProfit = (endTok - startTok) * approxPriceUsd;

  const TX_COST_USD = Number(process.env.TX_COST_USD || 0.01);
  const MIN_NET_PROFIT_USD = Number(process.env.MIN_NET_PROFIT_USD || 0.02);

  const netUsdProfit = approxUsdProfit - TX_COST_USD;
  const good = netUsdProfit > MIN_NET_PROFIT_USD && edgePct > MIN_EDGE_PCT;

  return { good, edgePct, usdNotional, approxUsdProfit, netUsdProfit };
}

async function executeRouteA(m, scan) {
  // defined out here so catch() can reference them safely
  let spendUsd = 0;
  let net = NaN;
  let edgePct = NaN;

  try {
    if (!PAPER && !ARMED) return { ok: false, dryRun: true, reason: "ARMED=false (live disabled)" };

    const sol = (await connection.getBalance(wallet.publicKey)) / 1e9;
    if (sol < 0.005) {
      return { ok: false, reason: `Not enough SOL for fees (SOL=${sol.toFixed(4)})` };
    }

    const usdcBal = await getUsdcBalance(connection, wallet.publicKey);
    if (usdcBal <= 0) return { ok: false, reason: "No USDC balance" };

    const maxTrade = getEffectiveMaxTradeUsdc();
    if (!maxTrade || maxTrade <= 0) {
      return { ok: false, reason: `MAX_TRADE_USDC is 0 or invalid (${process.env.MAX_TRADE_USDC})` };
    }

    spendUsd = Math.min(usdcBal, maxTrade);
    if (spendUsd <= 0.01) {
      return { ok: false, reason: `Spend too small (spendUsd=${spendUsd})` };
    }

    const TX_COST_USD = Number(process.env.TX_COST_USD || 0.01);
    const MIN_NET = Number(process.env.MIN_NET_PROFIT_USD || 0.01);

    // optional pre-exec gate using the scan estimate
    const scanNet = Number(scan?.netUsdProfit);
    if (Number.isFinite(scanNet)) {
      const need = MIN_NET + Number(EXECUTION_BUFFER_USD || 0);
      if (scanNet < need) {
        return {
          ok: false,
          reason: `Pre-exec gate: scan net too small (scan≈$${scanNet.toFixed(4)}, need≥$${need.toFixed(4)})`,
        };
      }
    }

    // fresh quotes at execution time
    const inUsdcUnits = BigInt(Math.floor(spendUsd * 1e6));
    const q1 = await getQuote(USDC_MINT, m.inMint, inUsdcUnits, SLIPPAGE_BPS);
    if (!q1?.outAmount) return { ok: false, reason: "No quote (USDC→token)" };

    const tokenOutUnits = BigInt(q1.outAmount);
    if (tokenOutUnits <= 0n) return { ok: false, reason: "USDC→token outAmount=0" };

    const q2 = await getQuote(m.inMint, USDC_MINT, tokenOutUnits, SLIPPAGE_BPS);
    if (!q2?.outAmount) return { ok: false, reason: "No quote (token→USDC)" };

    const outUsdc = Number(q2.outAmount) / 1e6;
    const gross = outUsdc - spendUsd;
    net = gross - TX_COST_USD;
    edgePct = (gross / spendUsd) * 100;

    if (!Number.isFinite(net)) return { ok: false, reason: "Net calc invalid" };
    if (net < MIN_NET) {
      return {
        ok: false,
        reason: `Net profit too small after fresh quote (net≈$${net.toFixed(4)}, min=$${MIN_NET.toFixed(4)})`,
      };
    }

    // build + send instructions
    const ins1 = await getSwapInstructions(q1, wallet.publicKey.toBase58());
    const ins2 = await getSwapInstructions(q2, wallet.publicKey.toBase58());

    const ixs = [];

    // include compute budget only once
    for (const ix of (ins1.computeBudgetInstructions || [])) ixs.push(deserializeInstruction(ix));

    for (const ix of (ins1.setupInstructions || [])) ixs.push(deserializeInstruction(ix));
    if (ins1.tokenLedgerInstruction) ixs.push(deserializeInstruction(ins1.tokenLedgerInstruction));
    ixs.push(deserializeInstruction(ins1.swapInstruction));

    for (const ix of (ins2.setupInstructions || [])) ixs.push(deserializeInstruction(ix));
    if (ins2.tokenLedgerInstruction) ixs.push(deserializeInstruction(ins2.tokenLedgerInstruction));
    ixs.push(deserializeInstruction(ins2.swapInstruction));

    if (ins2.cleanupInstruction) ixs.push(deserializeInstruction(ins2.cleanupInstruction));
    else if (ins1.cleanupInstruction) ixs.push(deserializeInstruction(ins1.cleanupInstruction));

    const finalIxs = ixs.filter(Boolean);

    // dedupe ALT keys
    const altKeys = Array.from(
      new Set(
        [
          ...(ins1.addressLookupTableAddresses || []),
          ...(ins2.addressLookupTableAddresses || []),
        ].filter(Boolean)
      )
    );

    if (PAPER) {
      const sig = `paper-${Date.now()}`;
      return { ok: true, sig, spendUsd, net, edgePct, dryRun: true };
    }

    const sig = await sendV0Tx(connection, wallet, finalIxs, altKeys);
    return { ok: true, sig, spendUsd, net, edgePct, dryRun: false };
  } catch (e) {
    const msg = String(e?.message || e);

    // optional: safe logging hooks (won't crash if missing)
    try { recordTradeResult?.({ ok: false, realizedPnlUsd: 0 }); } catch {}
    try {
      morkTradeResult?.({
        ts: Date.now(),
        wallet: wallet.publicKey.toBase58(),
        symbol: m?.symbol,
        mint: m?.inMint,
        mode: (typeof PAPER !== "undefined" && PAPER) ? "paper" : "live",
        ok: false,
        sig: null,
        error: msg,
        spendUsd,
        netUsd: Number.isFinite(net) ? net : undefined,
        edgePct: Number.isFinite(edgePct) ? edgePct : undefined,
        gov: {
          pnlTodayUsd: gov?.pnlTodayUsd,
          tradesThisHour: gov?.tradesThisHour,
          consecutiveFails: gov?.consecutiveFails,
        },
      });
    } catch {}

    const looksLikeJup6024 =
      msg.includes('Custom":6024') ||
      msg.includes("0x1788") ||
      msg.includes("custom program error: 0x1788");

    const looksLikeSlippage =
      msg.includes('Custom":6001') ||
      msg.toLowerCase().includes("slippage") ||
      msg.toLowerCase().includes("exceeded cu") ||
      msg.includes("ProgramFailedToComplete");

    const looksLikeEncodingOverrun =
      msg.toLowerCase().includes("encoding overruns uint8array") ||
      msg.toLowerCase().includes("rangeerror") ||
      msg.toLowerCase().includes("failed to serialize");

    return {
      ok: false,
      reason: `executeRouteA exception: ${msg}`,
      blacklist: looksLikeJup6024 || looksLikeSlippage || looksLikeEncodingOverrun,
    };
  }
}

async function getWalletSnapshotFull(connection, walletPubkey, { topN = 999 } = {}) {
  const meta = loadTokenMetaByMint();

  const sol = (await connection.getBalance(walletPubkey)) / 1e9;

  const tokensParsed = await connection.getParsedTokenAccountsByOwner(
    walletPubkey,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
  );

  const tokens = tokensParsed.value
    .map((acc) => {
      const info = acc.account?.data?.parsed?.info;
      const mint = info?.mint;
      const uiAmount = info?.tokenAmount?.uiAmount ?? 0;
      const decimals = info?.tokenAmount?.decimals ?? meta.get(mint)?.decimals ?? null;

      const m = meta.get(mint);
      return {
        mint,
        symbol: m?.symbol || (mint ? mint.slice(0, 4) + "…" + mint.slice(-4) : "UNKNOWN"),
        name: m?.name || "",
        decimals,
        uiAmount,
      };
    })
    .filter((t) => t.mint && t.uiAmount && t.uiAmount > 0)
    .sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0))
    .slice(0, topN);

  return { wallet: walletPubkey.toBase58(), sol, tokens, ts: new Date().toISOString() };
}

function printWalletSnapshot(snap) {
  console.log(`👛 Wallet: ${snap.wallet}`);
  console.log(`   SOL: ${snap.sol.toFixed(6)}`);

  if (!snap.tokens?.length) {
    console.log("   (no SPL tokens with balance)");
    return;
  }

  console.log("   Tokens:");
  for (const t of snap.tokens) {
    const amt =
      typeof t.uiAmount === "number"
        ? (t.uiAmount >= 1 ? t.uiAmount.toFixed(6) : t.uiAmount.toPrecision(6))
        : String(t.uiAmount);

    console.log(`   - ${t.symbol.padEnd(10)} ${amt}   (${t.mint})`);
  }
}

function bbqBalanceFromSnapshot(snap) {
  const found = (snap?.tokens || []).find((t) => t?.mint === BBQ_MINT);
  return Number(found?.uiAmount || 0);
}


async function pushWalletSnapshotToMork(snap) {
  try {
    if (!snap) return;

    const top = (snap.tokens || []).slice(0, 15);
    const walletAddr =
      snap.wallet || snap.address || snap.pubkey || (snap.walletPubkey?.toBase58?.() ?? "unknown");

    await morkMemory({
      type: "fact",
      content: JSON.stringify({
        kind: "wallet_snapshot",
        wallet: walletAddr,
        ts: snap.ts || new Date().toISOString(),
        sol: snap.sol,
        usdc: snap.usdc,
        bbq: snap.bbq,
        tokens: top.map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          uiAmount: t.uiAmount,
        })),
      }),
      entities: ["arb:wallet_snapshot", `wallet:${walletAddr}`],
      importance: 0.9,
      source: "arb",
    });

    morkTick("wallet_snapshot").catch(() => {});
  } catch {

  }
}

function recordCandidateHit(mint) {
  const now = Date.now();
  const arr = candidateHits.get(mint) || [];
  arr.push(now);

  const pruned = arr.filter((t) => now - t <= CANDIDATE_WINDOW_MS);
  candidateHits.set(mint, pruned);

  return pruned.length;
}

let _tokenMetaByMint = null;

function loadTokenMetaByMint() {
  if (_tokenMetaByMint) return _tokenMetaByMint;

  const map = new Map();
  try {
    if (!fs.existsSync(TOKENS_CSV_CACHE)) {
      _tokenMetaByMint = map;
      return map;
    }

    const text = fs.readFileSync(TOKENS_CSV_CACHE, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 4) continue;
      const name = cols[0];
      const symbol = cols[1];
      const address = cols[2];
      const decimals = Number(cols[3]);
      if (!address) continue;
      map.set(address, { name, symbol, decimals });
    }
  } catch {

  }

  _tokenMetaByMint = map;
  return map;
}

async function sendWalletSnapshotToMork(snap) {
  try {
    if (!snap) return false;

    // keep it bounded so memory doesn't blow up
    const top = (snap.tokens || []).slice(0, 25);

    await morkMemory({
      type: "fact",
      content: JSON.stringify({
        kind: "wallet_snapshot",
        wallet: snap.wallet,
        ts: snap.ts,
        sol: snap.sol,
        tokens: top.map((t) => ({
          mint: t.mint,
          symbol: t.symbol,
          uiAmount: t.uiAmount,
        })),
      }),
      entities: ["arb:wallet_snapshot", `wallet:${snap.wallet}`],
      importance: 0.95,
      source: "arb",
    });

    morkTick("wallet_snapshot").catch(() => {});
    return true;
  } catch {
    return false; // fail-soft
  }
}

async function main() {
  console.log("RPC pool:", RPC_URLS.join(", "));
  console.log("RPC active:", connection.rpcEndpoint);
  console.log("Cluster:", await withRetry("getVersion", () => connection.getVersion()));

  console.log("Checking bot wallet balances...");
  const bootSnap = await withRetry("boot wallet snapshot", () =>
    getWalletSnapshotFull(connection, wallet.publicKey, { topN: 999 })
  );
  printWalletSnapshot(bootSnap);

  sendWalletSnapshotToMork(bootSnap)
  .then((ok) => console.log(`[morkReporter] boot wallet_snapshot sent=${ok}`))
  .catch((e) => console.log(`[morkReporter] boot wallet_snapshot error: ${e.message}`));

  console.log("ENV ARMED =", process.env.ARMED);
  console.log("ARMED (parsed) =", ARMED);
  console.log("PAPER =", PAPER);
  console.log("MAX_TRADE_USDC =", MAX_TRADE_USDC);
  console.log("DEFAULT_PAPER_MAX_TRADE_USDC =", DEFAULT_PAPER_MAX_TRADE_USDC);
  console.log("EFFECTIVE_MAX_TRADE_USDC =", getEffectiveMaxTradeUsdc());
  console.log("────────────────────────────────\n");

  let lastFeeCheck = 0;
  let lastBalanceCheck = 0;

  console.log("Loading whitelist.json...");
  const markets = loadWhitelist("whitelist.json");
  console.log(`Loaded whitelist: ${markets.length} markets`);
  console.log("Scanning Jupiter quotes in batches... (Ctrl+C to stop)\n");

  const blacklist = new Set();
  const BATCH_SIZE = Math.max(1, Number(process.env.SCAN_BATCH_SIZE || 2));
  let cursor = 0;
  const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 12000);
  const HEARTBEAT_EVERY = Number(process.env.HEARTBEAT_EVERY_LOOPS || 10);
  let loopCount = 0;

  const BALANCE_CHECK_EVERY_MS = Number(process.env.BALANCE_CHECK_EVERY_MS || 600000);

  while (true) {
    loopCount += 1;
    if (Date.now() - lastFeeCheck > FEE_CHECK_EVERY_MS) {
      lastFeeCheck = Date.now();
      try {
        await withRetry("ensureFeeBalance", () => ensureFeeBalance(connection, wallet));
      } catch (e) {
        console.log(`⚠ Fee upkeep error: ${e.message}`);
      }
    }

    if (Date.now() - lastBalanceCheck > BALANCE_CHECK_EVERY_MS) {
      lastBalanceCheck = Date.now();

      try {
        console.log("\n🔎 Balance check:");
        const snap = await withRetry("periodic wallet snapshot", () =>
          getWalletSnapshotFull(connection, wallet.publicKey, { topN: 999 })
        );
        printWalletSnapshot(snap);

        // ⛔ gate (your BBQ rule) — keep this where it belongs
        const knownBbqBalance = bbqBalanceFromSnapshot(snap);
        const bbqBal = await withRetry("BBQ gate", () =>
          enforceBbqGateOrExit(connection, wallet.publicKey, { knownBbqBalance })
        );
        console.log(`✅ BBQ gate passed. BBQ=${Number(bbqBal).toFixed(6)}`);

        sendWalletSnapshotToMork(snap)
          .then((ok) => console.log(`[morkReporter] wallet_snapshot sent=${ok}`))
          .catch((e) => console.log(`[morkReporter] wallet_snapshot error: ${e.message}`));

        console.log("────────────────────────────────\n");
      } catch (e) {
        console.log(`⚠ Balance check error: ${e.message}`);
      }
    }

    const batch = [];
    const startCursor = cursor;
    for (let i = 0; i < BATCH_SIZE; i++) {
      batch.push(markets[(cursor + i) % markets.length]);
    }
    cursor = (cursor + BATCH_SIZE) % markets.length;

    for (const m of batch) {
      if (!m?.inMint || blacklist.has(m.inMint)) continue;

      let scan = null;
      try {
        scan = await Promise.race([
          scanMarketA(m),
          sleep(SCAN_TIMEOUT_MS).then(() => ({ __timedOut: true })),
        ]);
      } catch (e) {
        if (isSkippableJupError(e)) continue;
        if (isRpcRateLimitError(e)) {
          console.log(`⚠️ scan rate-limited for ${m.symbol || m.inMint}: ${e.message}`);
          continue;
        }
        console.log(`⚠️ scan error ${m.symbol || m.inMint}: ${e.message}`);
        continue;
      }

      if (scan?.__timedOut) {
        console.log(`⏱️ scan timeout ${m.symbol || m.inMint} after ${SCAN_TIMEOUT_MS}ms`);
        continue;
      }
      if (!scan || !scan.good) continue;

      const hits = recordCandidateHit(m.inMint);
      console.log(
        `➡️  CANDIDATE ${m.symbol || m.inMint} edge=${scan.edgePct.toFixed(3)}% net≈$${scan.netUsdProfit.toFixed(4)} hits=${hits}/${CANDIDATE_THRESHOLD}`
      );
      morkRouteResearch({
        stage: "candidate",
        mint: m.inMint,
        symbol: m.symbol || m.inMint,
        edgePct: scan.edgePct,
        netUsd: scan.netUsdProfit,
        hits,
        threshold: CANDIDATE_THRESHOLD,
        armed: ARMED,
        paper: PAPER,
      });

      if (hits < CANDIDATE_THRESHOLD) continue;

      const gate = await riskAuthorize(
        {
          mint: m.inMint,
          symbol: m.symbol || m.inMint,
          spendUsd: scan.spendUsd || scan.usdNotional || 0,
          netUsd: scan.netUsdProfit || 0,
          edgePct: scan.edgePct || 0,
        },
        connection,
        wallet.publicKey
      );

      if (!gate.ok) {
        console.log(`⛔ RISK BLOCK ${m.symbol || m.inMint}: ${gate.reason}`);
        morkRouteResearch({
          stage: "risk_block",
          mint: m.inMint,
          symbol: m.symbol || m.inMint,
          edgePct: scan.edgePct,
          netUsd: scan.netUsdProfit,
          gateReason: gate.reason,
          armed: ARMED,
          paper: PAPER,
        });
        continue;
      }

      recordTradeAttempt({ mint: m.inMint });
      const exec = await executeRouteA(m, scan);
      if (exec.ok) {
        recordTradeResult({ ok: true, realizedPnlUsd: Number(exec.net) || 0 });
        console.log(`✅ TRADE SENT ${m.symbol || m.inMint} sig=${exec.sig} net≈$${Number(exec.net || 0).toFixed(4)}`);
        morkRouteResearch({
          stage: "executed",
          mint: m.inMint,
          symbol: m.symbol || m.inMint,
          edgePct: scan.edgePct,
          netUsd: scan.netUsdProfit,
          signature: exec.sig || null,
          armed: ARMED,
          paper: PAPER,
        });
      } else {
        recordTradeResult({ ok: false, realizedPnlUsd: 0 });
        console.log(`⚠ TRADE SKIP ${m.symbol || m.inMint}: ${exec.reason || "unknown reason"}`);
        morkRouteResearch({
          stage: "execution_skip",
          mint: m.inMint,
          symbol: m.symbol || m.inMint,
          edgePct: scan.edgePct,
          netUsd: scan.netUsdProfit,
          reason: exec.reason || "unknown reason",
          blacklist: !!exec.blacklist,
          armed: ARMED,
          paper: PAPER,
        });
        if (exec.blacklist) {
          blacklist.add(m.inMint);
          console.log(`⛔ BLACKLIST ${m.symbol || m.inMint} due to repeated execution errors`);
        }
      }
    }

    if (loopCount % HEARTBEAT_EVERY === 0) {
      console.log(
        `💓 heartbeat loops=${loopCount} cursor=${startCursor}->${cursor} batch=${batch.length} blacklist=${blacklist.size}`
      );
    }

    await sleep(LOOP_DELAY_MS ?? 15000);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
