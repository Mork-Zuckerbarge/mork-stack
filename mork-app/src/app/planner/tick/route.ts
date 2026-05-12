import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { ollama } from "@/lib/core/ollama";
import { POST as executeSwapRoute } from "@/app/api/trade/swap/route";

export const runtime = "nodejs";

const LAST_PLANNER_TRADE_KEY = "__planner_last_trade_iso_v1__";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_BASE = process.env.JUP_BASE_URL ?? "https://api.jup.ag";
const AGENT_SWAP_MAX_SOL = Number(process.env.MORK_AGENT_SWAP_MAX_SOL ?? 0.25);

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

async function pickBestMint(allowlist: string[]): Promise<string | null> {
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
  const sorted = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}


async function hasPositivePolicySignal(allowlist: string[]): Promise<boolean> {
  const now = Date.now();
  const policies = await prisma.arbPolicy.findMany({ where: { mint: { in: allowlist } } });
  for (const row of policies) {
    const policy = row.policy as Record<string, unknown>;
    const blacklistTs = Number(policy?.tempBlacklistUntilMs ?? 0);
    if (blacklistTs > now) continue;
    const stats = (policy?.stats as Record<string, unknown> | undefined) ?? {};
    const score = Number(stats.score ?? 0);
    const ok = Number(stats.ok ?? 0);
    const fail = Number(stats.fail ?? 0);
    if (Number.isFinite(score) && score > 0 && ok >= fail) return true;
  }
  return false;
}

type PlannerContext = { text: string; signalCount: number; feedCount: number; policyCount: number };

async function buildDecisionContext(): Promise<PlannerContext> {
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
  if (latestPlannerState) {
    parts.push(`LATEST PLANNER STATE:\n${String(latestPlannerState.content).slice(0, 200)}`);
  }
  if (latestReflection) parts.push(`LATEST REFLECTION:\n${String(latestReflection.content).slice(0, 240)}`);
  return { text: parts.join("\n\n"), signalCount: recentSignals.length, feedCount: recentFeed.length, policyCount: topPolicies.length };
}

type PlannerDecision = { go: boolean; usd: number; reason: string; reasonCode: "model_trade" | "model_hold" | "model_error" | "model_invalid" };

async function getTradeDecision(context: string, maxTradeUsd: number): Promise<PlannerDecision> {
  const prompt =
    `You are the autonomous trading engine for Mork Zuckerbarge.\n` +
    `Max trade allowed this cycle: $${maxTradeUsd} USD.\n\n` +
    `CURRENT CONTEXT:\n${context}\n\n` +
    `Decision rules:\n` +
    `- If there are positive arb signals, healthy wallet, and no recent loss streak: respond TRADE $<amount>\n` +
    `- If signals are absent, wallet is low, or recent trades failed: respond HOLD\n` +
    `- Amount can be any positive USD value up to $${maxTradeUsd}.\n\n` +
    `Respond with exactly ONE line in one of these formats:\n` +
    `TRADE $<amount>\n` +
    `HOLD`;

  let raw = "";
  try { raw = await ollama(prompt, "default"); }
  catch { return { go: false, usd: 0, reason: "ollama_error", reasonCode: "model_error" }; }

  const firstLine = (raw.trim().split("\n")[0] ?? "").trim();
  const tradeMatch = firstLine.match(/^TRADE\s+\$?(\d+(?:\.\d+)?)/i);
  if (tradeMatch) {
    const usd = Math.min(Math.max(Number(tradeMatch[1]), 0), maxTradeUsd);
    if (Number.isFinite(usd) && usd > 0) return { go: true, usd, reason: firstLine, reasonCode: "model_trade" };
  }
  if (/^HOLD$/i.test(firstLine)) return { go: false, usd: 0, reason: "HOLD", reasonCode: "model_hold" };
  return { go: false, usd: 0, reason: firstLine || "HOLD", reasonCode: "model_invalid" };
}

export async function POST() {
  const logSkip = async (reason: string) => {
    await prisma.memory.create({
      data: {
        type: "reflection",
        content: `Autonomous planner tick skipped: ${reason}`,
        entities: ["planner:skip"],
        importance: 0.45,
        source: "system",
      },
    });
  };

  if (process.env.MORK_AUTONOMOUS_TRADING_ENABLED !== "1") {
    await logSkip("autonomous_disabled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "autonomous_disabled" });
  }

  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;

  if (!control.controls.plannerEnabled) {
    await logSkip("planner_disabled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "planner_disabled" });
  }
  if (authority.mode === "emergency_stop") {
    await logSkip("emergency_stop");
    return NextResponse.json({ ok: true, status: "skipped", reason: "emergency_stop" });
  }

  const allowlist = authority.mintAllowlist.filter((m) => m !== SOL_MINT && m !== USDC_MINT);
  if (allowlist.length === 0) {
    await logSkip("allowlist_empty");
    return NextResponse.json({ ok: true, status: "skipped", reason: "allowlist_empty" });
  }

  const context = await buildDecisionContext();
  const baseDecision = await getTradeDecision(context.text, authority.maxTradeUsd);
  const decision = { ...baseDecision };
  let fallbackApplied = false;

  if (!decision.go) {
    const positiveSignal = await hasPositivePolicySignal(allowlist);
    if (!positiveSignal) return NextResponse.json({ ok: true, status: "hold", reason: decision.reason, decisionMeta: { reasonCode: decision.reasonCode, fallbackApplied: false, positiveSignal: false, feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount } } });
    decision.go = true;
    decision.usd = Math.max(1, Math.min(authority.maxTradeUsd, Math.max(1, authority.maxTradeUsd * 0.35)));
    decision.reason = `${decision.reason || "HOLD"} -> fallback_probe_trade_on_positive_policy_signal`;
    fallbackApplied = true;
  }


  await prisma.memory.create({
    data: { type: "reflection", content: `Autonomous planner tick decision: ${decision.reason}`, entities: ["planner:decision"], importance: 0.55, source: "system" },
  });

  const outputMint = await pickBestMint(allowlist);
  if (!outputMint) {
    await logSkip("no_eligible_mint");
    return NextResponse.json({ ok: true, status: "skipped", reason: "no_eligible_mint" });
  }

  let amountSol: number;
  try { amountSol = await estimateSolForUsd(decision.usd); }
  catch { return NextResponse.json({ ok: false, status: "error", reason: "quote_failed" }); }

  const maxSol = Number.isFinite(AGENT_SWAP_MAX_SOL) && AGENT_SWAP_MAX_SOL > 0 ? AGENT_SWAP_MAX_SOL : 0.25;
  if (amountSol > maxSol) {
    amountSol = maxSol;
  }

  const swapReq = new Request("http://planner.internal/api/trade/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountSol, slippageBps: 50, outputMint, agentInitiated: true }),
  });
  const swapResponse = await executeSwapRoute(swapReq);
  const swapJson = (await swapResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string; signature?: string };

  if (!swapResponse.ok || !swapJson.ok) {
    return NextResponse.json({ ok: false, status: "error", reason: "swap_failed", error: swapJson.error ?? `planner swap failed (${swapResponse.status})` }, { status: swapResponse.status || 500 });
  }

  await prisma.memoryFact.upsert({
    where: { key: LAST_PLANNER_TRADE_KEY },
    create: { key: LAST_PLANNER_TRADE_KEY, value: new Date().toISOString(), source: "agent", weight: 8 },
    update: { value: new Date().toISOString(), source: "agent", weight: 8 },
  });

  return NextResponse.json({ ok: true, status: "executed", mode: "planner_ollama_decision", usd: decision.usd, amountSol, outputMint, signature: swapJson.signature ?? null, reason: decision.reason, decisionMeta: { reasonCode: decision.reasonCode, fallbackApplied, cappedToMaxSol: amountSol >= maxSol, feeds: { signalCount: context.signalCount, feedCount: context.feedCount, policyCount: context.policyCount } } });
}
