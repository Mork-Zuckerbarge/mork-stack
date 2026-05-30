import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { ollama } from "@/lib/core/ollama";
import { POST as executeSwapRoute } from "@/app/api/trade/swap/route";
import { APP_DEFAULTS, BBQ_TOKEN } from "@/lib/core/defaults";
import { createSolanaConnection } from "@/lib/core/solanaRpc";

export const runtime = "nodejs";

const LAST_PLANNER_TRADE_KEY = "__planner_last_trade_iso_v1__";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALL_ALLOWLIST_SENTINEL = "ALL";
const STARTUP_ALLOWLIST_LIMIT = 5000;
const FALLBACK_TOKEN_CSV =
  "https://raw.githubusercontent.com/igneous-labs/jup-token-list/main/validated-tokens.csv";
const numberFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const JUP_BASE = process.env.JUP_BASE_URL || APP_DEFAULTS.jupiterBaseUrl;
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || APP_DEFAULTS.solanaRpcUrl;
// Keep planner sizing aligned with /api/trade/swap guard default.
// If env is unset/invalid, swap route enforces 0.25 SOL max.
const AGENT_SWAP_MAX_SOL = numberFromEnv(process.env.MORK_AGENT_SWAP_MAX_SOL, 0.25);
// Hard economics floor for autonomous buys: never spend dust where fees dominate notional.
const AGENT_MIN_TRADE_USD = numberFromEnv(process.env.MORK_AGENT_MIN_TRADE_USD, 1);
const ESTIMATED_SWAP_FEE_SOL = numberFromEnv(process.env.MORK_ESTIMATED_SWAP_FEE_SOL, 0.00001);
const MIN_TRADE_FEE_MULTIPLE = numberFromEnv(process.env.MORK_AGENT_MIN_TRADE_FEE_MULTIPLE, 50);
const COST_BASIS_KEY_PREFIX = "planner_cost_basis:";
// Minimum profit % to trigger a sell (e.g. 5 = 5%). Override via env.
const SELL_PROFIT_THRESHOLD = numberFromEnv(process.env.MORK_SELL_PROFIT_THRESHOLD_PCT, 5) / 100;
// Minimum estimated SOL value to bother selling (skip dust positions).
const MIN_SELL_SOL = 0.0001;

type StrategySnapshot = {
  minImbalancePct: number | null;
  minNetProfitSol: number | null;
  enableTriangularRoutes: boolean | null;
  routeVia: string | null;
  entryVolSpikeMultiplier: number | null;
  exitTrailingStopPct: number | null;
  maxHoldMinutes: number | null;
  hardStopLossPct: number | null;
};


function normalizeMintList(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const mint = (value || "").trim();
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
    if (out.length >= limit) break;
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "\"" && next === "\"") {
      cur += "\"";
      i += 1;
      continue;
    }
    if (ch === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function pickHeaderIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map((item) => item.toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

function readWhitelistMints(limit: number): string[] {
  const whitelistPath = path.resolve(process.cwd(), "../services/arb/whitelist.json");
  if (!fs.existsSync(whitelistPath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return normalizeMintList(
      parsed.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") return item.inMint;
        return "";
      }),
      limit,
    );
  } catch {
    return [];
  }
}

async function fetchFallbackMints(limit: number): Promise<string[]> {
  try {
    const response = await fetch(FALLBACK_TOKEN_CSV, { headers: { accept: "text/plain" }, cache: "no-store" });
    if (!response.ok) return [];
    const csv = await response.text();
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    const mintIdx = pickHeaderIndex(headers, ["address", "mint", "mintaddress", "token_address"]);
    if (mintIdx < 0) return [];
    return normalizeMintList(lines.slice(1).map((line) => parseCsvLine(line)[mintIdx] || ""), limit);
  } catch {
    return [];
  }
}

async function resolvePlannerAllowlist(configuredAllowlist: string[]): Promise<string[]> {
  const cleaned = normalizeMintList(configuredAllowlist, STARTUP_ALLOWLIST_LIMIT);
  const allSelected = cleaned.length === 0 || cleaned.some((mint) => mint.toUpperCase() === ALL_ALLOWLIST_SENTINEL);
  if (!allSelected) return cleaned.filter((mint) => mint !== SOL_MINT && mint !== USDC_MINT);

  const policyRows = await prisma.arbPolicy.findMany({
    take: STARTUP_ALLOWLIST_LIMIT,
    orderBy: { updatedAt: "desc" },
    select: { mint: true },
  });
  const policyMints = policyRows.map((row) => row.mint);
  const diskMints = readWhitelistMints(STARTUP_ALLOWLIST_LIMIT);
  const fallbackMints = await fetchFallbackMints(STARTUP_ALLOWLIST_LIMIT);
  return normalizeMintList([...policyMints, ...diskMints, ...fallbackMints, BBQ_TOKEN.mint], STARTUP_ALLOWLIST_LIMIT)
    .filter((mint) => mint !== SOL_MINT && mint !== USDC_MINT);
}

function toSellableHolding(holding: TokenHolding): TokenHolding | null {
  if (!BBQ_TOKEN.mint || holding.mint !== BBQ_TOKEN.mint) return holding;
  const surplusUiAmount = holding.uiAmount - BBQ_TOKEN.requiredBalance;
  if (surplusUiAmount <= 0) return null;
  const sellableUiAmount = surplusUiAmount * BBQ_TOKEN.maxSellSurplusPct;
  const rawAmount = Math.floor(sellableUiAmount * 10 ** holding.decimals);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return null;
  return { ...holding, uiAmount: sellableUiAmount, rawAmount: String(rawAmount) };
}

// ── Wallet / token helpers ──────────────────────────────────────────────────

function getPlannerKeypair(): Keypair | null {
  try {
    const raw = process.env.MORK_WALLET_SECRET_KEY?.trim();
    if (!raw) return null;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
  } catch { return null; }
}

type TokenHolding = { mint: string; uiAmount: number; rawAmount: string; decimals: number };

async function getHeldTokens(connection: Connection, owner: PublicKey, mintFilter?: Set<string>): Promise<TokenHolding[]> {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });
    return res.value
      .map((a) => {
        const info = (a.account?.data as unknown as { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number; amount?: string; decimals?: number } } } } | undefined)?.parsed?.info;
        const mint = info?.mint;
        if (!mint) return null;
        if (mintFilter && mintFilter.size > 0 && !mintFilter.has(mint)) return null;
        const uiAmount = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (uiAmount <= 0) return null;
        return { mint, uiAmount, rawAmount: String(info?.tokenAmount?.amount ?? "0"), decimals: Number(info?.tokenAmount?.decimals ?? 0) };
      })
      .filter((h): h is TokenHolding => h !== null);
  } catch { return []; }
}

async function quoteSellSol(mint: string, rawAmount: string): Promise<number | null> {
  if (!Number(rawAmount)) return null;
  const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
  quoteUrl.searchParams.set("inputMint", mint);
  quoteUrl.searchParams.set("outputMint", SOL_MINT);
  quoteUrl.searchParams.set("amount", rawAmount);
  quoteUrl.searchParams.set("slippageBps", "75");
  const res = await fetch(quoteUrl.toString(), { headers: { Accept: "application/json" }, cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json()) as { outAmount?: string };
  const lamports = Number(json.outAmount ?? 0);
  return Number.isFinite(lamports) && lamports > 0 ? lamports / 1e9 : null;
}

type CostBasis = { sol: number; ts: string; source?: string };

async function getCostBasis(mint: string): Promise<CostBasis | null> {
  const fact = await prisma.memoryFact.findUnique({ where: { key: `${COST_BASIS_KEY_PREFIX}${mint}` } }).catch(() => null);
  if (!fact?.value) return null;
  try { return JSON.parse(fact.value) as CostBasis; } catch { return null; }
}

async function setCostBasis(mint: string, sol: number, source: string): Promise<void> {
  if (!Number.isFinite(sol) || sol <= 0) return;
  const value = JSON.stringify({ sol, ts: new Date().toISOString(), source });
  await prisma.memoryFact.upsert({
    where: { key: `${COST_BASIS_KEY_PREFIX}${mint}` },
    create: { key: `${COST_BASIS_KEY_PREFIX}${mint}`, value, source: "agent", weight: 8 },
    update: { value },
  }).catch(() => {});
}

async function accumulateCostBasis(mint: string, addedSol: number, source = "planner_trade"): Promise<void> {
  if (!Number.isFinite(addedSol) || addedSol <= 0) return;
  const existing = await getCostBasis(mint);
  const totalSol = (existing?.sol ?? 0) + addedSol;
  await setCostBasis(mint, totalSol, source);
}

async function establishCostBasisIfMissing(mint: string, currentSolValue: number, source = "planner_wallet_snapshot"): Promise<CostBasis> {
  const existing = await getCostBasis(mint);
  if (existing && Number.isFinite(existing.sol) && existing.sol > 0) return existing;
  await setCostBasis(mint, currentSolValue, source);
  return { sol: currentSolValue, ts: new Date().toISOString(), source };
}

async function clearCostBasis(mint: string): Promise<void> {
  await prisma.memoryFact.deleteMany({ where: { key: `${COST_BASIS_KEY_PREFIX}${mint}` } }).catch(() => {});
}

// ── End wallet / token helpers ──────────────────────────────────────────────

async function estimateSolForUsd(usd: number): Promise<number> {
  const amountUsdcBase = Math.max(1, Math.floor(usd * 1_000_000));
  const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
  quoteUrl.searchParams.set("inputMint", USDC_MINT);
  quoteUrl.searchParams.set("outputMint", SOL_MINT);
  quoteUrl.searchParams.set("amount", String(amountUsdcBase));
  quoteUrl.searchParams.set("slippageBps", "50");
  const res = await fetch(quoteUrl.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`planner quote failed (${res.status})`);
  const json = (await res.json()) as { outAmount?: string };
  const outLamports = Number(json.outAmount ?? 0);
  if (!Number.isFinite(outLamports) || outLamports <= 0) throw new Error("planner quote returned no output");
  return outLamports / 1_000_000_000;
}

async function rankPolicyMints(allowlist: string[]): Promise<string[]> {
  const now = Date.now();
  const policies = await prisma.arbPolicy.findMany({ where: { mint: { in: allowlist } } });

  const scoreMap = new Map<string, number>();
  for (const row of policies) {
    const p = row.policy as Record<string, unknown>;
    const blacklistTs = Number((p?.tempBlacklistUntilMs as number | undefined) ?? 0);
    if (blacklistTs > now) continue;
    const stats = p?.stats as Record<string, unknown> | undefined;
    scoreMap.set(row.mint, Number(stats?.score ?? 0));
  }
  for (const mint of allowlist) {
    if (!scoreMap.has(mint)) scoreMap.set(mint, 0);
  }
  return [...scoreMap.entries()].sort((a, b) => b[1] - a[1]).map(([mint]) => mint);
}

async function isMintTradableFromSol(outputMint: string): Promise<boolean> {
  const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", "1000000");
  quoteUrl.searchParams.set("slippageBps", "50");
  const res = await fetch(quoteUrl.toString(), { headers: { Accept: "application/json" }, cache: "no-store" }).catch(() => null);
  return Boolean(res?.ok);
}

async function pickBestTradableMint(allowlist: string[]): Promise<string | null> {
  const ranked = await rankPolicyMints(allowlist);
  for (const mint of ranked) {
    if (await isMintTradableFromSol(mint)) return mint;
  }
  return null;
}


function policyStatsArePositive(policy: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
  const blacklistTs = Number(policy?.tempBlacklistUntilMs ?? 0);
  if (blacklistTs > now) return false;
  const stats = (policy?.stats as Record<string, unknown> | undefined) ?? {};
  const score = Number(stats.score ?? 0);
  const ok = Number(stats.ok ?? 0);
  const fail = Number(stats.fail ?? 0);
  return Number.isFinite(score) && score > 0 && ok >= fail;
}

async function hasPositivePolicySignal(allowlist: string[]): Promise<boolean> {
  const now = Date.now();
  const policies = await prisma.arbPolicy.findMany({ where: { mint: { in: allowlist } } });
  return policies.some((row) => policyStatsArePositive(row.policy as Record<string, unknown>, now));
}

async function hasPositivePolicySignalForMint(mint: string): Promise<boolean> {
  const row = await prisma.arbPolicy.findUnique({ where: { mint } }).catch(() => null);
  return policyStatsArePositive(row?.policy as Record<string, unknown> | undefined);
}


type PlannerContext = { text: string; signalCount: number; feedCount: number; policyCount: number };

function snapshotStrategies(control: Awaited<ReturnType<typeof getAppControlState>>): StrategySnapshot {
  return {
    minImbalancePct: control.controls.strategyEngines.poolImbalance.minImbalancePct ?? null,
    minNetProfitSol: control.controls.strategyEngines.crossDexArb.minNetProfitSol ?? null,
    enableTriangularRoutes: control.controls.strategyEngines.crossDexArb.enableTriangularRoutes ?? null,
    routeVia: control.controls.strategyEngines.crossDexArb.routeVia ?? null,
    entryVolSpikeMultiplier: control.controls.strategyEngines.momentumRunner.entryVolSpikeMultiplier ?? null,
    exitTrailingStopPct: control.controls.strategyEngines.momentumRunner.exitTrailingStopPct ?? null,
    maxHoldMinutes: control.controls.strategyEngines.momentumRunner.maxHoldMinutes ?? null,
    hardStopLossPct: control.controls.strategyEngines.momentumRunner.hardStopLossPct ?? null,
  };
}

async function buildDecisionContext(strategySnapshot: StrategySnapshot): Promise<PlannerContext> {
  const [recentSignals, recentFeed, walletMem, latestReflection, topPolicies, latestPlannerState] = await Promise.all([
    prisma.memory.findMany({
      where: {
        OR: [
          { source: "arb" },
          { source: "arb-bot" },
          { source: "trade" },
          { source: "sol-mev-bot" },
          { source: "mev" },
          { content: { contains: "pumpfun" } },
          { content: { contains: "pool imbalance" } },
          { content: { contains: "mev" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.memory.findMany({
      where: {
        OR: [
          { source: "sherpa" },
          { content: { contains: "[feed/" } },
          { content: { contains: "feed" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.memory.findFirst({ where: { source: "wallet" }, orderBy: { createdAt: "desc" } }),
    prisma.memory.findFirst({ where: { type: "reflection" }, orderBy: { createdAt: "desc" } }),
    prisma.arbPolicy.findMany({
      take: 5,
      orderBy: { updatedAt: "desc" },
      select: { mint: true, policy: true },
    }),
    prisma.memory.findFirst({
      where: { OR: [{ content: { contains: "planner tick skipped" } }, { content: { contains: "planner tick decision" } }] },
      orderBy: { createdAt: "desc" },
    }),
  ]);


  const policySignalLines = topPolicies
    .map((row) => {
      const policy = row.policy as Record<string, unknown>;
      const stats = (policy?.stats as Record<string, unknown> | undefined) ?? {};
      const score = Number(stats.score ?? 0);
      const ok = Number(stats.ok ?? 0);
      const fail = Number(stats.fail ?? 0);
      const blacklistedUntil = Number(policy?.tempBlacklistUntilMs ?? 0);
      const blacklisted = Number.isFinite(blacklistedUntil) && blacklistedUntil > Date.now();
      return `- mint=${row.mint} score=${score.toFixed(4)} ok=${ok} fail=${fail} blacklisted=${blacklisted}`;
    })
    .filter(Boolean);

  const parts: string[] = [];
  if (walletMem) parts.push(`WALLET STATE:\n${String(walletMem.content).slice(0, 240)}`);
  if (recentSignals.length) {
    parts.push(`RECENT ARB / TRADE SIGNALS:\n` + recentSignals.map((m) => `- ${String(m.content).slice(0, 180)}`).join("\n"));
  } else {
    parts.push("RECENT ARB SIGNALS: none logged yet");
  }
  if (recentFeed.length) {
    parts.push(`RECENT FEED / NARRATIVE CONTEXT:\n` + recentFeed.map((m) => `- ${String(m.content).slice(0, 160)}`).join("\n"));
  }
  if (policySignalLines.length) {
    parts.push(`ARB POLICY SNAPSHOT:\n${policySignalLines.join("\n")}`);
  }
  parts.push(`STRATEGY ENGINE SNAPSHOT:\n${JSON.stringify(strategySnapshot)}`);
  if (latestPlannerState) {
    parts.push(`LATEST PLANNER STATE:\n${String(latestPlannerState.content).slice(0, 200)}`);
  }
  if (latestReflection) parts.push(`LATEST REFLECTION:\n${String(latestReflection.content).slice(0, 240)}`);
  return { text: parts.join("\n\n"), signalCount: recentSignals.length, feedCount: recentFeed.length, policyCount: topPolicies.length };
}

type PlannerReasonCode =
  | "model_trade"
  | "model_hold"
  | "model_error"
  | "model_invalid"
  | "fallback_trade_on_positive_policy_signal"
  | "fallback_trade_retry"
  | "no_positive_policy_signal"
  | "quote_failed"
  | "swap_failed"
  | "cooldown_active"
  | "below_min_trade_usd"
  | "below_min_economic_size";

type PlannerDecision = { go: boolean; usd: number; reason: string; reasonCode: PlannerReasonCode };

async function getTradeDecision(context: string, maxTradeUsd: number, minTradeUsd: number): Promise<PlannerDecision> {
  const effectiveMaxTradeUsd = Number.isFinite(maxTradeUsd) && maxTradeUsd > 0 ? maxTradeUsd : 1_000_000;
  const effectiveMinTradeUsd = Number.isFinite(minTradeUsd) && minTradeUsd > 0 ? minTradeUsd : 0;
  const prompt =
    `You are the user-configured autonomous trading engine for this app.\n` +
    `Max trade allowed this cycle: $${effectiveMaxTradeUsd} USD.\n` +
    `Minimum autonomous trade size this cycle: $${effectiveMinTradeUsd} USD. If a trade would be smaller, respond HOLD.\n\n` +
    `CURRENT CONTEXT:\n${context}\n\n` +
    `Decision rules:\n` +
    `- If there are positive arb signals, healthy wallet, and no recent loss streak: respond TRADE $<amount>\n` +
    `- If signals are absent, wallet is low, recent trades failed, or available size is below the minimum: respond HOLD\n` +
    `- Amount must be between $${effectiveMinTradeUsd} and $${effectiveMaxTradeUsd}. Never request dust trades.\n\n` +
    `Respond with exactly ONE line in one of these formats:\n` +
    `TRADE $<amount>\n` +
    `HOLD`;

  let raw = "";
  try { raw = await ollama(prompt, "default"); }
  catch { return { go: false, usd: 0, reason: "ollama_error", reasonCode: "model_error" }; }

  const firstLine = (raw.trim().split("\n")[0] ?? "").trim();
  const tradeMatch = firstLine.match(/^TRADE\s+\$?(\d+(?:\.\d+)?)/i);
  if (tradeMatch) {
    const usd = Math.min(Math.max(Number(tradeMatch[1]), 0), effectiveMaxTradeUsd);
    if (Number.isFinite(usd) && usd > 0) {
      if (usd < effectiveMinTradeUsd) {
        return { go: false, usd: 0, reason: `${firstLine} below minimum trade size $${effectiveMinTradeUsd}`, reasonCode: "below_min_trade_usd" };
      }
      return { go: true, usd, reason: firstLine, reasonCode: "model_trade" };
    }
  }
  if (/^HOLD$/i.test(firstLine)) return { go: false, usd: 0, reason: "HOLD", reasonCode: "model_hold" };
  return { go: false, usd: 0, reason: firstLine || "HOLD", reasonCode: "model_invalid" };
}

// Process-level lock and caches shared across ticks.
const WALLET_TOKENS_CACHE_MS = numberFromEnv(process.env.MORK_WALLET_TOKENS_CACHE_MS, 5 * 60_000);
const _g = globalThis as typeof globalThis & {
  __plannerRunning?: boolean;
  __walletTokensCache?: { tokens: TokenHolding[]; ts: number };
};

export async function POST() {
  const runId = `planner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logSkip = (reason: string) => {
    console.warn(`[planner] tick skipped: ${reason} runId=${runId}`);
  };

  if (_g.__plannerRunning) {
    logSkip("concurrent_tick");
    return NextResponse.json({ ok: true, status: "skipped", reason: "concurrent_tick", runId });
  }
  _g.__plannerRunning = true;

  try {
    return await _plannerPost(runId, logSkip);
  } finally {
    _g.__plannerRunning = false;
  }
}

async function _plannerPost(runId: string, logSkip: (reason: string) => void) {
  if (process.env.MORK_AUTONOMOUS_TRADING_ENABLED !== "1") {
    logSkip("autonomous_disabled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "autonomous_disabled", runId });
  }

  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;
  const strategySnapshot = snapshotStrategies(control);

  if (!control.controls.plannerEnabled) {
    logSkip("planner_disabled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "planner_disabled", runId });
  }
  if (authority.mode === "emergency_stop") {
    logSkip("emergency_stop");
    return NextResponse.json({ ok: true, status: "skipped", reason: "emergency_stop", runId });
  }

  if (authority.cooldownMinutes > 0) {
    const lastTradeFact = await prisma.memoryFact.findUnique({ where: { key: LAST_PLANNER_TRADE_KEY } }).catch(() => null);
    const lastTradeAt = lastTradeFact?.value ? Date.parse(lastTradeFact.value) : Number.NaN;
    const cooldownMs = authority.cooldownMinutes * 60_000;
    const elapsedMs = Number.isFinite(lastTradeAt) ? Date.now() - lastTradeAt : cooldownMs;
    if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
      const minutesRemaining = (cooldownMs - elapsedMs) / 60_000;
      logSkip(`cooldown_active minutesRemaining=${minutesRemaining.toFixed(1)}`);
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: "cooldown_active",
        minutesRemaining,
        runId,
        decisionMeta: { reasonCode: "cooldown_active" },
      });
    }
  }

  const allowlist = await resolvePlannerAllowlist(authority.mintAllowlist);
  if (allowlist.length === 0) {
    logSkip("allowlist_unavailable");
    return NextResponse.json({ ok: true, status: "skipped", reason: "allowlist_unavailable", runId });
  }

  // Read wallet SOL early — used for both the early-exit guard and later sizing.
  const walletSolMemEarly = await prisma.memory.findFirst({ where: { source: "wallet" }, orderBy: { createdAt: "desc" } });
  const walletSolMatchEarly = String(walletSolMemEarly?.content ?? "").match(/SOL=([\d.]+)/);
  const walletSolBalance = walletSolMatchEarly ? Number(walletSolMatchEarly[1]) : null;
  const walletHasSOL = Number.isFinite(walletSolBalance) && (walletSolBalance ?? 0) > 0.01;

  // ── HOLDING BASIS SNAPSHOT ────────────────────────────────────────────────
  // Token holdings are cached for WALLET_TOKENS_CACHE_MS (default 5 min) to avoid
  // hitting the Solana RPC on every tick and triggering 429s.
  const kp = getPlannerKeypair();
  // allHeldTokens = every token with nonzero balance (used to establish basis).
  // heldTokens    = allowlist-filtered subset (used for rotate/buy phase).
  let allHeldTokens: TokenHolding[] = [];
  let heldTokens: TokenHolding[] = [];
  const holdingSolValues = new Map<string, number>();
  const holdingCostBasis = new Map<string, CostBasis>();
  if (kp) {
    const mintSet = new Set(allowlist);
    const cacheEntry = _g.__walletTokensCache;
    const cacheValid = cacheEntry && Date.now() - cacheEntry.ts < WALLET_TOKENS_CACHE_MS;
    if (cacheValid) {
      allHeldTokens = cacheEntry.tokens;
      heldTokens = allHeldTokens.filter((h) => mintSet.has(h.mint)).map(toSellableHolding).filter((h): h is TokenHolding => h !== null);
    } else {
      const conn = createSolanaConnection(RPC_URL, "processed");
      // Fetch all token accounts — basis tracking needs every holding, not just allowlisted.
      allHeldTokens = await getHeldTokens(conn, kp.publicKey);
      _g.__walletTokensCache = { tokens: allHeldTokens, ts: Date.now() };
      heldTokens = allHeldTokens.filter((h) => mintSet.has(h.mint)).map(toSellableHolding).filter((h): h is TokenHolding => h !== null);
    }

    for (const h of heldTokens) {
      const sellSol = await quoteSellSol(h.mint, h.rawAmount);
      if (sellSol === null || sellSol < MIN_SELL_SOL) continue;
      holdingSolValues.set(h.mint, sellSol);
      const basis = await establishCostBasisIfMissing(h.mint, sellSol);
      holdingCostBasis.set(h.mint, basis);
    }
  }
  // ── END HOLDING BASIS SNAPSHOT ────────────────────────────────────────────

  // Early exit: no SOL to spend and no tokens at all — nothing actionable this tick.
  if (!walletHasSOL && allHeldTokens.length === 0) {
    logSkip("no_spendable_sol_or_tokens");
    return NextResponse.json({ ok: true, status: "skipped", reason: "no_spendable_sol_or_tokens", runId });
  }

  const context = await buildDecisionContext(strategySnapshot);

  const configMaxUsd = Number.isFinite(authority.maxTradeUsd) && authority.maxTradeUsd > 0 ? authority.maxTradeUsd : 100;
  let effectiveMaxUsd = configMaxUsd;
  // Only fetch the SOL→USD price when the wallet actually has SOL to spend.
  // Skipping this when dry eliminates one Jupiter call per tick.
  if (walletHasSOL && walletSolBalance !== null) {
    try {
      const solPerDollar = await estimateSolForUsd(1);
      if (Number.isFinite(solPerDollar) && solPerDollar > 0) {
        const walletSpendableUsd = (walletSolBalance - 0.01) / solPerDollar;
        effectiveMaxUsd = Math.min(configMaxUsd, Math.max(0, walletSpendableUsd));
      }
    } catch { /* keep config max */ }
  } else if (heldTokens.length > 0) {
    // Rotating tokens: use a modest cap so the model doesn't overshoot
    effectiveMaxUsd = Math.min(configMaxUsd, 10);
  }

  if (walletHasSOL && effectiveMaxUsd < AGENT_MIN_TRADE_USD && heldTokens.length === 0) {
    logSkip(`below_min_trade_usd effectiveMaxUsd=${effectiveMaxUsd.toFixed(4)} minTradeUsd=${AGENT_MIN_TRADE_USD.toFixed(4)}`);
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "below_min_trade_usd",
      runId,
      decisionMeta: {
        reasonCode: "below_min_trade_usd",
        effectiveMaxUsd,
        minTradeUsd: AGENT_MIN_TRADE_USD,
        feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount },
        exitPlan: null,
      },
    });
  }

  const baseDecision = await getTradeDecision(context.text, effectiveMaxUsd, AGENT_MIN_TRADE_USD);
  const decision = { ...baseDecision };
  let fallbackApplied = false;
  const positiveSignal = await hasPositivePolicySignal(allowlist);

  if (!decision.go) {
    if (decision.reasonCode === "below_min_trade_usd") {
      logSkip(decision.reason);
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: "below_min_trade_usd",
        runId,
        decisionMeta: {
          reasonCode: decision.reasonCode,
          minTradeUsd: AGENT_MIN_TRADE_USD,
          fallbackApplied,
          feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount },
          exitPlan: null,
        },
      });
    }

    if (positiveSignal) {
      decision.go = true;
      decision.usd = Math.max(AGENT_MIN_TRADE_USD, effectiveMaxUsd);
      decision.reason = `${decision.reason || "HOLD"} -> fallback_trade_on_positive_policy_signal`;
      decision.reasonCode = "fallback_trade_on_positive_policy_signal";
      fallbackApplied = true;
    } else {
      decision.reasonCode = "no_positive_policy_signal";
      console.log(`[planner] searching_opportunities: no signals runId=${runId}`);
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: "searching_opportunities",
        runId,
        decisionMeta: {
          reasonCode: decision.reasonCode,
          fallbackApplied,
          feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount },
          exitPlan: null,
        },
      });
    }
  }


  console.log(`[planner] decision: ${decision.reason} runId=${runId}`);

  const outputMint = await pickBestTradableMint(allowlist);
  if (!outputMint) {
    logSkip("no_tradable_mint");
    return NextResponse.json({ ok: true, status: "skipped", reason: "no_tradable_mint", runId });
  }
  const targetHasPositiveSignal = await hasPositivePolicySignalForMint(outputMint);

  let amountSol: number;
  try { amountSol = await estimateSolForUsd(decision.usd); }
  catch { return NextResponse.json({ ok: false, status: "error", reason: "quote_failed", runId, decisionMeta: { reasonCode: "quote_failed" } }); }

  const maxSol = Number.isFinite(AGENT_SWAP_MAX_SOL) && AGENT_SWAP_MAX_SOL > 0 ? AGENT_SWAP_MAX_SOL : 0.25;
  if (amountSol > maxSol) amountSol = maxSol;

  // Cap to spendable wallet SOL (leave 0.01 SOL for gas) — reuses balance fetched above.
  const walletSol = walletSolBalance;
  if (Number.isFinite(walletSol) && walletSol !== null) {
    const spendableSol = Math.max(0, walletSol - 0.01);
    if (amountSol > spendableSol) {
      if (spendableSol <= 0) {
        logSkip("insufficient_sol");
        return NextResponse.json({ ok: true, status: "skipped", reason: "insufficient_sol", runId });
      }
      amountSol = spendableSol;
    }
  }

  const minUsdSol = await estimateSolForUsd(AGENT_MIN_TRADE_USD).catch(() => 0);
  const minFeeEconomicSol = Math.max(0, ESTIMATED_SWAP_FEE_SOL * MIN_TRADE_FEE_MULTIPLE);
  const minEconomicSol = Math.max(minUsdSol, minFeeEconomicSol);
  if (amountSol < minEconomicSol) {
    logSkip(
      `below_min_economic_size amountSol=${amountSol.toFixed(9)} minEconomicSol=${minEconomicSol.toFixed(9)} minUsdSol=${minUsdSol.toFixed(9)} feeFloorSol=${minFeeEconomicSol.toFixed(9)}`
    );
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "below_min_economic_size",
      runId,
      decisionMeta: {
        reasonCode: "below_min_economic_size",
        requestedUsd: decision.usd,
        amountSol,
        minTradeUsd: AGENT_MIN_TRADE_USD,
        minUsdSol,
        estimatedSwapFeeSol: ESTIMATED_SWAP_FEE_SOL,
        minTradeFeeMultiple: MIN_TRADE_FEE_MULTIPLE,
        minEconomicSol,
        feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount },
        exitPlan: null,
      },
    });
  }

  // ── ROTATE: use a held token as input instead of SOL ─────────────────────
  // Selling a held token is only allowed as part of a rotation when the exit is
  // above recorded cost basis and the target mint has a positive policy signal.
  // Missing basis is established from the current quote earlier in the tick, so
  // unknown positions cannot be treated as zero-cost profit.
  let swapMode = "sol_buy";
  let rotateFrom: TokenHolding | null = null;
  let rotateSolEstimate: number | null = null;
  let rotateBasisSol: number | null = null;

  if (kp && heldTokens.length > 0 && targetHasPositiveSignal) {
    const candidates = heldTokens
      .filter((h) => h.mint !== outputMint)
      .map((h) => {
        const estSol = holdingSolValues.get(h.mint);
        const basis = holdingCostBasis.get(h.mint);
        if (!Number.isFinite(estSol) || !basis || !Number.isFinite(basis.sol) || basis.sol <= 0) return null;
        const minProfitableSol = basis.sol * (1 + SELL_PROFIT_THRESHOLD);
        return estSol !== undefined && estSol >= Math.max(0.001, minProfitableSol)
          ? { holding: h, estSol, basisSol: basis.sol }
          : null;
      })
      .filter((item): item is { holding: TokenHolding; estSol: number; basisSol: number } => item !== null)
      .sort((a, b) => (b.estSol - b.basisSol) - (a.estSol - a.basisSol));

    const candidate = candidates[0];
    if (candidate) {
      rotateFrom = candidate.holding;
      rotateSolEstimate = candidate.estSol;
      rotateBasisSol = candidate.basisSol;
      swapMode = "rotate";
    }
  }
  // ── END ROTATE ────────────────────────────────────────────────────────────

  const swapBody = rotateFrom
    ? { inputMint: rotateFrom.mint, outputMint, amountIn: rotateFrom.uiAmount, slippageBps: 75, agentInitiated: true }
    : { amountSol, slippageBps: 50, outputMint, agentInitiated: true };

  const swapReq = new Request("http://planner.internal/api/trade/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });
  const swapResponse = await executeSwapRoute(swapReq);
  const swapJson = (await swapResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string; signature?: string };

  if (!swapResponse.ok || !swapJson.ok) {
    return NextResponse.json({ ok: false, status: "error", reason: "swap_failed", runId, decisionMeta: { reasonCode: "swap_failed" }, error: swapJson.error ?? `planner swap failed (${swapResponse.status})` }, { status: swapResponse.status || 500 });
  }

  // Record cost basis for every planner trade — accumulate across multiple buys of the same mint.
  const solCostForBasis = rotateFrom ? (rotateSolEstimate ?? amountSol) : amountSol;
  await accumulateCostBasis(outputMint, solCostForBasis, rotateFrom ? "planner_profitable_rotation" : "planner_buy");
  // If rotating, the old position is fully consumed — clear its basis.
  if (rotateFrom) await clearCostBasis(rotateFrom.mint);

  await prisma.memoryFact.upsert({
    where: { key: LAST_PLANNER_TRADE_KEY },
    create: { key: LAST_PLANNER_TRADE_KEY, value: new Date().toISOString(), source: "agent", weight: 8 },
    update: { value: new Date().toISOString(), source: "agent", weight: 8 },
  });

  return NextResponse.json({ ok: true, status: "executed", mode: swapMode, runId, usd: decision.usd, amountSol: rotateFrom ? rotateSolEstimate : amountSol, outputMint, rotateFromMint: rotateFrom?.mint ?? null, signature: swapJson.signature ?? null, reason: decision.reason, decisionMeta: { reasonCode: decision.reasonCode, fallbackApplied, targetHasPositiveSignal, rotateBasisSol, cappedToMaxSol: !rotateFrom && amountSol >= maxSol, feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount }, exitPlan: { tp: null, sl: null, trailingStopPct: strategySnapshot.exitTrailingStopPct, maxHoldMinutes: strategySnapshot.maxHoldMinutes, hardStopLossPct: strategySnapshot.hardStopLossPct } } });
}
