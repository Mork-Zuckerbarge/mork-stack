import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getOrchestratorState } from "@/lib/core/orchestrator";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 30), 1), 100);

    const [items, appControl, orchestrator] = await Promise.all([
      prisma.memory.findMany({
        where: {
          OR: [{ source: "arb" }, { source: "arb-bot" }, { source: "trade" }],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          createdAt: true,
          source: true,
          content: true,
        },
      }),
      getAppControlState(),
      getOrchestratorState(),
    ]);

    const runtimeSummary = {
      id: "runtime-summary",
      createdAt: new Date().toISOString(),
      source: "orchestrator",
      content:
        `runtime arb=${appControl.arb.status} sherpa=${appControl.sherpa.status} ` +
        `startupCompleted=${appControl.controls.startupCompleted} ` +
        `health.arb=${orchestrator.health.arb.status} ` +
        `health.wallet=${orchestrator.health.wallet.status}`,
    };

    return NextResponse.json({
      ok: true,
      items: [runtimeSummary, ...items].slice(0, limit),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "arb logs unavailable" },
      { status: 500 }
    );
  }
}
