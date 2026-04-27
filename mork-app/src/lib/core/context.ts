import { prisma } from "./prisma";
import { getOrchestratorState, isMemoryEnabled, isPlannerEnabled } from "./orchestrator";
import { getPreflightStatus } from "@/lib/bootstrap/preflight";
import { getAppControlState } from "./appControl";

type BuildContextArgs = {
  handle?: string;
  channel: string;
  message: string;
};

const MAX_HISTORY_ITEMS = 4;
const MAX_RECENT_LINE_CHARS = 320;
const MAX_MEMORY_BLOCK_CHARS = 900;

function clipText(value: string | null | undefined, maxChars: number) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function isTechnicalMessage(message: string) {
  const m = message.toLowerCase();
  return [
    "code","debug","bug","function","component","react","next","typescript",
    "javascript","python","sql","html","css","api","server","wallet","trade",
    "arb","token","sol","bbq","error","fix","build","compile","query","math",
    "calculate","sqrt",
  ].some((x) => m.includes(x));
}

export async function buildContext({ handle, channel, message }: BuildContextArgs) {
  if (!(await isMemoryEnabled())) return `CURRENT MESSAGE:\n${message}`;

  const technical = isTechnicalMessage(message);
  const plannerEnabled = await isPlannerEnabled();
  const normalizedHandle = (handle || "").trim();

  const [recentChat, walletMemory, tradeMemory, reflection, relationshipMemory, appControl, orchestratorState, preflight] =
    await Promise.all([
      prisma.memory.findMany({
        where: { OR: [{ source: "mork-app" }, { source: "frontend-coding" }, { source: channel }] },
        orderBy: { createdAt: "desc" },
        take: MAX_HISTORY_ITEMS,
      }),
      technical ? prisma.memory.findFirst({ where: { source: "wallet" }, orderBy: { createdAt: "desc" } }) : Promise.resolve(null),
      technical ? prisma.memory.findFirst({ where: { OR: [{ source: "arb" }, { source: "arb-bot" }, { source: "trade" }] }, orderBy: { createdAt: "desc" } }) : Promise.resolve(null),
      plannerEnabled ? prisma.memory.findFirst({ where: { type: "reflection" }, orderBy: { createdAt: "desc" } }) : Promise.resolve(null),
      normalizedHandle
        ? prisma.memory.findFirst({
            where: {
              OR: [
                { AND: [{ source: "relationship" }, { entities: { path: "$", string_contains: `handle:${normalizedHandle}` } }] },
                { content: { contains: normalizedHandle } },
              ],
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
      getAppControlState(),
      getOrchestratorState(),
      getPreflightStatus(),
    ]);

  const recentChatBlock = recentChat.length
    ? "RECENT HISTORY:\n" + [...recentChat].reverse().map((m) => `- [${m.source}/${m.type}] ${clipText(m.content, MAX_RECENT_LINE_CHARS)}`).join("\n")
    : "";

  const walletBlock = walletMemory ? `LATEST WALLET STATE:\n- ${clipText(walletMemory.content, MAX_MEMORY_BLOCK_CHARS)}` : "";
  const tradeBlock = tradeMemory ? `LATEST TRADE / ARB STATE:\n- ${clipText(tradeMemory.content, MAX_MEMORY_BLOCK_CHARS)}` : "";
  const reflectionBlock = reflection ? `LATEST REFLECTION:\n- ${clipText(reflection.content, MAX_MEMORY_BLOCK_CHARS)}` : "";
  const relationshipBlock = relationshipMemory ? `RELATIONSHIP MEMORY:\n- ${clipText(relationshipMemory.content, MAX_MEMORY_BLOCK_CHARS)}` : "";

  const failingHealth = Object.entries(orchestratorState.health)
    .filter(([, record]) => record.status === "degraded" || record.status === "stopped")
    .map(([component, record]) => `${component}: ${record.status} (${record.message})`);

  const failingChecks = preflight.checks.filter((check) => !check.ok).map((check) => `${check.key}: ${check.message}`);

  const operationsBlock = [
    "OPERATIONS SNAPSHOT:",
    `- arb: ${appControl.arb.status} (updated ${appControl.arb.updatedAt})`,
    `- sherpa: ${appControl.sherpa.status} (updated ${appControl.sherpa.updatedAt})`,
    `- startupCompleted: ${appControl.controls.startupCompleted}`,
    `- executionAuthority: ${appControl.controls.executionAuthority.mode} (maxTradeUsd ${appControl.controls.executionAuthority.maxTradeUsd}, cooldownMinutes ${appControl.controls.executionAuthority.cooldownMinutes})`,
    `- channels: telegram=${appControl.controls.telegramEnabled}, x=${appControl.controls.xEnabled}`,
    `- memoryEnabled: ${appControl.controls.memoryEnabled}, plannerEnabled: ${appControl.controls.plannerEnabled}`,
    failingHealth.length ? `- failingHealth: ${failingHealth.join("; ")}` : "- failingHealth: none",
    failingChecks.length ? `- failingPreflightChecks: ${failingChecks.join("; ")}` : "- failingPreflightChecks: none",
    "TASK CONTROL CAPABILITIES:",
    "- You can instruct users to use app control actions to start or stop ARB and Sherpa runtimes.",
    "- The app chat also supports direct commands: `show services`, `start arb`, `stop arb`, `start sherpa`, `stop sherpa`.",
    "- TRADE COMMANDS (executed immediately by the agent when typed in chat):",
    "  `buy $<amount> of <TOKEN>` — buys TOKEN using USDC→SOL→TOKEN via Jupiter (e.g. `buy $20 of BBQ`)",
    "  `go buy $<amount> of <TOKEN>` — same as above",
    "  `ape $<amount> into <TOKEN>` — same as above",
    "  `use $<amount> USDC to buy <TOKEN>` — same as above",
    "  TOKEN can be a symbol (SOL, BBQ, USDC, BTC) or a Solana mint address.",
    "  Requirements: MORK_AGENT_SWAP_ENABLED=1 must be set, execution authority must be agent_assisted, and amount must not exceed maxTradeUsd.",
    "- If the user asks to make a trade, respond with the exact command format and note any current blockers (authority mode, MORK_AGENT_SWAP_ENABLED, cooldown).",
    "- If the user asks to start tasks, answer with the exact action(s) needed and call out current blockers first.",
  ].join("\n");

  return [
    normalizedHandle ? `CURRENT SPEAKER:\n- handle: ${normalizedHandle}` : "",
    recentChatBlock,
    technical ? walletBlock : "",
    technical ? tradeBlock : "",
    reflectionBlock,
    relationshipBlock,
    operationsBlock,
    `CURRENT MESSAGE:\n${message}`,
  ].filter(Boolean).join("\n\n");
}
