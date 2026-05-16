import { NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";
import { resolveWalletAddressFromEnv } from "@/lib/core/walletConfig";
import { updateHealth } from "@/lib/core/orchestrator";

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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const wallet = await getWalletState(force);
    updateHealth("wallet", "healthy", "wallet state query succeeded");

    return NextResponse.json({
      ok: true,
      wallet,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "wallet state failed";
    updateHealth("wallet", "degraded", message);
    return NextResponse.json(
      { ok: true, wallet: buildFallbackWallet(), degraded: true, error: message },
    );
  }
}
