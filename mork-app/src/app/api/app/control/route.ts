import { NextRequest, NextResponse } from "next/server";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getOrchestratorState,
  startOrchestrator,
  stopOrchestrator,
  setRuntimeExecutionAuthority,
  setRuntimeFlag,
  setRuntimeModel,
  setRuntimePersonaGuidelines,
  setRuntimePersonaMode,
  setRuntimeStartupCompleted,
  setRuntimeActivePanel,
  setRuntimeStrategyEngines,
  setRuntimeResponsePolicy,
  flushRuntimeConversationMemory,
  startRuntime,
  stopRuntime,
} from "@/lib/core/orchestrator";

type Action =
  | "orchestrator.start"
  | "orchestrator.stop"
  | "arb.start"
  | "arb.stop"
  | "sherpa.start"
  | "sherpa.stop"
  | "controls.set"
  | "persona.mode.set"
  | "persona.guidelines.set"
  | "ollama.model.set"
  | "startup.completed.set"
  | "execution.authority.set"
  | "response.params.set"
  | "runtime.panel.set"
  | "strategy.engines.set"
  | "openai.mode.set"
  | "memory.flush";

function getArbRuntimeFromEnv() {
  return {
    armed: String(process.env.ARMED || "").toLowerCase() === "true",
    paper: String(process.env.PAPER || "true").toLowerCase() === "true",
  };
}

function getTradeRuntimeFromEnv() {
  return {
    swapEnabled: process.env.MORK_AGENT_SWAP_ENABLED === "1",
    maxSwapSol: Number(process.env.MORK_AGENT_SWAP_MAX_SOL ?? 0.25),
    jupiterBaseUrl: process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag",
    jupiterTimeoutMs: Math.max(2500, Number(process.env.JUP_TIMEOUT_MS ?? 10000)),
  };
}

function getOpenAiRuntimeFromEnv() {
  const flag = (process.env.USE_OPENAI || "").trim().toLowerCase();
  return {
    enabled: flag === "1" || flag === "true" || flag === "yes" || flag === "on",
  };
}

function envFilePath(): string {
  return path.join(process.cwd(), ".env.local");
}

async function envFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeEnvToggle(envKey: string, enabled: boolean): Promise<void> {
  const filePath = envFilePath();
  const existing = (await envFileExists(filePath)) ? await readFile(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const output = [...lines];
  const nextLine = `${envKey}=${JSON.stringify(enabled ? "1" : "0")}`;
  const existingIdx = output.findIndex((line) => line.trim().startsWith(`${envKey}=`));

  if (existingIdx >= 0) output[existingIdx] = nextLine;
  else output.push(nextLine);

  const finalContent = `${output.join("\n").replace(/\n+$/g, "")}\n`;
  await writeFile(filePath, finalContent, "utf8");
}

export async function GET() {
  const orchestrator = await getOrchestratorState();
  return NextResponse.json({
    ok: true,
    state: orchestrator.app,
    arbRuntime: getArbRuntimeFromEnv(),
    tradeRuntime: getTradeRuntimeFromEnv(),
    openAiRuntime: getOpenAiRuntimeFromEnv(),
    orchestrator: {
      health: orchestrator.health,
      runtimeFlagOwner: orchestrator.runtimeFlagOwner,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action as Action | undefined;

    if (!action) {
      return NextResponse.json(
        { ok: false, error: "action is required" },
        { status: 400 }
      );
    }

    if (action === "orchestrator.start") await startOrchestrator();
    else if (action === "orchestrator.stop") await stopOrchestrator();
    else if (action === "arb.start") await startRuntime("arb");
    else if (action === "arb.stop") await stopRuntime("arb");
    else if (action === "sherpa.start") await startRuntime("sherpa");
    else if (action === "sherpa.stop") await stopRuntime("sherpa");
    else if (action === "controls.set") {
      const key = body?.key;
      const value = body?.value;

      if (typeof key !== "string" || typeof value !== "boolean") {
        return NextResponse.json(
          { ok: false, error: "controls.set requires string key and boolean value" },
          { status: 400 }
        );
      }

      if (
        key !== "memoryEnabled" &&
        key !== "plannerEnabled" &&
        key !== "telegramEnabled" &&
        key !== "xEnabled" &&
        key !== "walletAutoRefreshEnabled"
      ) {
        return NextResponse.json(
          { ok: false, error: "unknown control key" },
          { status: 400 }
        );
      }

      await setRuntimeFlag(key, value);
    } else if (action === "persona.mode.set") {
      const channel = body?.channel;
      const mode = body?.mode;
      if (
        (channel !== "app" && channel !== "telegram" && channel !== "x") ||
        typeof mode !== "string"
      ) {
        return NextResponse.json(
          { ok: false, error: "persona.mode.set requires channel and mode" },
          { status: 400 }
        );
      }
      await setRuntimePersonaMode(channel, mode.trim());
    } else if (action === "persona.guidelines.set") {
      const channel = body?.channel;
      const guidelines = body?.guidelines;
      if (
        (channel !== "app" && channel !== "telegram" && channel !== "x") ||
        typeof guidelines !== "string"
      ) {
        return NextResponse.json(
          { ok: false, error: "persona.guidelines.set requires channel and guidelines" },
          { status: 400 }
        );
      }
      await setRuntimePersonaGuidelines(channel, guidelines);
    } else if (action === "ollama.model.set") {
      const model = body?.model;
      if (typeof model !== "string" || !model.trim()) {
        return NextResponse.json(
          { ok: false, error: "ollama.model.set requires model" },
          { status: 400 }
        );
      }
      await setRuntimeModel(model.trim());
    } else if (action === "startup.completed.set") {
      const value = body?.value;
      if (typeof value !== "boolean") {
        return NextResponse.json(
          { ok: false, error: "startup.completed.set requires boolean value" },
          { status: 400 }
        );
      }
      await setRuntimeStartupCompleted(value);
    } else if (action === "execution.authority.set") {
      const mode = body?.mode;
      const maxTradeUsd = body?.maxTradeUsd;
      const mintAllowlist = body?.mintAllowlist;
      const cooldownMinutes = body?.cooldownMinutes;
      if (
        (mode !== "user_only" && mode !== "agent_assisted" && mode !== "emergency_stop") ||
        typeof maxTradeUsd !== "number" ||
        !Array.isArray(mintAllowlist) ||
        !mintAllowlist.every((value) => typeof value === "string") ||
        typeof cooldownMinutes !== "number"
      ) {
        return NextResponse.json(
          { ok: false, error: "execution.authority.set requires valid gate settings" },
          { status: 400 }
        );
      }
      await setRuntimeExecutionAuthority({
        mode,
        maxTradeUsd,
        mintAllowlist,
        cooldownMinutes,
      });
    } else if (action === "response.params.set") {
      const maxResponseChars = body?.maxResponseChars;
      const allowUrls = body?.allowUrls;
      const allowUserMessageQuotes = body?.allowUserMessageQuotes;
      const behaviorGuidelines = body?.behaviorGuidelines;
      if (
        typeof maxResponseChars !== "number" ||
        typeof allowUrls !== "boolean" ||
        typeof allowUserMessageQuotes !== "boolean" ||
        typeof behaviorGuidelines !== "string"
      ) {
        return NextResponse.json(
          { ok: false, error: "response.params.set requires response policy fields" },
          { status: 400 }
        );
      }
      await setRuntimeResponsePolicy({
        maxResponseChars,
        allowUrls,
        allowUserMessageQuotes,
        behaviorGuidelines,
      });
    } else if (action === "runtime.panel.set") {
      const panel = body?.panel;
      if (panel !== "arb" && panel !== "trade") {
        return NextResponse.json(
          { ok: false, error: "runtime.panel.set requires panel=arb|trade" },
          { status: 400 }
        );
      }
      await setRuntimeActivePanel(panel);
    } else if (action === "strategy.engines.set") {
      const strategyEngines = body?.strategyEngines;
      const pool = strategyEngines?.poolImbalance;
      const cross = strategyEngines?.crossDexArb;
      const momentum = strategyEngines?.momentumRunner;
      if (
        !pool ||
        !cross ||
        !momentum ||
        typeof pool.minImbalancePct !== "number" ||
        pool.poolsWatched !== "all_available" ||
        typeof pool.useJitoBundle !== "boolean" ||
        typeof cross.minNetProfitSol !== "number" ||
        (cross.routeVia !== "jupiter" && cross.routeVia !== "direct") ||
        typeof cross.enableTriangularRoutes !== "boolean" ||
        typeof momentum.entryVolSpikeMultiplier !== "number" ||
        typeof momentum.exitTrailingStopPct !== "number" ||
        typeof momentum.maxHoldMinutes !== "number" ||
        typeof momentum.hardStopLossPct !== "number" ||
        typeof momentum.watchPumpFunLaunches !== "boolean" ||
        typeof momentum.useBirdeyeTrendingFeed !== "boolean"
      ) {
        return NextResponse.json(
          { ok: false, error: "strategy.engines.set requires valid strategy engine fields" },
          { status: 400 }
        );
      }
      await setRuntimeStrategyEngines({
        poolImbalance: {
          minImbalancePct: pool.minImbalancePct,
          poolsWatched: pool.poolsWatched,
          useJitoBundle: pool.useJitoBundle,
        },
        crossDexArb: {
          minNetProfitSol: cross.minNetProfitSol,
          routeVia: cross.routeVia,
          enableTriangularRoutes: cross.enableTriangularRoutes,
        },
        momentumRunner: {
          entryVolSpikeMultiplier: momentum.entryVolSpikeMultiplier,
          exitTrailingStopPct: momentum.exitTrailingStopPct,
          maxHoldMinutes: momentum.maxHoldMinutes,
          hardStopLossPct: momentum.hardStopLossPct,
          watchPumpFunLaunches: momentum.watchPumpFunLaunches,
          useBirdeyeTrendingFeed: momentum.useBirdeyeTrendingFeed,
        },
      });
    } else if (action === "openai.mode.set") {
      const enabled = body?.enabled;
      if (typeof enabled !== "boolean") {
        return NextResponse.json(
          { ok: false, error: "openai.mode.set requires boolean enabled" },
          { status: 400 }
        );
      }
      await writeEnvToggle("USE_OPENAI", enabled);
      process.env.USE_OPENAI = enabled ? "1" : "0";
    } else if (action === "memory.flush") {
      await flushRuntimeConversationMemory();
    } else {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }

    const orchestrator = await getOrchestratorState();
    return NextResponse.json({
      ok: true,
      state: orchestrator.app,
      arbRuntime: getArbRuntimeFromEnv(),
      tradeRuntime: getTradeRuntimeFromEnv(),
      openAiRuntime: getOpenAiRuntimeFromEnv(),
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "control update failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
