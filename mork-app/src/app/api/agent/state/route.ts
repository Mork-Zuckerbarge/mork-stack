import { NextResponse } from "next/server";
import { getWalletState } from "@/lib/core/wallet";
import { getAppControlState } from "@/lib/core/appControl";

export async function GET() {
  const app = getAppControlState();

  try {
    const wallet = await getWalletState();

    return NextResponse.json({
      agent: {
        name: "Mork Zuckerbarge",
        status: "active",
        model: process.env.OLLAMA_MODEL || "llama3.2:3b",
      },
      app,
      wallet,
    });
  } catch {
    return NextResponse.json({
      agent: {
        name: "Mork Zuckerbarge",
        status: "offline",
        model: process.env.OLLAMA_MODEL || "llama3.2:3b",
      },
      app,
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
