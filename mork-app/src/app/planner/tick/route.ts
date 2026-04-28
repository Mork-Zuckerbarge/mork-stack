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

function minutesSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / 60_000;
}

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

async function buildDecisionContext(): Promise<string> {
  const [recentSignals, walletMem, latestReflection] = await Promise.all([
    prisma.memory.findMany({
      where: { OR: [{ source: "arb" }, { source: "arb-bot" }, { source: "trade" }] },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.memory.findFirst({ where: { source: "wallet" }, orderBy: { createdAt: "desc" } }),
    prisma.memory.findFirst({ where: { type: "reflection" }, orderBy: { createdAt: "desc" } }),
  ]);

  const parts: string[] = [];
  if (walletMem) parts.push(`WALLET STATE:\n${String(walletMem.content).slice(0, 240)}`);
  if (recentSignals.length) {
    parts.push(`RECENT ARB / TRADE SIGNALS:\n` + recentSignals.map((m) => `- ${String(m.content).slice(0, 180)}`).join("\n"));
  } else {
    parts.push("RECENT ARB SIGNALS: none logged yet");
  }
  if (latestReflection) parts.push(`LATEST REFLECTION:\n${String(latestReflection.content).slice(0, 240)}`);
  return parts.join("\n\n");
}

async function getTradeDecision(context: string, maxTradeUsd: number): Promise<{ go: boolean; usd: number; reason: string }> {
  const prompt =
    `You are the autonomous trading engine for Mork Zuckerbarge.\n` +
    `Max trade allowed this cycle: $${maxTradeUsd} USD.\n\n` +
    `CURRENT CONTEXT:\n${context}\n\n` +
    `Decision rules:\n` +
    `- If there are positive arb signals, healthy wallet, and no recent loss streak: respond TRADE $<amount>\n` +
    `- If signals are absent, wallet is low, or recent trades failed: respond HOLD\n` +
    `- Amount must be between $1 and $${maxTradeUsd}.\n\n` +
    `Respond with exactly ONE line:\n` +
    `TRADE $5\n` +
    `or\n` +
    `HOLD`;

  let raw = "";
  try { raw = await ollama(prompt, "default"); }
  catch { return { go: false, usd: 0, reason: "ollama_error" }; }

  const firstLine = (raw.trim().split("\n")[0] ?? "").trim();
  const tradeMatch = firstLine.match(/^TRADE\s+\$?(\d+(?:\.\d+)?)/i);
  if (tradeMatch) {
    const usd = Math.min(Math.max(Number(tradeMatch[1]), 0.5), maxTradeUsd);
    if (Number.isFinite(usd) && usd > 0) return { go: true, usd, reason: firstLine };
  }
  return { go: false, usd: 0, reason: firstLine || "HOLD" };
}

export async function POST() {
  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;

  if (!control.controls.plannerEnabled) return NextResponse.json({ ok: true, status: "skipped", reason: "planner_disabled" });
  if (authority.mode === "emergency_stop") return NextResponse.json({ ok: true, status: "skipped", reason: "emergency_stop" });
  if (authority.mode === "user_only") return NextResponse.json({ ok: true, status: "skipped", reason: "user_only_mode" });

  const lastTradeFact = await prisma.memoryFact.findUnique({ where: { key: LAST_PLANNER_TRADE_KEY } });
  const minutesElapsed = minutesSince(lastTradeFact?.value ?? null);
  if (minutesElapsed < authority.cooldownMinutes) {
    return NextResponse.json({ ok: true, status: "skipped", reason: "cooldown_active", minutesRemaining: Math.max(0, authority.cooldownMinutes - minutesElapsed) });
  }

  const allowlist = authority.mintAllowlist.filter((m) => m !== SOL_MINT && m !== USDC_MINT);
  if (allowlist.length === 0) return NextResponse.json({ ok: true, status: "skipped", reason: "allowlist_empty" });

  const context = await buildDecisionContext();
  const decision = await getTradeDecision(context, authority.maxTradeUsd);

  await prisma.memory.create({
    data: { type: "reflection", content: `Autonomous planner tick decision: ${decision.reason}`, entities: ["planner:decision"], importance: 0.55, source: "system" },
  });

  if (!decision.go) return NextResponse.json({ ok: true, status: "hold", reason: decision.reason });

  const outputMint = await pickBestMint(allowlist);
  if (!outputMint) return NextResponse.json({ ok: true, status: "skipped", reason: "no_eligible_mint" });

  let amountSol: number;
  try { amountSol = await estimateSolForUsd(decision.usd); }
  catch { return NextResponse.json({ ok: false, status: "error", reason: "quote_failed" }); }

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

  return NextResponse.json({ ok: true, status: "executed", mode: "planner_ollama_decision", usd: decision.usd, amountSol, outputMint, signature: swapJson.signature ?? null, reason: decision.reason });
}
