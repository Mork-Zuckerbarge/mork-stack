import { NextRequest, NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";
import { getOrchestratorState, updateHealth } from "@/lib/core/orchestrator";
import { getPreflightStatus } from "@/lib/bootstrap/preflight";

export async function GET(req: NextRequest) {
  const orchestrator = await getOrchestratorState();
  const preflight = await getPreflightStatus();
  const agentStatus = preflight.ok ? "active" : "degraded";
  const force = req.nextUrl.searchParams.get("force") === "1";

  try {
    const wallet = await getWalletState(force);
    updateHealth("wallet", "healthy", "wallet query succeeded");

    return NextResponse.json({
      agent: {
        name: "Mork Zuckerbarge",
        status: agentStatus,
        model: process.env.OLLAMA_MODEL || "llama3.2:3b",
      },
      app: orchestrator.app,
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
      wallet,
      preflight,
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
      preflight,
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
