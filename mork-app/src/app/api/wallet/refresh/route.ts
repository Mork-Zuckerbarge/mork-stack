import { NextResponse } from "next/server";
import { refreshWalletMemory } from "@/lib/core/wallet";
import { isWalletAutoRefreshEnabled, updateHealth } from "@/lib/core/orchestrator";
import { resolveWalletAddressFromEnv } from "@/lib/core/walletConfig";

function buildFallbackWallet() {
  let address: string | null = null;
  try {
    address = resolveWalletAddressFromEnv();
  } catch {
    address = null;
  }
  return {
    address,
    sol: 0,
    bbq: 0,
    usdc: 0,
    requirementMet: false,
  };
}

export async function POST() {
  try {
    if (!(await isWalletAutoRefreshEnabled())) {
      return NextResponse.json({
        ok: false,
        error: "wallet auto refresh is disabled in app controls",
      });
    }

    const wallet = await refreshWalletMemory();
    updateHealth("wallet", "healthy", "wallet refreshed");

    return NextResponse.json({
      ok: true,
      wallet,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "wallet refresh failed";
    updateHealth("wallet", "degraded", message);
    return NextResponse.json(
      { ok: true, wallet: buildFallbackWallet(), degraded: true, error: message },
    );
  }
}
