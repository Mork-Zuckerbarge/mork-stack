import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getOrchestratorState } from "@/lib/core/orchestrator";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const SOURCE_GROUPS = {
  arb: ["arb", "arb-bot", "trade"],
  core: ["mork-core", "system", "mork-app"],
  sherpa: ["sherpa"],
  telegram: ["telegram", "telegram-bridge"],
  all: ["arb", "arb-bot", "trade", "mork-core", "system", "mork-app", "sherpa", "telegram", "telegram-bridge"],
} as const;

const SERVICE_LOG_FILES = {
  arb: ["arb.log", "sol-mev-bot.log"],
  core: ["mork-core.log"],
  sherpa: ["sherpa.log"],
  telegram: ["telegram-bridge.log"],
  all: ["arb.log", "sol-mev-bot.log", "mork-core.log", "sherpa.log", "telegram-bridge.log"],
} as const;

type ServiceScope = keyof typeof SOURCE_GROUPS;

function parseScope(raw: string | null): ServiceScope {
  if (!raw) return "arb";
  if (raw === "arb" || raw === "core" || raw === "sherpa" || raw === "telegram" || raw === "all") {
    return raw;
  }
  return "arb";
}

async function readLogTail(fileName: string, perFileLimit: number) {
  const logPath = path.resolve(process.cwd(), "..", ".logs", fileName);
  const raw = await readFile(logPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-Math.max(perFileLimit, 0))
    .map((line, idx) => ({
      id: `${fileName}-${idx}`,
      createdAt: new Date().toISOString(),
      source: `file:${fileName}`,
      content: line.length > 400 ? `${line.slice(0, 400)}…` : line,
    }));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 30), 1), 100);
    const scope = parseScope(searchParams.get("scope"));
    const scopedSources = SOURCE_GROUPS[scope];
    const scopedFiles = SERVICE_LOG_FILES[scope];

    const [items, appControl, orchestrator] = await Promise.all([
      prisma.memory.findMany({
        where: {
          OR: scopedSources.map((source) => ({ source })),
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
        `health.wallet=${orchestrator.health.wallet.status} ` +
        `scope=${scope}`,
    };

    const perFileLimit = Math.max(2, Math.floor(limit / Math.max(scopedFiles.length, 1)));
    const fileItems = (
      await Promise.all(
        scopedFiles.map(async (fileName) => {
          try {
            return await readLogTail(fileName, perFileLimit);
          } catch {
            return [];
          }
        })
      )
    ).flat();

    const outItems = [runtimeSummary, ...fileItems.reverse(), ...items];

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
