import { NextResponse } from "next/server";
import { getPreflightStatus } from "@/lib/bootstrap/preflight";

export async function GET() {
  const status = await getPreflightStatus();
  return NextResponse.json(status, { status: status.ok ? 200 : 503 });
}
