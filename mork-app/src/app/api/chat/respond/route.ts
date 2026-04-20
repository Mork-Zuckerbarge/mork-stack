import { NextRequest, NextResponse } from "next/server";
import { respondToChat } from "@/lib/core/chat";
import { getAppControlState } from "@/lib/core/appControl";
import { getOrchestratorState, startRuntime, stopRuntime } from "@/lib/core/orchestrator";
import { prisma } from "@/lib/core/prisma";

type ChatChannel = "system" | "telegram" | "x";

type RoutedCommand =
  | { type: "tweet"; text: string }
  | { type: "telegram"; text: string }
  | { type: "buy"; usd: number; symbol: string }
  | { type: "services.status" }
  | { type: "service.start"; service: "arb" | "sherpa" }
  | { type: "service.stop"; service: "arb" | "sherpa" };

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";
const LAST_TRADE_FACT_KEY = "__agent_last_trade_iso_v1__";

function resolveChannel(value: unknown): ChatChannel {
  if (value === "telegram" || value === "x") return value;
  return "system";
}

function normalizeBotToken(rawToken: string): string {
  const trimmed = (rawToken || "").trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("https://api.telegram.org/bot")) {
    return trimmed.split("/bot", 2)[1]?.split("/", 2)[0]?.trim() ?? "";
  }
  if (trimmed.toLowerCase().startsWith("bot")) {
    return trimmed.slice(3).trim();
  }
  return trimmed;
}

function parseCommand(message: string): RoutedCommand | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const tweetMatch =
    trimmed.match(/^hey\s+tweet\s+this\s*:\s*(.+)$/i) ||
    trimmed.match(/^(?:tweet|post)\s+this\s+(?:on\s+)?x\s*:\s*(.+)$/i) ||
    trimmed.match(/^x\s+post\s*:\s*(.+)$/i);
  if (tweetMatch?.[1]?.trim()) {
    return { type: "tweet", text: tweetMatch[1].trim() };
  }

  const telegramMatch =
    trimmed.match(/^(?:post\s+this\s+in\s+telegram|telegram\s+post|send\s+to\s+telegram)\s*:\s*(.+)$/i) ||
    trimmed.match(/^hey\s+telegram\s+this\s*:\s*(.+)$/i);
  if (telegramMatch?.[1]?.trim()) {
    return { type: "telegram", text: telegramMatch[1].trim() };
  }

  const buyMatch = trimmed.match(/^go\s+buy\s+\$?(\d+(?:\.\d+)?)\s+of\s+\$?([a-z0-9._-]+)\s*$/i);
  if (buyMatch) {
    return {
      type: "buy",
      usd: Number(buyMatch[1]),
      symbol: buyMatch[2].toUpperCase(),
    };
  }

  if (/^(?:services|service)\s+(?:status|list|show)$/i.test(trimmed) || /^show\s+services$/i.test(trimmed)) {
    return { type: "services.status" };
  }

  const startMatch = trimmed.match(/^(?:start|enable)\s+(arb|sherpa)\s*$/i);
  if (startMatch) {
    return { type: "service.start", service: startMatch[1].toLowerCase() as "arb" | "sherpa" };
  }

  const stopMatch = trimmed.match(/^(?:stop|disable)\s+(arb|sherpa)\s*$/i);
  if (stopMatch) {
    return { type: "service.stop", service: stopMatch[1].toLowerCase() as "arb" | "sherpa" };
  }

  return null;
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
    throw new Error(`SOL conversion quote failed (${res.status})`);
  }

  const data = (await res.json()) as { outAmount?: string };
  const outLamports = Number(data.outAmount ?? 0);
  if (!Number.isFinite(outLamports) || outLamports <= 0) {
    throw new Error("SOL conversion quote returned no output");
  }

  return outLamports / 1_000_000_000;
}

function formatMinutesFromNow(lastTradeIso: string) {
  const millis = Date.now() - new Date(lastTradeIso).getTime();
  if (!Number.isFinite(millis) || millis <= 0) return 0;
  return Math.ceil(millis / 60_000);
}

async function enforceTradeAuthority(usd: number) {
  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;

  if (authority.mode === "emergency_stop") {
    return {
      ok: false,
      status: 403,
      error: "Trade execution is blocked: execution authority is in emergency_stop.",
    };
  }

  if (authority.mode === "user_only") {
    return {
      ok: false,
      status: 403,
      error: "Trade execution is blocked: execution authority is user_only.",
    };
  }

  if (usd > authority.maxTradeUsd) {
    return {
      ok: false,
      status: 400,
      error: `Trade amount exceeds maxTradeUsd ($${authority.maxTradeUsd}) for agent_assisted mode.`,
    };
  }

  const cooldownMinutes = Math.max(0, authority.cooldownMinutes);
  if (cooldownMinutes > 0) {
    const lastTrade = await prisma.memoryFact.findUnique({ where: { key: LAST_TRADE_FACT_KEY } });
    const lastTradeIso = String(lastTrade?.value || "").trim();

    if (lastTradeIso) {
      const minutesSince = formatMinutesFromNow(lastTradeIso);
      if (minutesSince < cooldownMinutes) {
        return {
          ok: false,
          status: 429,
          error: `Trade cooldown active: wait ${cooldownMinutes - minutesSince} more minute(s).`,
        };
      }
    }
  }

  const allowlist = authority.mintAllowlist.map((item) => item.trim()).filter(Boolean);
  if (allowlist.length > 0) {
    const allowSet = new Set(allowlist);
    if (!allowSet.has(BBQ_MINT) && !allowSet.has("BBQ")) {
      return {
        ok: false,
        status: 403,
        error: "Trade denied by execution authority mintAllowlist (BBQ mint not allowed). Add BBQ mint/symbol to allowlist or clear allowlist.",
      };
    }
  }

  return { ok: true, status: 200 } as const;
}

async function noteTradeExecution() {
  await prisma.memoryFact.upsert({
    where: { key: LAST_TRADE_FACT_KEY },
    update: { value: new Date().toISOString() },
    create: { key: LAST_TRADE_FACT_KEY, value: new Date().toISOString(), source: "agent" },
  });
}

async function executeCommand(req: NextRequest, command: RoutedCommand) {
  if (command.type === "services.status") {
    const orchestrator = await getOrchestratorState();
    const authority = orchestrator.app.controls.executionAuthority;
    return {
      ok: true,
      routed: "orchestrator",
      command: "services.status",
      response:
        `Services:\n` +
        `- arb: ${orchestrator.app.arb.status}\n` +
        `- sherpa: ${orchestrator.app.sherpa.status}\n` +
        `- startupCompleted: ${orchestrator.app.controls.startupCompleted}\n` +
        `- trade authority: ${authority.mode} (maxTradeUsd=${authority.maxTradeUsd}, cooldownMinutes=${authority.cooldownMinutes})`,
      status: 200,
    };
  }

  if (command.type === "service.start") {
    await startRuntime(command.service);
    const orchestrator = await getOrchestratorState();
    return {
      ok: true,
      routed: "orchestrator",
      command: "service.start",
      response: `Started ${command.service}. Current status: arb=${orchestrator.app.arb.status}, sherpa=${orchestrator.app.sherpa.status}.`,
      status: 200,
    };
  }

  if (command.type === "service.stop") {
    await stopRuntime(command.service);
    const orchestrator = await getOrchestratorState();
    return {
      ok: true,
      routed: "orchestrator",
      command: "service.stop",
      response: `Stopped ${command.service}. Current status: arb=${orchestrator.app.arb.status}, sherpa=${orchestrator.app.sherpa.status}.`,
      status: 200,
    };
  }

  if (command.type === "tweet") {
    const draft = await respondToChat({
      channel: "x",
      handle: "app-user",
      message: `Draft an X post using this user-provided text. Keep intent and key wording intact unless it violates policy: ${command.text}`,
      maxChars: 280,
    });

    return {
      ok: true,
      routed: "sherpa/x",
      command: "tweet",
      response: draft.response || command.text,
      status: 200,
      note: "Draft generated for X voice. Sherpa posting remains external unless wired to X credentials.",
    };
  }

  if (command.type === "telegram") {
    const botToken = normalizeBotToken(process.env.TELEGRAM_BOT_TOKEN || "");
    const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();

    if (!botToken || !chatId) {
      return {
        ok: false,
        status: 400,
        error:
          "Telegram send needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in mork-app/.env.local (restart after saving).",
      };
    }

    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: command.text,
      }),
    });

    const json = (await sendRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!sendRes.ok || !json.ok) {
      return {
        ok: false,
        status: 502,
        error: `Telegram send failed${json.description ? `: ${json.description}` : ""}`,
      };
    }

    return {
      ok: true,
      routed: "telegram",
      command: "post",
      response: `Posted to Telegram: ${command.text}`,
      status: 200,
    };
  }

  if (!Number.isFinite(command.usd) || command.usd <= 0) {
    return {
      ok: false,
      status: 400,
      error: "Buy command amount must be a positive USD value.",
    };
  }

  if (command.symbol !== "SPX" && command.symbol !== "BBQ") {
    return {
      ok: false,
      status: 400,
      error:
        `ARB quick-buy currently supports $SPX (mapped to BBQ route) or $BBQ only. Received: $${command.symbol}.`,
    };
  }

  const tradeAuthority = await enforceTradeAuthority(command.usd);
  if (!tradeAuthority.ok) {
    return tradeAuthority;
  }

  const amountSol = await estimateSolForUsd(command.usd);
  const swapRes = await fetch(new URL("/api/trade/swap", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountSol, slippageBps: 50 }),
  });

  const swapJson = (await swapRes.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    signature?: string;
    amountSol?: number;
  };

  if (!swapRes.ok || !swapJson.ok) {
    return {
      ok: false,
      status: swapRes.status || 500,
      error: swapJson.error || `Trade execution failed (${swapRes.status})`,
    };
  }

  await noteTradeExecution();

  return {
    ok: true,
    routed: "arb",
    command: "buy",
    response: `Executed buy for ~$${command.usd.toFixed(2)} (${(swapJson.amountSol ?? amountSol).toFixed(6)} SOL route). Signature: ${swapJson.signature}`,
    status: 200,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = typeof body?.message === "string" ? body.message : "";
    const command = parseCommand(message);

    if (command) {
      const result = await executeCommand(req, command);
      return NextResponse.json(result, { status: result.status || 200 });
    }

    const result = await respondToChat({
      channel: resolveChannel(body?.channel),
      handle: typeof body?.handle === "string" && body.handle.trim() ? body.handle.trim() : "app-user",
      message,
      maxChars: typeof body?.maxChars === "number" ? body.maxChars : 12000,
    });

    return NextResponse.json(result, { status: result.status || 200 });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "chat route failed" },
      { status: 500 }
    );
  }
}
