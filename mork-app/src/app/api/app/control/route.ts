import { NextRequest, NextResponse } from "next/server";
import {
  getAppControlState,
  setExecutionAuthority,
  setPersonaGuidelines,
  setPersonaMode,
  setSelectedOllamaModel,
  setStartupCompleted,
  setControlFlag,
  startArb,
  startSherpa,
  stopArb,
  stopSherpa,
} from "@/lib/core/appControl";

type Action =
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
  return NextResponse.json({ ok: true, state: await getAppControlState() });
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

    if (action === "arb.start") await startArb();
    else if (action === "arb.stop") await stopArb();
    else if (action === "sherpa.start") await startSherpa();
    else if (action === "sherpa.stop") await stopSherpa();
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

      await setControlFlag(key, value);
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
      await setPersonaMode(channel, mode.trim());
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
      await setPersonaGuidelines(channel, guidelines);
    } else if (action === "ollama.model.set") {
      const model = body?.model;
      if (typeof model !== "string" || !model.trim()) {
        return NextResponse.json(
          { ok: false, error: "ollama.model.set requires model" },
          { status: 400 }
        );
      }
      await setSelectedOllamaModel(model.trim());
    } else if (action === "startup.completed.set") {
      const value = body?.value;
      if (typeof value !== "boolean") {
        return NextResponse.json(
          { ok: false, error: "startup.completed.set requires boolean value" },
          { status: 400 }
        );
      }
      await setStartupCompleted(value);
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
      await setExecutionAuthority({
        mode,
        maxTradeUsd,
        mintAllowlist,
        cooldownMinutes,
      });
    } else {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, state: await getAppControlState() });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "control update failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
