import { NextRequest, NextResponse } from "next/server";
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
  | "execution.authority.set";

export async function GET() {
  const orchestrator = await getOrchestratorState();
  return NextResponse.json({
    ok: true,
    state: orchestrator.app,
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
    } else {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }

    const orchestrator = await getOrchestratorState();
    return NextResponse.json({
      ok: true,
      state: orchestrator.app,
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
