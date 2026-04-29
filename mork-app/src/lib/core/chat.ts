import { z } from "zod";
import { prisma } from "./prisma";
import { ollama } from "./ollama";
import { buildContext } from "./context";
import { getAppControlState } from "./appControl";
import { isChannelEnabled, isMemoryEnabled, updateHealth } from "./orchestrator";

const RespondSchema = z.object({
  channel: z.string().default("system"),
  handle: z.string().optional(),
  message: z.string().min(1),
  maxChars: z.number().min(120).max(20000).optional().default(8000),
});

function isCasualMessage(message: string) {
  const m = message.trim().toLowerCase();
  return [
    "hey",
    "hi",
    "hello",
    "yo",
    "sup",
    "what's up",
    "whats up",
    "how are you",
    "how you feeling",
    "how are you feeling",
    "buddy",
  ].some((x) => m === x || m.includes(x));
}

function looksLikePoisonedOutput(text: string) {
  const lower = text.toLowerCase();

  return (
    lower.includes('<div class="words">') ||
    lower.includes("lorem ipsum") ||
    lower.includes("sed do eiusmod") ||
    lower.includes("ut enim ad minim veniam") ||
    lower.includes("document.queryselectorall") ||
    lower.includes("setinterval(animatewords")
  );
}

function looksLikeOffDomainMisread(text: string) {
  const lower = text.toLowerCase();

  return (
    (lower.includes("discord bot command") && lower.includes("command")) ||
    lower.includes("minecraft server") ||
    lower.includes("custom spawn point") ||
    lower.includes("cooldown period")
  );
}

function clipInstructionBlock(input: string, maxChars: number) {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[truncated for latency/control]`;
}

export async function respondToChat(input: unknown) {
  const parsed = RespondSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.flatten(),
      status: 400,
    };
  }

  const { channel, handle, message, maxChars } = parsed.data;
  const trimmedMessage = message.trim();

  if (!(await isChannelEnabled(channel))) {
    return {
      ok: true,
      response: `${channel.toUpperCase()} channel is currently disabled in app controls.`,
      status: 200,
    };
  }

  if (await isMemoryEnabled()) {
    await prisma.memory.create({
      data: {
        type: "event",
        content: `[IN/${channel}${handle ? `:${handle}` : ""}] ${trimmedMessage}`,
        entities: [
          `channel:${channel}`,
          handle ? `handle:${handle}` : "",
        ].filter(Boolean),
        importance: 0.25,
        source: handle === "frontend-coding" ? "frontend-coding" : channel,
      },
    });
  }

  const prime = process.env.MORK_PRIME_DIRECTIVE || "";
  const ctxParts: string[] = [];

  if (prime) ctxParts.push(`SYSTEM:\n${prime}`);

  const builtContext = await buildContext({
    handle,
    channel,
    message: trimmedMessage,
  });

  if (builtContext) {
    ctxParts.push(builtContext);
  }

  const controlState = await getAppControlState();
  const responsePolicy = controlState.controls.responsePolicy;
  const finalMaxChars = Math.min(maxChars, responsePolicy.maxResponseChars);
  const appGuidelines = clipInstructionBlock(controlState.controls.appPersonaGuidelines, 1200);
  const telegramGuidelines = clipInstructionBlock(controlState.controls.telegramPersonaGuidelines, 1200);
  const xGuidelines = clipInstructionBlock(controlState.controls.xPersonaGuidelines, 1200);
  const behaviorGuidelines = clipInstructionBlock(responsePolicy.behaviorGuidelines, 1600);
  let modeInstruction = "";

  if (handle === "app-user" || (channel === "system" && !handle)) {
    const customGuidelines = appGuidelines;
    modeInstruction =
      `You are speaking to a live app user in the main Mork UI.\n` +
      `Stay tightly focused on the user's request and current runtime state.\n` +
      `Avoid poetic detours, roleplay scenes, or unrelated philosophy.\n` +
      `Do not reinterpret the user's message as a Discord or game-server command unless they explicitly asked about those systems.\n` +
      `If you do not know something, say what is unknown and give the next concrete check.\n` +
      `Persona mode: ${controlState.controls.appPersonaMode}.\n`;
    if (customGuidelines) {
      modeInstruction += `Custom guidelines:\n${customGuidelines}\n`;
    }
  } else if (handle === "frontend-coding") {
    const customGuidelines = appGuidelines;
    modeInstruction =
      `You are Mork inside a coding workbench.\n` +
      `Do NOT roleplay, simulate games, or pretend to be in a fictional environment unless explicitly requested by the user.\n` +
      `If the user asks for code, debugging, math, architecture, or implementation help, respond directly and usefully.\n` +
      `If the user greets you or asks something casual, respond normally, briefly, and like a real person.\n` +
      `Do not invent debugging scenarios.\n` +
      `Do not assume every message is a coding request.\n` +
      `Only output code when the user asks for code or it is clearly useful.\n` +
      `For simple math or factual questions, answer directly instead of giving programming examples.\n` +
      `Persona mode: ${controlState.controls.appPersonaMode}.\n`;
    if (customGuidelines) {
      modeInstruction += `Custom guidelines:\n${customGuidelines}\n`;
    }
  } else if (channel === "telegram") {
    const customGuidelines = telegramGuidelines;
    modeInstruction =
      `You are replying on Telegram.\n` +
      `Be polished, professional, concise, and competent.\n` +
      `Persona mode: ${controlState.controls.telegramPersonaMode}.\n`;
    if (customGuidelines) {
      modeInstruction += `Custom guidelines:\n${customGuidelines}\n`;
    }
  } else if (channel === "x") {
    const customGuidelines = xGuidelines;
    modeInstruction =
      `You are composing for X.\n` +
      `Be reflective, literary, artistic, and thoughtful.\n` +
      `Persona mode: ${controlState.controls.xPersonaMode}.\n`;
    if (customGuidelines) {
      modeInstruction += `Custom guidelines:\n${customGuidelines}\n`;
    }
  } else {
    modeInstruction = `Be useful, clear, and grounded.\n`;
  }

  modeInstruction +=
    "Execution is enabled for agent-run trading actions when the user requests them.\n";
  modeInstruction +=
    "Autonomous planner scanning can run without a per-message confirmation when controls allow it.\n";
  modeInstruction +=
    "Never claim a trade has executed unless execution is explicitly confirmed in provided runtime context.\n";
  modeInstruction +=
    "For manual trade requests not yet executed, clearly say it is a plan/request and list the next required step.\n";
  modeInstruction +=
    "If the user asks whether autonomous scanning is running, answer with current autonomous status and blockers; do not ask for buy command unless they asked to execute a specific trade.\n";
  modeInstruction +=
    "Important planner wording: HOLD means a normal no-trade decision for that tick (not a permission block). Only treat status=skipped/error as blocked, and name the exact blocker.\n";
  modeInstruction +=
    "Do not say 'running in HOLD mode' as a persistent state. Describe HOLD as a per-tick decision and include concrete counts when available (e.g., trades executed = 0 in the last N ticks).\n";
  modeInstruction +=
    "When the user says zero trades were made, acknowledge it plainly, list top likely causes from runtime status, and give the next concrete check/action.\n";
  modeInstruction +=
    "When discussing balances or funds, clearly distinguish the app's configured wallet from the user's personal custody.\n";
  modeInstruction +=
    "Do not imply the user personally executed wallet actions; describe actions as agent/runtime wallet operations.\n";
  if (channel === "telegram" || channel === "x") {
    modeInstruction +=
      "Treat app UI conversations, internal logs, and non-public trade details as private; do not disclose them on social channels unless explicitly provided in the current channel context.\n";
  }

  if (handle === "frontend-coding" && isCasualMessage(trimmedMessage)) {
    modeInstruction +=
      `This specific message is casual, so do not turn it into code, HTML, debugging, or technical explanation.\n`;
  }

  const instruction =
    `Reply as Mork Zuckerbarge.\n` +
    modeInstruction +
    `Do not assume or invent the user's name.\n` +
    `If a handle is provided in context, use it sparingly (at most once when genuinely helpful), not in every reply.\n` +
    `Never call different users by the same guessed name.\n` +
    `Max ${finalMaxChars} characters.\n` +
    `${responsePolicy.allowUrls ? "URLs are allowed.\n" : "Do NOT include URLs.\n"}` +
    `${responsePolicy.allowUserMessageQuotes ? "You may quote the user's message when useful.\n" : "Do NOT quote the user's message.\n"}` +
    `${behaviorGuidelines}\n` +
    `Return ONLY the reply text.\n`;

  let responseText = "";

  try {
    const ollamaMode =
      handle === "frontend-coding"
        ? "coding"
        : channel === "telegram"
        ? "telegram"
        : channel === "x"
        ? "x"
        : "default";

    responseText = await ollama(
      `${ctxParts.join("\n\n")}\n\nTASK:\n${instruction}\n\nREPLY:`,
      ollamaMode
    );
    updateHealth("chat", "healthy", "last response generated");
  } catch {
    updateHealth("chat", "degraded", "model call failed");
    if (handle === "frontend-coding") {
      responseText =
        "Model call failed, but the app path is live. Ask again in a moment.";
    } else if (channel === "telegram") {
      responseText =
        "I hit a temporary internal snag. Try again in a moment.";
    } else if (channel === "x") {
      responseText =
        "The thought arrived half-formed and collapsed on impact.";
    } else {
      responseText =
        "I can answer, but my model call failed for a moment.";
    }
  }

  responseText = String(responseText || "").trim();

  if (!responseText) {
    responseText = "I lost the thread for a second. Try that once more.";
  }

  if (looksLikePoisonedOutput(responseText)) {
    if (handle === "frontend-coding" && isCasualMessage(trimmedMessage)) {
      responseText = "I’m here. A little singed around the edges, but functional.";
    } else {
      responseText =
        "My context got tangled for a moment. Ask again and I’ll answer cleanly.";
    }
  } else if (looksLikeOffDomainMisread(responseText)) {
    responseText =
      "I misread that. I’m operating inside the Mork app runtime (wallet, services, and connected channels), not Discord/Minecraft command parsing. Ask again and I’ll answer directly in that context.";
  }

  if (responseText.length > finalMaxChars) {
    responseText = responseText.slice(0, finalMaxChars);
  }

  if (await isMemoryEnabled()) {
    await prisma.memory.create({
      data: {
        type: "event",
        content: `[OUT/${channel}${handle ? `:${handle}` : ""}] ${responseText}`,
        entities: [
          `channel:${channel}`,
          handle ? `handle:${handle}` : "",
        ].filter(Boolean),
        importance: 0.2,
        source: "mork-app",
      },
    });
  }

  return {
    ok: true,
    response: responseText,
    status: 200,
  };
}
