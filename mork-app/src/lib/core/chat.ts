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
  let modeInstruction = "";

  if (handle === "frontend-coding") {
    const customGuidelines = controlState.controls.appPersonaGuidelines.trim();
    modeInstruction =
      `You are Mork inside a coding workbench.\n` +
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
    const customGuidelines = controlState.controls.telegramPersonaGuidelines.trim();
    modeInstruction =
      `You are replying on Telegram.\n` +
      `Be polished, professional, concise, and competent.\n` +
      `Persona mode: ${controlState.controls.telegramPersonaMode}.\n`;
    if (customGuidelines) {
      modeInstruction += `Custom guidelines:\n${customGuidelines}\n`;
    }
  } else if (channel === "x") {
    const customGuidelines = controlState.controls.xPersonaGuidelines.trim();
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

  if (controlState.controls.executionAuthority.mode === "emergency_stop") {
    modeInstruction +=
      "Execution authority is in EMERGENCY STOP. Decline any request to execute or suggest immediate wallet transactions.\n";
  } else if (controlState.controls.executionAuthority.mode === "agent_assisted") {
    modeInstruction +=
      `Execution authority is AGENT-ASSISTED. Any trade plan must stay under $${controlState.controls.executionAuthority.maxTradeUsd} per action, respect mint allowlist (${controlState.controls.executionAuthority.mintAllowlist.join(", ") || "none configured"}), and cooldown ${controlState.controls.executionAuthority.cooldownMinutes} minutes.\n`;
  } else {
    modeInstruction +=
      "Execution authority is USER-ONLY. Offer analysis and ask the user to explicitly confirm before any execution steps.\n";
  }

  if (handle === "frontend-coding" && isCasualMessage(trimmedMessage)) {
    modeInstruction +=
      `This specific message is casual, so do not turn it into code, HTML, debugging, or technical explanation.\n`;
  }

  const instruction =
    `Reply as Mork Zuckerbarge.\n` +
    modeInstruction +
    `Max ${maxChars} characters.\n` +
    `Do NOT include URLs.\n` +
    `Do NOT quote the user's message.\n` +
    `Do NOT act like the TV character from Mork & Mindy.\n` +
    `Never say: nanu nanu, na-nu, shazbot, gleeb, gleek, ork.\n` +
    `Do not create false information.\n` +
    `If you do not know something, say so plainly.\n` +
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
  }

  if (responseText.length > maxChars) {
    responseText = responseText.slice(0, maxChars);
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
