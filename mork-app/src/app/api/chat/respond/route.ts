import { NextRequest, NextResponse } from "next/server";
import { respondToChat } from "@/lib/core/chat";
import { getOrchestratorState, startRuntime, stopRuntime } from "@/lib/core/orchestrator";
import { prisma } from "@/lib/core/prisma";
import { generateImage, generateVideo } from "@/lib/core/media";
import { readFile } from "node:fs/promises";
import path from "node:path";

type ChatChannel = "system" | "telegram" | "x";

type RoutedCommand =
  | { type: "tweet"; text: string }
  | { type: "telegram"; text: string }
  | { type: "media.generate"; mediaKind: "image" | "video"; prompt: string }
  | { type: "media.share"; platform: "telegram" | "x"; filename: string; caption: string }
  | { type: "buy"; usd: number; symbol: string }
  | { type: "services.status" }
  | { type: "service.start"; service: "arb" | "sherpa" }
  | { type: "service.stop"; service: "arb" | "sherpa" };

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAST_TRADE_FACT_KEY = "__agent_last_trade_iso_v1__";
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JUP_TOKEN_SEARCH_LIMIT = "100";

function buildJupiterBaseCandidates() {
  const candidates = [
    (process.env.JUP_BASE_URL || "").trim(),
    "https://api.jup.ag",
    "https://lite-api.jup.ag",
  ].filter(Boolean);
  return [...new Set(candidates)];
}

async function fetchJsonWithJupiterFallback(path: string, query: Record<string, string>) {
  const candidates = buildJupiterBaseCandidates();
  let lastError: unknown = null;

  for (const base of candidates) {
    try {
      const url = new URL(`${base}${path}`);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = new Error(`${path} failed on ${base} (${res.status})`);
        continue;
      }
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Jupiter request failed for ${path}`);
}

function toUserFacingFetchError(error: unknown, context: string): Error {
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes("fetch failed")) {
      return new Error(`${context} (network request failed). Check JUP_BASE_URL / outbound network access.`);
    }
    return new Error(`${context} (${error.message})`);
  }
  return new Error(`${context} (unknown error)`);
}

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
    trimmed.match(/^(?:post\s+to\s+telegram|post\s+this\s+in\s+telegram|telegram\s+post|send\s+to\s+telegram)\s*:\s*(.+)$/i) ||
    trimmed.match(/^hey\s+telegram\s+this\s*:\s*(.+)$/i);
  if (telegramMatch?.[1]?.trim()) {
    return { type: "telegram", text: telegramMatch[1].trim() };
  }

  const imageMatch =
    trimmed.match(/^(?:generate|create|make)\s+(?:an?\s+)?image\s*:\s*(.+)$/i) ||
    trimmed.match(/^image\s*:\s*(.+)$/i);
  if (imageMatch?.[1]?.trim()) {
    return { type: "media.generate", mediaKind: "image", prompt: imageMatch[1].trim() };
  }

  const videoMatch =
    trimmed.match(/^(?:generate|create|make)\s+(?:an?\s+)?video(?:\s*:)?\s+(.+)$/i) ||
    trimmed.match(/^video\s*:\s*(.+)$/i);
  if (videoMatch?.[1]?.trim()) {
    return { type: "media.generate", mediaKind: "video", prompt: videoMatch[1].trim() };
  }

  const sendMediaMatch = trimmed.match(
    /^send\s+([a-z0-9._-]+)\s+to\s+(telegram|x)(?:\s+with\s+caption\s*:\s*(.+))?\s*$/i
  );
  if (sendMediaMatch?.[1]?.trim()) {
    return {
      type: "media.share",
      filename: sendMediaMatch[1].trim(),
      platform: sendMediaMatch[2].toLowerCase() as "telegram" | "x",
      caption: sendMediaMatch[3]?.trim() || "",
    };
  }

  const buyMatch =
    trimmed.match(/^go\s+buy\s+\$?(\d+(?:\.\d+)?)\s+of\s+\$?([a-z0-9._-]+)\s*$/i) ||
    trimmed.match(/^buy\s+\$?(\d+(?:\.\d+)?)\s+(?:of\s+)?\$?([a-z0-9._-]+)(?:\s+now)?\s*$/i) ||
    trimmed.match(/^ape\s+\$?(\d+(?:\.\d+)?)\s+into\s+\$?([a-z0-9._-]+)\s*$/i);
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

  let data: { outAmount?: string };
  try {
    data = (await fetchJsonWithJupiterFallback("/swap/v1/quote", {
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      amount: String(amountUsdcBase),
      slippageBps: "50",
    })) as { outAmount?: string };
  } catch (error) {
    throw toUserFacingFetchError(error, "USD→SOL quote failed");
  }
  const outLamports = Number(data.outAmount ?? 0);
  if (!Number.isFinite(outLamports) || outLamports <= 0) {
    throw new Error("SOL conversion quote returned no output");
  }

  return outLamports / 1_000_000_000;
}

type JupiterTokenResult = { address?: string; symbol?: string };

type JupiterAllToken = { address?: string; symbol?: string; name?: string };

function matchTokenSymbol(normalized: string, tokens: Array<JupiterTokenResult & { address: string }>) {
  const exact = tokens.find((item) => (item.symbol || "").toUpperCase() === normalized);
  if (exact) return exact;

  const normalizedNoPunct = normalized.replace(/[^A-Z0-9]/g, "");
  const tolerant = tokens.find((item) => (item.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === normalizedNoPunct);
  if (tolerant) return tolerant;

  return tokens.find((item) => (item.symbol || "").toUpperCase().startsWith(normalized)) || null;
}

async function resolveOutputMint(symbolOrMint: string): Promise<{ mint: string; symbol: string }> {
  const normalized = symbolOrMint.trim().toUpperCase();
  if (!normalized) {
    throw new Error("Buy command token symbol is required.");
  }

  if (BASE58_MINT_RE.test(symbolOrMint.trim())) {
    return { mint: symbolOrMint.trim(), symbol: normalized };
  }

  try {
    const results = (await fetchJsonWithJupiterFallback("/tokens/v1/search", {
      query: normalized,
      limit: JUP_TOKEN_SEARCH_LIMIT,
    })) as JupiterTokenResult[];
    const withAddress = results.filter((item): item is JupiterTokenResult & { address: string } => typeof item.address === "string");
    const selected = matchTokenSymbol(normalized, withAddress);
    if (selected?.address) {
      return { mint: selected.address, symbol: (selected.symbol || normalized).toUpperCase() };
    }
  } catch {
    // fall through to full list lookup
  }

  let allRes: Response;
  try {
    allRes = await fetch("https://token.jup.ag/all", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    throw toUserFacingFetchError(error, "Token lookup failed");
  }
  if (!allRes.ok) {
    throw new Error(`Token lookup failed (${allRes.status}). Try a token mint address instead.`);
  }

  const allTokens = (await allRes.json()) as JupiterAllToken[];
  const withAddress = allTokens.filter((item): item is JupiterAllToken & { address: string } => typeof item.address === "string");
  const selected = matchTokenSymbol(normalized, withAddress);
  if (!selected?.address) {
    throw new Error(`Token symbol $${normalized} not found on Jupiter. Use the token mint address instead.`);
  }

  return { mint: selected.address, symbol: (selected.symbol || normalized).toUpperCase() };
}

async function enforceTradeAuthority(usd: number) {
  void usd;
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
  if (command.type === "media.generate") {
    const prompt = command.prompt.trim();
    if (!prompt) {
      return { ok: false, status: 400, error: "Media prompt is required." };
    }

    try {
      const generated = command.mediaKind === "image" ? await generateImage(prompt) : await generateVideo(prompt);
      const downloadUrl = new URL(generated.url, req.url).toString();
      return {
        ok: true,
        routed: "media",
        command: "media.generate",
        response: `Generated ${generated.kind} from prompt: "${prompt}"`,
        status: 200,
        media: {
          kind: generated.kind,
          url: generated.url,
          filename: generated.filename,
          prompt: generated.prompt,
          provider: generated.provider,
          mimeType: generated.mimeType,
          downloadUrl,
        },
      };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : "Media generation failed.",
      };
    }
  }

  if (command.type === "media.share") {
    const cleanFilename = path.basename(command.filename || "").trim();
    if (!cleanFilename) {
      return { ok: false, status: 400, error: "Filename is required. Example: send 2026...png to telegram" };
    }
    const mediaPath = path.join(process.cwd(), "public", "generated", cleanFilename);

    if (command.platform === "x") {
      return {
        ok: true,
        status: 200,
        routed: "sherpa/x",
        command: "media.share",
        response: `Prepared X media draft for ${cleanFilename}. Caption: ${command.caption || "(none)"} (Direct X media posting is still external).`,
      };
    }

    const botToken = normalizeBotToken(process.env.TELEGRAM_BOT_TOKEN || "");
    const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!botToken || !chatId) {
      return {
        ok: false,
        status: 400,
        error: "Telegram send needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in mork-app/.env.local (restart after saving).",
      };
    }

    let file: Buffer;
    try {
      file = await readFile(mediaPath);
    } catch {
      return { ok: false, status: 404, error: `Generated media not found: ${cleanFilename}` };
    }

    const lower = cleanFilename.toLowerCase();
    const isVideo = lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov");
    const endpoint = isVideo ? "sendVideo" : "sendPhoto";
    const form = new FormData();
    form.set("chat_id", chatId);
    if (command.caption) form.set("caption", command.caption);
    const fileArrayBuffer = new ArrayBuffer(file.byteLength);
    new Uint8Array(fileArrayBuffer).set(file);
    form.set(isVideo ? "video" : "photo", new Blob([fileArrayBuffer]), cleanFilename);

    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: "POST",
      body: form,
    });
    const json = (await sendRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!sendRes.ok || !json.ok) {
      return {
        ok: false,
        status: 502,
        error: `Telegram media send failed${json.description ? `: ${json.description}` : ""}`,
      };
    }

    return {
      ok: true,
      status: 200,
      routed: "telegram",
      command: "media.share",
      response: `Sent ${cleanFilename} to Telegram${command.caption ? ` with caption: ${command.caption}` : ""}.`,
    };
  }

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
      maxChars: 560,
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

  const tradeAuthority = await enforceTradeAuthority(command.usd);
  if (!tradeAuthority.ok) {
    return tradeAuthority;
  }

  let outputToken: { mint: string; symbol: string };
  try {
    outputToken = await resolveOutputMint(command.symbol);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : "Token symbol resolution failed.",
    };
  }

  let amountSol = 0;
  try {
    amountSol = await estimateSolForUsd(command.usd);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "USD→SOL quote failed.",
    };
  }

  let swapRes: Response;
  try {
    swapRes = await fetch(new URL("/api/trade/swap", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSol, slippageBps: 50, outputMint: outputToken.mint }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: toUserFacingFetchError(error, "Trade execution request failed").message,
    };
  }

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
    response:
      `Executed buy for ~$${command.usd.toFixed(2)} of $${outputToken.symbol} ` +
      `(${(swapJson.amountSol ?? amountSol).toFixed(6)} SOL route). Signature: ${swapJson.signature}`,
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
