import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getOrchestratorState } from "@/lib/core/orchestrator";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

    const outItems = [runtimeSummary, ...items];

    if (items.length === 0) {
      const logPath = path.resolve(process.cwd(), "..", ".logs", "arb.log");
      try {
        const raw = await readFile(logPath, "utf8");
        const lines = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-Math.max(limit - 1, 0))
          .map((line, idx) => ({
            id: `arb-log-${idx}`,
            createdAt: new Date().toISOString(),
            source: "arb-file",
            content: line.length > 400 ? `${line.slice(0, 400)}…` : line,
          }));

        outItems.push(...lines.reverse());
      } catch {
        // file tail fallback is best-effort only
      }
    }

    return NextResponse.json({
      ok: true,
      items: outItems.slice(0, limit),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "arb logs unavailable" },
      { status: 500 }
    );
  }
}
