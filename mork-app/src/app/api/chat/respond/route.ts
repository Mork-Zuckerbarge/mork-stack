import { NextRequest, NextResponse } from "next/server";
import { respondToChat } from "@/lib/core/chat";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const result = await respondToChat({
      channel: "system",
      handle: "frontend-coding",
      message: body.message,
      maxChars: 12000,
    });

    return NextResponse.json(result, { status: result.status || 200 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "chat route failed" },
      { status: 500 }
    );
  }
}
