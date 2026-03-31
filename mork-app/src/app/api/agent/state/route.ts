import { NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";
import { getOrchestratorState, updateHealth } from "@/lib/core/orchestrator";

export async function GET() {
  const orchestrator = await getOrchestratorState();

  try {
    const wallet = await getWalletState();
    updateHealth("wallet", "healthy", "wallet query succeeded");

    return NextResponse.json({
      agent: {
        name: "Mork Zuckerbarge",
        status: "active",
        model: process.env.OLLAMA_MODEL || "llama3.2:3b",
      },
      app: orchestrator.app,
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
      wallet,
    });
  } catch {
    updateHealth("wallet", "degraded", "wallet query failed");
    return NextResponse.json({
      agent: {
        name: "Mork Zuckerbarge",
        status: "offline",
        model: process.env.OLLAMA_MODEL || "llama3.2:3b",
      },
      app: orchestrator.app,
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
      wallet: {
        address: null,
        sol: 0,
        bbq: 0,
        usdc: 0,
        requirementMet: false,
      },
    });
  }
}
