import { NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";

export async function GET() {
  try {
    const wallet = await getWalletState();

    return NextResponse.json({
      ok: true,
      wallet,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "wallet state failed" },
      { status: 500 }
    );
  }
}
