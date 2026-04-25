import { NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const wallet = await getWalletState(force);

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
