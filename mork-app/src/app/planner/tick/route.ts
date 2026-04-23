import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
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

  const res = await fetch(quoteUrl.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`planner quote failed (${res.status})`);
  }
  const json = (await res.json()) as { outAmount?: string };
  const outLamports = Number(json.outAmount ?? 0);
  if (!Number.isFinite(outLamports) || outLamports <= 0) {
    throw new Error("planner quote returned no output");
  }
  return outLamports / 1_000_000_000;
}

export async function POST() {
  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;

  if (!control.controls.plannerEnabled) {
    return NextResponse.json({ ok: true, status: "skipped", reason: "planner_disabled" });
  }
  if (authority.mode !== "agent_assisted") {
    return NextResponse.json({ ok: true, status: "skipped", reason: `authority_${authority.mode}` });
  }
  if (control.arb.status === "running" || control.controls.activePanel !== "trade") {
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "trade_panel_not_armed",
      detail: "Set active panel to Trade and stop ARB for planner swaps.",
    });
  }
  if (process.env.MORK_AGENT_SWAP_ENABLED !== "1") {
    return NextResponse.json({ ok: true, status: "skipped", reason: "agent_swap_disabled" });
  }

  const lastTradeFact = await prisma.memoryFact.findUnique({ where: { key: LAST_PLANNER_TRADE_KEY } });
  const minutesElapsed = minutesSince(lastTradeFact?.value ?? null);
  if (minutesElapsed < authority.cooldownMinutes) {
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "cooldown_active",
      minutesRemaining: Math.max(0, authority.cooldownMinutes - minutesElapsed),
    });
  }

  const allowlist = authority.mintAllowlist.filter((mint) => mint !== SOL_MINT);
  if (allowlist.length === 0) {
    return NextResponse.json({ ok: true, status: "skipped", reason: "allowlist_empty" });
  }

  const plannerTradeUsd = Number(process.env.MORK_PLANNER_TRADE_USD ?? 2);
  const cappedUsd = Math.min(
    Math.max(0.5, Number.isFinite(plannerTradeUsd) ? plannerTradeUsd : 2),
    Math.max(0.5, authority.maxTradeUsd)
  );
  const amountSol = await estimateSolForUsd(cappedUsd);
  const outputMint = allowlist[Math.floor(Math.random() * allowlist.length)];

  const swapReq = new Request("http://planner.internal/api/trade/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountSol, slippageBps: 50, outputMint }),
  });
  const swapResponse = await executeSwapRoute(swapReq);
  const swapJson = (await swapResponse.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    signature?: string;
  };

  if (!swapResponse.ok || !swapJson.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        reason: "swap_failed",
        error: swapJson.error || `planner swap failed (${swapResponse.status})`,
      },
      { status: swapResponse.status || 500 }
    );
  }

  await prisma.memoryFact.upsert({
    where: { key: LAST_PLANNER_TRADE_KEY },
    create: {
      key: LAST_PLANNER_TRADE_KEY,
      value: new Date().toISOString(),
      source: "agent",
      weight: 8,
    },
    update: {
      value: new Date().toISOString(),
      source: "agent",
      weight: 8,
    },
  });

  return NextResponse.json({
    ok: true,
    status: "executed",
    mode: "planner_live_trade",
    usd: cappedUsd,
    amountSol,
    outputMint,
    signature: swapJson.signature ?? null,
  });
}
