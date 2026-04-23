import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";

export const runtime = "nodejs";

export async function GET() {
  const [telegramItems, routeResearchItems, latestEpisode, appControl] = await Promise.all([
    prisma.memory.findMany({
      where: {
        OR: [
          { content: { startsWith: "[IN/telegram" } },
          { content: { startsWith: "[OUT/telegram" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { createdAt: true, content: true, source: true },
    }),
    prisma.memory.findMany({
      where: {
        OR: [
          { content: { contains: '"kind":"route_research"' } },
          { content: { contains: '"kind":"trade_result"' } },
          { content: { startsWith: "direct_swap " } },
          { entities: { path: "$", string_contains: "arb:manual_swap" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { createdAt: true, content: true, source: true },
    }),
    prisma.episode.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, learned: true, summary: true },
    }),
    getAppControlState(),
  ]);

  return NextResponse.json({
    ok: true,
    telegram: {
      count: telegramItems.length,
      items: telegramItems,
    },
    arbLearning: {
      routeResearchCount: routeResearchItems.length,
      items: routeResearchItems,
    },
    latestEpisode,
    executionAuthority: appControl.controls.executionAuthority,
    arbRuntime: {
      armed: String(process.env.ARMED || "").toLowerCase() === "true",
      paper: String(process.env.PAPER || "true").toLowerCase() === "true",
    },
  });
}
