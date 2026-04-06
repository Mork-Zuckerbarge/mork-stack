import { NextRequest, NextResponse } from "next/server";
import { respondToChat } from "@/lib/core/chat";

type ChatChannel = "system" | "telegram" | "x";

function resolveChannel(value: unknown): ChatChannel {
  if (value === "telegram" || value === "x") return value;
  return "system";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const result = await respondToChat({
      channel: resolveChannel(body?.channel),
      handle: typeof body?.handle === "string" && body.handle.trim() ? body.handle.trim() : "frontend-coding",
      message: typeof body?.message === "string" ? body.message : "",
      maxChars: typeof body?.maxChars === "number" ? body.maxChars : 12000,
    });

    return NextResponse.json(result, { status: result.status || 200 });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "chat route failed" },
      { status: 500 }
    );
  }
}
