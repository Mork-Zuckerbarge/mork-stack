import { prisma } from "./prisma";
import { isMemoryEnabled, isPlannerEnabled } from "./appControl";

type BuildContextArgs = {
  handle?: string;
  channel: string;
  message: string;
};

function isTechnicalMessage(message: string) {
  const m = message.toLowerCase();

  return [
    "code",
    "debug",
    "bug",
    "function",
    "component",
    "react",
    "next",
    "typescript",
    "javascript",
    "python",
    "sql",
    "html",
    "css",
    "api",
    "server",
    "wallet",
    "trade",
    "arb",
    "token",
    "sol",
    "bbq",
    "error",
    "fix",
    "build",
    "compile",
    "query",
    "math",
    "calculate",
    "sqrt",
  ].some((x) => m.includes(x));
}

export async function buildContext({
  handle,
  channel,
  message,
}: BuildContextArgs) {
  if (!(await isMemoryEnabled())) {
    return `CURRENT MESSAGE:\n${message}`;
  }

  const technical = isTechnicalMessage(message);
  const plannerEnabled = await isPlannerEnabled();

  const [recentChat, walletMemory, tradeMemory, reflection, relationshipMemory] =
    await Promise.all([
      prisma.memory.findMany({
        where: {
          OR: [
            { source: "mork-app" },
            { source: "frontend-coding" },
            { source: channel },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),

      technical
        ? prisma.memory.findFirst({
            where: { source: "wallet" },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),

      technical
        ? prisma.memory.findFirst({
            where: {
              OR: [{ source: "arb-bot" }, { source: "trade" }],
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),

      plannerEnabled
        ? prisma.memory.findFirst({
            where: { type: "reflection" },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),

      handle
        ? prisma.memory.findFirst({
            where: {
              OR: [
                { source: "relationship" },
                { content: { contains: handle } },
              ],
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
    ]);

  const recentChatBlock = recentChat.length
    ? "RECENT HISTORY:\n" +
      [...recentChat]
        .reverse()
        .map((m) => `- [${m.source}/${m.type}] ${m.content}`)
        .join("\n")
    : "";

  const walletBlock = walletMemory
    ? `LATEST WALLET STATE:\n- ${walletMemory.content}`
    : "";

  const tradeBlock = tradeMemory
    ? `LATEST TRADE / ARB STATE:\n- ${tradeMemory.content}`
    : "";

  const reflectionBlock = reflection
    ? `LATEST REFLECTION:\n- ${reflection.content}`
    : "";

  const relationshipBlock = relationshipMemory
    ? `RELATIONSHIP MEMORY:\n- ${relationshipMemory.content}`
    : "";

  return [
    recentChatBlock,
    technical ? walletBlock : "",
    technical ? tradeBlock : "",
    reflectionBlock,
    relationshipBlock,
    `CURRENT MESSAGE:\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
