import { NextRequest, NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";
import { getOrchestratorState, updateHealth } from "@/lib/core/orchestrator";
import { getPreflightStatus } from "@/lib/bootstrap/preflight";
import { APP_DEFAULTS } from "@/lib/core/defaults";

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
        name: APP_DEFAULTS.agentName,
        status: agentStatus,
        model: process.env.OLLAMA_MODEL || APP_DEFAULTS.ollamaModel,
      },
      app: orchestrator.app,
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
      wallet,
      preflight,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "wallet query failed";
    updateHealth("wallet", "degraded", message);
    return NextResponse.json({
      agent: {
        name: APP_DEFAULTS.agentName,
        status: agentStatus,
        model: process.env.OLLAMA_MODEL || APP_DEFAULTS.ollamaModel,
      },
      app: orchestrator.app,
      orchestrator: {
        health: orchestrator.health,
        runtimeFlagOwner: orchestrator.runtimeFlagOwner,
      },
      preflight,
      wallet: null,
      walletError: message,
    });
  }
}
