import { NextRequest, NextResponse } from "next/server";
import {
  getAppControlState,
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
  | "controls.set";

export async function GET() {
  return NextResponse.json({ ok: true, state: getAppControlState() });
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

    if (action === "arb.start") startArb();
    else if (action === "arb.stop") stopArb();
    else if (action === "sherpa.start") startSherpa();
    else if (action === "sherpa.stop") stopSherpa();
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
        key !== "messagingEnabled" &&
        key !== "walletAutoRefreshEnabled"
      ) {
        return NextResponse.json(
          { ok: false, error: "unknown control key" },
          { status: 400 }
        );
      }

      setControlFlag(key, value);
    } else {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, state: getAppControlState() });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "control update failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
