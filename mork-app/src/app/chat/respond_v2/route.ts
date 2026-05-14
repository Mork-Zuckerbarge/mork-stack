import { NextResponse } from "next/server";
import { POST as handleChat } from "@/app/api/chat/respond/route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleChat(request);
}

export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 204 });
}
