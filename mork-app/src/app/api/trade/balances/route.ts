import { NextResponse } from "next/server";
import { getWalletBalancesForMints } from "@/lib/core/wallet";

export const runtime = "nodejs";

type BalancesBody = {
  mints?: string[];
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as BalancesBody;
    const mints = (body.mints ?? []).map((mint) => mint.trim()).filter(Boolean).slice(0, 8);

    if (!mints.length) {
      return NextResponse.json({ ok: false, error: "mints is required" }, { status: 400 });
    }

    const balances = await getWalletBalancesForMints(mints);
    return NextResponse.json({ ok: true, balances });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "balance lookup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
