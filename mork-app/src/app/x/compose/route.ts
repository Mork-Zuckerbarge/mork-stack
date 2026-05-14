import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use /api/chat/respond to generate channel output." }, { status: 404 });
}

export async function POST() {
  return NextResponse.json({ ok: false, error: "Use /api/chat/respond to generate channel output." }, { status: 404 });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
