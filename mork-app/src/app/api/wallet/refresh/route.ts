import { NextResponse } from "next/server";
import { refreshWalletMemory } from "@/lib/core/wallet";

export async function POST() {
  try {
    const wallet = await refreshWalletMemory();

    return NextResponse.json({
      ok: true,
      wallet,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "wallet refresh failed" },
      { status: 500 }
    );
  }
}
