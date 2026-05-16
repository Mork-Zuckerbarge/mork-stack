import { NextRequest, NextResponse } from "next/server";
import { POST as handleChat } from "@/app/api/chat/respond/route";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleChat(request);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
