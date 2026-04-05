import { NextResponse } from "next/server";

export const runtime = "nodejs";

const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterToken = {
  address?: string;
  symbol?: string;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim() ?? "";

    if (!q) {
      return NextResponse.json({
        ok: true,
        tokens: [{ symbol: "SOL", mint: SOL_MINT }],
      });
    }

    const url = new URL(`${JUP_BASE}/tokens/v1/search`);
    url.searchParams.set("query", q);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Token search failed (${res.status}): ${body}` }, { status: 502 });
    }

    const tokens = ((await res.json()) as JupiterToken[])
      .filter((token) => token.address)
      .slice(0, 25)
      .map((token) => ({
        symbol: token.symbol?.trim() || `${token.address!.slice(0, 4)}…${token.address!.slice(-4)}`,
        mint: token.address!,
      }));

    return NextResponse.json({ ok: true, tokens });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "token search failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
