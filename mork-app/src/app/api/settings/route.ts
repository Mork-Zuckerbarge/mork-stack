import { NextResponse } from "next/server";

async function safeJson(url: string) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function GET() {
  const walletData = await safeJson("http://127.0.0.1:8790/wallet/state");

  return NextResponse.json({
    agent: {
      name: "Mork Zuckerbarge",
      status: walletData ? "active" : "offline",
      model: "llama3.2:3b",
    },
    wallet: {
      address: walletData?.wallet?.address || null,
      sol: walletData?.wallet?.sol || 0,
      bbq: walletData?.wallet?.bbq || 0,
      usdc: walletData?.wallet?.usdc || 0,
      requirementMet: walletData?.wallet?.requirementMet || false,
    },
  });
}
