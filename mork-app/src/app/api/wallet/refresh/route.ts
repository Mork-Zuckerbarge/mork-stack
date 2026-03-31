import { NextResponse } from "next/server";
import { refreshWalletMemory } from "@/lib/core/wallet";
import { isWalletAutoRefreshEnabled } from "@/lib/core/appControl";

export async function POST() {
  try {
    if (!(await isWalletAutoRefreshEnabled())) {
      return NextResponse.json({
        ok: false,
        error: "wallet auto refresh is disabled in app controls",
      });
    }

    const wallet = await refreshWalletMemory();

    return NextResponse.json({
      ok: true,
      wallet,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "wallet refresh failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
