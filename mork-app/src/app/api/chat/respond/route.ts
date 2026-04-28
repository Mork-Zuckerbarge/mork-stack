import { NextRequest, NextResponse } from "next/server";
import { respondToChat } from "@/lib/core/chat";
import { getOrchestratorState, startRuntime, stopRuntime } from "@/lib/core/orchestrator";
import { getAppControlState } from "@/lib/core/appControl";
import { prisma } from "@/lib/core/prisma";
import { generateImage, generateVideo } from "@/lib/core/media";
import { getWalletBalancesForMints } from "@/lib/core/wallet";
import { ensurePlannerAutopilotStarted } from "@/lib/core/plannerAutopilot";
import { POST as runPlannerTickRoute } from "@/app/planner/tick/route";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type ChatChannel = "system" | "telegram" | "x";

type RoutedCommand =
  | { type: "tweet"; text: string }
  | { type: "telegram"; text: string }
  | { type: "media.generate"; mediaKind: "image" | "video"; prompt: string }
  | { type: "media.share"; platform: "telegram" | "x" | "sherpa"; filename: string; caption: string }
  | { type: "trade"; quantity: number; inputSymbol: string; outputSymbol: string }
  | { type: "trade.sellAll"; inputSymbol: string; outputSymbol: string }
  | { type: "trade.autosearch" }
  | { type: "services.status" }
  | { type: "service.start"; service: "arb" | "sherpa" }
  | { type: "service.stop"; service: "arb" | "sherpa" };

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const LAST_TRADE_FACT_KEY = "__agent_last_trade_iso_v1__";
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JUP_TOKEN_SEARCH_LIMIT = "100";
const STATIC_SYMBOL_MINT_MAP: Record<string, string> = {
  SOL: SOL_MINT,
  USDC: USDC_MINT,
  BTC: BTC_MINT,
  WBTC: BTC_MINT,
  BBQ: BBQ_MINT,
};
const WORD_NUMBER_USD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function parseUsdAmount(raw: string): number | null {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return WORD_NUMBER_USD[raw.trim().toLowerCase()] ?? null;
}

function normalizeTokenRef(raw: string): string {
  const trimmed = raw.trim().replace(/^\$+/, "");
  if (!trimmed) return "";
  if (BASE58_MINT_RE.test(trimmed)) return trimmed;
  return trimmed.toUpperCase();
}

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
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) { lastError = new Error(`${path} failed on ${base} (${res.status})`); continue; }
      return await res.json();
    } catch (error) { lastError = error; }
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
  if (trimmed.toLowerCase().startsWith("bot")) return trimmed.slice(3).trim();
  return trimmed;
}

function parseCommand(message: string): RoutedCommand | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";

  const tweetMatch =
    firstLine.match(/^hey\s+tweet\s+this\s*:\s*(.+)$/i) ||
    firstLine.match(/^(?:tweet|post)\s+this\s+(?:on\s+)?x\s*:\s*(.+)$/i) ||
    firstLine.match(/^x\s+post\s*:\s*(.+)$/i);
  if (tweetMatch?.[1]?.trim()) return { type: "tweet", text: tweetMatch[1].trim() };

  const telegramMatch =
    firstLine.match(/^(?:post\s+to\s+telegram|post\s+this\s+in\s+telegram|telegram\s+post|send\s+to\s+telegram)\s*:\s*(.+)$/i) ||
    firstLine.match(/^hey\s+telegram\s+this\s*:\s*(.+)$/i);
  if (telegramMatch?.[1]?.trim()) return { type: "telegram", text: telegramMatch[1].trim() };

  const imageMatch =
    firstLine.match(/^(?:generate|create|make)\s+(?:an?\s+)?image\s*:\s*(.+)$/i) ||
    firstLine.match(/^image\s*:\s*(.+)$/i);
  if (imageMatch?.[1]?.trim()) return { type: "media.generate", mediaKind: "image", prompt: imageMatch[1].trim() };

  const videoMatch =
    firstLine.match(/^(?:generate|create|make)\s+(?:an?\s+)?video(?:\s*:\s*|\s+)(.+)$/i) ||
    firstLine.match(/^video\s*:\s*(.+)$/i);
  if (videoMatch?.[1]?.trim()) return { type: "media.generate", mediaKind: "video", prompt: videoMatch[1].trim() };

  const sendMediaMatch = firstLine.match(
    /^(?:send|load)\s+([a-z0-9._-]+)\s+to\s+(telegram|x|sherpa)(?:\s+with\s+caption\s*:\s*(.+))?\s*$/i
  );
  if (sendMediaMatch?.[1]?.trim()) {
    return {
      type: "media.share",
      filename: sendMediaMatch[1].trim(),
      platform: sendMediaMatch[2].toLowerCase() as "telegram" | "x" | "sherpa",
      caption: sendMediaMatch[3]?.trim() || "",
    };
  }

  const tradeAllMatch =
    firstLine.match(/^trade\s+all\s+\$?([a-z0-9._-]+)\s+(?:for|to)\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^swap\s+all\s+\$?([a-z0-9._-]+)\s+(?:for|to)\s+\$?([a-z0-9._-]+)\s*$/i);
  if (tradeAllMatch) {
    return {
      type: "trade.sellAll",
      inputSymbol: normalizeTokenRef(tradeAllMatch[1]),
      outputSymbol: normalizeTokenRef(tradeAllMatch[2] || "USDC"),
    };
  }

  const tradeMatch =
    firstLine.match(/^(?:market\s+)?trade\s+\$?(\d+(?:\.\d+)?)\s+\$?([a-z0-9._-]+)\s+for\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^go\s+buy\s+\$?(\d+(?:\.\d+)?)\s+of\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^buy\s+\$?(\d+(?:\.\d+)?)\s+(?:of\s+)?\$?([a-z0-9._-]+)(?:\s+now)?\s*$/i) ||
    firstLine.match(/^ape\s+\$?(\d+(?:\.\d+)?)\s+into\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^use\s+\$?(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\s+to\s+buy\s+\$?([a-z0-9._-]+)\s*$/i);
  if (tradeMatch) {
    if (/for/i.test(firstLine)) {
      return {
        type: "trade",
        quantity: Number(tradeMatch[1]),
        inputSymbol: normalizeTokenRef(tradeMatch[2]),
        outputSymbol: normalizeTokenRef(tradeMatch[3]),
      };
    }
    return { type: "trade", quantity: Number(tradeMatch[1]), inputSymbol: "USDC", outputSymbol: normalizeTokenRef(tradeMatch[2]) };
  }

  const sellAllMatch =
    firstLine.match(/^sell\s+all\s+\$?([a-z0-9._-]+)\s+for\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^sell\s+all\s+\$?([a-z0-9._-]+)\s*$/i);
  if (sellAllMatch) {
    return {
      type: "trade.sellAll",
      inputSymbol: normalizeTokenRef(sellAllMatch[1]),
      outputSymbol: normalizeTokenRef(sellAllMatch[2] || "USDC"),
    };
  }

  const buyWordsMatch =
    firstLine.match(/^buy:\s*([a-z]+)\s+dollars?\s+of\s+\$?([a-z0-9._-]+)(?:\s+with\s+\$?(usdc|usd))?\s*$/i) ||
    firstLine.match(/^buy\s+([a-z]+)\s+dollars?\s+of\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^use\s+([a-z]+)\s*(?:usdc|usd|dollars?)\s+to\s+buy\s+\$?([a-z0-9._-]+)\s*$/i) ||
    firstLine.match(/^.*use\s+(?:the\s+)?usdc\s+to\s+buy\s+([a-z]+)\s+dollars?\s+of\s+\$?([a-z0-9._-]+)\s*$/i);
  if (buyWordsMatch) {
    const quantity = parseUsdAmount(buyWordsMatch[1]);
    if (quantity) return { type: "trade", quantity, inputSymbol: "USDC", outputSymbol: normalizeTokenRef(buyWordsMatch[2]) };
  }

  if (
    /(?:search|scan|look)\s+for\s+trade\s+opportunit(?:y|ies)/i.test(trimmed) ||
    /scann(?:ing)?\s+for\s+trade\s+opportunit(?:y|ies)/i.test(trimmed) ||
    /what\s+trade\s+opportunit(?:y|ies).*(?:scan|search|find)/i.test(trimmed) ||
    /automated\s+trades?\s+on\s+(?:your|its)\s+own/i.test(trimmed) ||
    /make\s+.*automated\s+trades?/i.test(trimmed)
  ) {
    return { type: "trade.autosearch" };
  }

  if (/^(?:services|service)\s+(?:status|list|show)$/i.test(trimmed) || /^show\s+services$/i.test(trimmed)) {
    return { type: "services.status" };
  }

  const startMatch = trimmed.match(/^(?:start|enable)\s+(arb|sherpa)\s*$/i);
  if (startMatch) return { type: "service.start", service: startMatch[1].toLowerCase() as "arb" | "sherpa" };

  const stopMatch = trimmed.match(/^(?:stop|disable)\s+(arb|sherpa)\s*$/i);
  if (stopMatch) return { type: "service.stop", service: stopMatch[1].toLowerCase() as "arb" | "sherpa" };

  return null;
}

function parseVibeMediaCommand(message: string): RoutedCommand | null {
  const trimmed = message.trim();
  if (!trimmed || trimmed.endsWith("?")) return null;

  const hasVideoWord = /\b(video|clip|reel|animation)\b/i.test(trimmed);
  const hasImageWord = /\b(image|photo|picture|pic|artwork|art)\b/i.test(trimmed);
  const requestCue =
    /\b(make|create|generate|render|craft|produce|show|give)\b/i.test(trimmed) ||
    /^(can|could|would)\s+you\b/i.test(trimmed) ||
    /^(please|pls)\b/i.test(trimmed) ||
    /^i\s+(?:want|need)\b/i.test(trimmed) ||
    /^let'?s\b/i.test(trimmed);

  if (!requestCue || (!hasVideoWord && !hasImageWord)) return null;
  if (hasVideoWord && hasImageWord) return null;

  const prompt = trimmed
    .replace(/^(?:can|could|would)\s+you\s+/i, "")
    .replace(/^(?:please|pls)\s+/i, "")
    .replace(/^i\s+(?:want|need)(?:\s+you\s+to)?\s+/i, "")
    .replace(/^let'?s\s+/i, "")
    .replace(/\b(?:make|create|generate|render|craft|produce|show|give)\b/gi, "")
    .replace(/\b(?:me|us)\b/gi, "")
    .replace(/\b(?:a|an|the)\b/gi, " ")
    .replace(/\b(?:video|clip|reel|animation|image|photo|picture|pic|artwork|art)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    type: "media.generate",
    mediaKind: hasVideoWord ? "video" : "image",
    prompt: prompt || trimmed,
  };
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
  if (!Number.isFinite(outLamports) || outLamports <= 0) throw new Error("SOL conversion quote returned no output");
  return outLamports / 1_000_000_000;
}

type JupiterTokenResult = { address?: string; symbol?: string };
type JupiterAllToken = { address?: string; symbol?: string; name?: string; decimals?: number };
type JupiterTokenMeta = { decimals?: number };

function matchTokenSymbol(normalized: string, tokens: Array<JupiterTokenResult & { address: string }>) {
  const exact = tokens.filter((item) => (item.symbol || "").toUpperCase() === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Token symbol $${normalized} is ambiguous on Jupiter. Use the token mint address instead.`);
  const noPunct = normalized.replace(/[^A-Z0-9]/g, "");
  const tolerant = tokens.filter((item) => (item.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === noPunct);
  if (tolerant.length === 1) return tolerant[0];
  if (tolerant.length > 1) throw new Error(`Token symbol $${normalized} is ambiguous on Jupiter. Use the token mint address instead.`);
  return null;
}

async function resolveTokenMint(symbolOrMint: string): Promise<{ mint: string; symbol: string }> {
  const normalized = symbolOrMint.trim().replace(/^\$+/, "").replace(/[^A-Za-z0-9]+$/g, "").toUpperCase();
  if (!normalized) throw new Error("Buy command token symbol is required.");

  const staticMint = STATIC_SYMBOL_MINT_MAP[normalized];
  if (staticMint) return { mint: staticMint, symbol: normalized };

  if (BASE58_MINT_RE.test(symbolOrMint.trim())) return { mint: symbolOrMint.trim(), symbol: normalized };

  try {
    const results = (await fetchJsonWithJupiterFallback("/tokens/v1/search", {
      query: normalized,
      limit: JUP_TOKEN_SEARCH_LIMIT,
    })) as JupiterTokenResult[];
    const withAddress = results.filter((item): item is JupiterTokenResult & { address: string } => typeof item.address === "string");
    const selected = matchTokenSymbol(normalized, withAddress);
    if (selected?.address) return { mint: selected.address, symbol: (selected.symbol || normalized).toUpperCase() };
  } catch { /* fall through */ }

  let allRes: Response;
  try {
    allRes = await fetch("https://token.jup.ag/all", { headers: { Accept: "application/json" }, cache: "no-store" });
  } catch (error) {
    throw toUserFacingFetchError(error, "Token lookup failed");
  }
  if (!allRes.ok) throw new Error(`Token lookup failed (${allRes.status}). Try a token mint address instead.`);

  const allTokens = (await allRes.json()) as JupiterAllToken[];
  const withAddress = allTokens.filter((item): item is JupiterAllToken & { address: string } => typeof item.address === "string");
  const selected = matchTokenSymbol(normalized, withAddress);
  if (!selected?.address) throw new Error(`Token symbol $${normalized} not found on Jupiter. Use the token mint address instead.`);
  return { mint: selected.address, symbol: (selected.symbol || normalized).toUpperCase() };
}

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT || mint === BTC_MINT) return 6;
  try {
    const token = (await fetchJsonWithJupiterFallback(`/tokens/v1/token/${mint}`, {})) as JupiterTokenMeta;
    const decimals = Number(token.decimals);
    if (Number.isFinite(decimals) && decimals >= 0) return decimals;
  } catch { /* fallback below */ }

  const allRes = await fetch("https://token.jup.ag/all", { headers: { Accept: "application/json" }, cache: "no-store" }).catch(() => null);
  if (!allRes?.ok) return 0;
  const allTokens = (await allRes.json()) as JupiterAllToken[];
  const token = allTokens.find((item) => item.address === mint);
  const decimals = Number(token?.decimals);
  return Number.isFinite(decimals) && decimals >= 0 ? decimals : 0;
}

async function estimateUsdNotional(inputMint: string, amountIn: number): Promise<number> {
  if (amountIn <= 0) return 0;
  if (inputMint === USDC_MINT) return amountIn;
  const decimals = await getTokenDecimals(inputMint);
  if (decimals < 0 || decimals > 12) throw new Error("Unable to resolve input token decimals for risk check.");
  const amountBaseUnits = Math.floor(amountIn * 10 ** decimals);
  if (amountBaseUnits <= 0) throw new Error("Trade quantity is too small for token precision.");
  const quote = (await fetchJsonWithJupiterFallback("/swap/v1/quote", {
    inputMint,
    outputMint: USDC_MINT,
    amount: String(amountBaseUnits),
    slippageBps: "50",
  })) as { outAmount?: string };
  const outAmount = Number(quote.outAmount ?? 0);
  if (!Number.isFinite(outAmount) || outAmount <= 0) throw new Error("Unable to estimate USD notional for trade guard.");
  return outAmount / 1_000_000;
}

async function resolveSellAllQuantity(inputMint: string): Promise<number> {
  const balances = await getWalletBalancesForMints([inputMint]);
  const raw = Number(balances[inputMint] ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (inputMint === SOL_MINT) return Math.max(0, raw - 0.01);
  return raw;
}

async function enforceTradeAuthority(usd: number) {
  const control = await getAppControlState();
  const authority = control.controls.executionAuthority;

  if (authority.mode === "emergency_stop") {
    return { ok: false, status: 403, error: "Trading disabled: emergency_stop mode is active." } as const;
  }
  if (authority.mode === "user_only") {
    return { ok: false, status: 403, error: "Trading disabled: execution authority is user_only. Change to agent_assisted in App Controls." } as const;
  }
  if (usd > authority.maxTradeUsd) {
    return { ok: false, status: 400, error: `Trade amount $${usd.toFixed(2)} exceeds the configured max of $${authority.maxTradeUsd}.` } as const;
  }

  const lastTradeRow = await prisma.memoryFact.findUnique({ where: { key: LAST_TRADE_FACT_KEY } });
  if (lastTradeRow?.value) {
    const lastMs = new Date(lastTradeRow.value).getTime();
    const cooldownMs = authority.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastMs;
    if (elapsed < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return { ok: false, status: 429, error: `Trade cooldown active: ${remainSec}s remaining (cooldown=${authority.cooldownMinutes}min).` } as const;
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
  if (command.type === "media.generate") {
    const prompt = command.prompt.trim();
    if (!prompt) return { ok: false, status: 400, error: "Media prompt is required." };
    try {
      const generated = command.mediaKind === "image" ? await generateImage(prompt) : await generateVideo(prompt);
      const downloadUrl = new URL(generated.url, req.url).toString();
      return {
        ok: true, routed: "media", command: "media.generate",
        response: `Generated ${generated.kind} from prompt: "${prompt}"`,
        status: 200,
        media: { kind: generated.kind, url: generated.url, filename: generated.filename, prompt: generated.prompt, provider: generated.provider, mimeType: generated.mimeType, downloadUrl },
      };
    } catch (error) {
      return { ok: false, status: 502, error: error instanceof Error ? error.message : "Media generation failed." };
    }
  }

  if (command.type === "media.share") {
    const cleanFilename = path.basename(command.filename || "").trim();
    if (!cleanFilename) return { ok: false, status: 400, error: "Filename is required. Example: send 2026...png to telegram" };
    const mediaPath = path.join(process.cwd(), "public", "generated", cleanFilename);

    if (command.platform === "x" || command.platform === "sherpa") {
      const queuedTopic = command.caption || cleanFilename;
      const queueFile = path.join(process.cwd(), "..", "services", "sherpa", "current_topic_from_app.txt");
      try {
        await mkdir(path.dirname(queueFile), { recursive: true });
        await writeFile(queueFile, queuedTopic, "utf8");
      } catch {
        return { ok: false, status: 500, error: "Could not queue topic for Sherpa. Verify services/sherpa is writable." };
      }
      return { ok: true, status: 200, routed: "sherpa/x", command: "media.share", response: `Loaded ${cleanFilename} into Sherpa Current Topic/Story. Caption queued: ${command.caption || "(none)"}.` };
    }

    const botToken = normalizeBotToken(process.env.TELEGRAM_BOT_TOKEN || "");
    const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!botToken || !chatId) {
      return { ok: false, status: 400, error: "Telegram send needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in mork-app/.env.local (restart after saving)." };
    }

    let file: Buffer;
    try { file = await readFile(mediaPath); }
    catch { return { ok: false, status: 404, error: `Generated media not found: ${cleanFilename}` }; }

    const lower = cleanFilename.toLowerCase();
    const isVideo = lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov");
    const endpoint = isVideo ? "sendVideo" : "sendPhoto";
    const form = new FormData();
    form.set("chat_id", chatId);
    if (command.caption) form.set("caption", command.caption);
    const fileArrayBuffer = new ArrayBuffer(file.byteLength);
    new Uint8Array(fileArrayBuffer).set(file);
    form.set(isVideo ? "video" : "photo", new Blob([fileArrayBuffer]), cleanFilename);

    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, { method: "POST", body: form });
    const json = (await sendRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!sendRes.ok || !json.ok) {
      return { ok: false, status: 502, error: `Telegram media send failed${json.description ? `: ${json.description}` : ""}` };
    }
    return { ok: true, status: 200, routed: "telegram", command: "media.share", response: `Sent ${cleanFilename} to Telegram${command.caption ? ` with caption: ${command.caption}` : ""}.` };
  }

  if (command.type === "services.status") {
    const orchestrator = await getOrchestratorState();
    const authority = orchestrator.app.controls.executionAuthority;
    return {
      ok: true, routed: "orchestrator", command: "services.status",
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
    return { ok: true, routed: "orchestrator", command: "service.start", response: `Started ${command.service}. Current status: arb=${orchestrator.app.arb.status}, sherpa=${orchestrator.app.sherpa.status}.`, status: 200 };
  }

  if (command.type === "service.stop") {
    await stopRuntime(command.service);
    const orchestrator = await getOrchestratorState();
    return { ok: true, routed: "orchestrator", command: "service.stop", response: `Stopped ${command.service}. Current status: arb=${orchestrator.app.arb.status}, sherpa=${orchestrator.app.sherpa.status}.`, status: 200 };
  }

  if (command.type === "tweet") {
    const draft = await respondToChat({ channel: "x", handle: "app-user", message: `Draft an X post using this user-provided text. Keep intent and key wording intact unless it violates policy: ${command.text}`, maxChars: 560 });
    return { ok: true, routed: "sherpa/x", command: "tweet", response: draft.response || command.text, status: 200, note: "Draft generated for X voice. Sherpa posting remains external unless wired to X credentials." };
  }

  if (command.type === "trade.autosearch") {
    const plannerResponse = await runPlannerTickRoute();
    const plannerJson = (await plannerResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: string;
      reason?: string;
      minutesRemaining?: number;
      signature?: string | null;
      usd?: number;
      outputMint?: string;
      error?: string;
    };
    if (plannerJson.status === "executed") {
      return {
        ok: true,
        status: 200,
        routed: "planner",
        command: "trade.autosearch",
        response: `Autonomous trade scan executed and placed a trade${plannerJson.usd ? ` ($${plannerJson.usd.toFixed(2)} target)` : ""}${plannerJson.signature ? `, signature: ${plannerJson.signature}` : ""}.`,
      };
    }
    if (plannerJson.status === "hold") {
      return {
        ok: true,
        status: 200,
        routed: "planner",
        command: "trade.autosearch",
        response: `Autonomous trade scan executed. Decision: HOLD (${plannerJson.reason || "no qualifying setup"}).`,
      };
    }
    if (plannerJson.status === "skipped") {
      const cooldownDetail =
        plannerJson.reason === "cooldown_active" && typeof plannerJson.minutesRemaining === "number"
          ? ` (${plannerJson.minutesRemaining.toFixed(1)} min remaining)`
          : "";
      return {
        ok: true,
        status: 200,
        routed: "planner",
        command: "trade.autosearch",
        response: `Autonomous trade scan did not run: ${plannerJson.reason || "skipped"}${cooldownDetail}.`,
      };
    }
    return {
      ok: false,
      status: plannerResponse.status || 500,
      error: plannerJson.error || plannerJson.reason || "Autonomous trade scan failed.",
    };
  }

  if (command.type === "telegram") {
    const botToken = normalizeBotToken(process.env.TELEGRAM_BOT_TOKEN || "");
    const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!botToken || !chatId) {
      return { ok: false, status: 400, error: "Telegram send needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in mork-app/.env.local (restart after saving)." };
    }
    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: command.text }),
    });
    const json = (await sendRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!sendRes.ok || !json.ok) {
      return { ok: false, status: 502, error: `Telegram send failed${json.description ? `: ${json.description}` : ""}` };
    }
    return { ok: true, routed: "telegram", command: "post", response: `Posted to Telegram: ${command.text}`, status: 200 };
  }

  const requestedQuantity = command.type === "trade" ? command.quantity : Number.NaN;
  if (command.type === "trade" && (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0)) {
    return { ok: false, status: 400, error: "Trade quantity must be a positive number." };
  }

  const normalizedInput = normalizeTokenRef(command.inputSymbol);
  const normalizedOutput = normalizeTokenRef(command.outputSymbol);
  if (!normalizedInput || !normalizedOutput) {
    return { ok: false, status: 400, error: "Trade command requires both input and output symbols." };
  }
  let inputToken: { mint: string; symbol: string };
  let outputToken: { mint: string; symbol: string };
  try {
    inputToken = await resolveTokenMint(normalizedInput);
    outputToken = await resolveTokenMint(normalizedOutput);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : "Token symbol resolution failed." };
  }
  if (inputToken.mint === outputToken.mint) {
    return { ok: false, status: 400, error: "Input and output tokens resolve to the same mint. Choose two different tokens." };
  }

  let quantity = requestedQuantity;
  if (command.type === "trade.sellAll") {
    try {
      quantity = await resolveSellAllQuantity(inputToken.mint);
    } catch (error) {
      return { ok: false, status: 500, error: error instanceof Error ? error.message : "Could not read wallet balance for sell all." };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, status: 400, error: `No ${inputToken.symbol} balance available to sell.` };
    }
  }

  let usdNotional = quantity;
  if (inputToken.mint !== USDC_MINT) {
    try {
      usdNotional = await estimateUsdNotional(inputToken.mint, quantity);
    } catch (error) {
      return { ok: false, status: 400, error: error instanceof Error ? error.message : "Could not estimate trade notional." };
    }
  }
  const tradeAuthority = await enforceTradeAuthority(usdNotional);
  if (!tradeAuthority.ok) return tradeAuthority;

  let swapRes: Response;
  try {
    swapRes = await fetch(new URL("/api/trade/swap", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountIn: quantity,
        inputMint: inputToken.mint,
        outputMint: outputToken.mint,
        slippageBps: 50,
        agentInitiated: true,
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: toUserFacingFetchError(error, "Trade execution request failed").message };
  }

  const swapJson = (await swapRes.json().catch(() => ({}))) as { ok?: boolean; error?: string; signature?: string; amountIn?: number };
  if (!swapRes.ok || !swapJson.ok) {
    return { ok: false, status: swapRes.status || 500, error: swapJson.error || `Trade execution failed (${swapRes.status})` };
  }

  await noteTradeExecution();
  return {
    ok: true, routed: "arb", command: "trade",
    response: `Executed market trade: quantity ${Number(swapJson.amountIn ?? quantity).toFixed(6)} $${inputToken.symbol} for $${outputToken.symbol}. Signature: ${swapJson.signature}`,
    status: 200,
  };
}

export async function POST(req: NextRequest) {
  try {
    ensurePlannerAutopilotStarted();
    const body = await req.json();
    const message = typeof body?.message === "string" ? body.message : "";
    const command = parseCommand(message) || parseVibeMediaCommand(message);

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
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "chat route failed" }, { status: 500 });
  }
}
