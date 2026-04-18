import { NextResponse } from "next/server";
import { getAppControlState } from "@/lib/core/appControl";

export const runtime = "nodejs";

const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_TIMEOUT_MS = Math.max(2500, Number(process.env.JUP_TIMEOUT_MS ?? 10000));

type JupiterToken = {
  address?: string;
  mint?: string;
  id?: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
};

function normalizeToken(token: JupiterToken) {
  const mint = token.address || token.mint || token.id;
  if (!mint) return null;
  return {
    symbol: token.symbol?.trim() || `${mint.slice(0, 4)}…${mint.slice(-4)}`,
    mint,
    name: token.name?.trim() || "",
    logoUri: token.logoURI || "",
  };
}

export async function GET(req: Request) {
  try {
    const control = await getAppControlState();
    if (control.controls.activePanel !== "trade") {
      return NextResponse.json({ ok: true, tokens: [] });
    }

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
    if (q.length < 2) {
      return NextResponse.json({
        ok: true,
        tokens: [{ symbol: "SOL", mint: SOL_MINT }],
      });
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: true, tokens: [] });
    }

    const searchedTokens = ((await res.json()) as JupiterToken[])
      .map((token) => normalizeToken(token))
      .filter((token): token is NonNullable<typeof token> => Boolean(token))
      .slice(0, 25);

    if (searchedTokens.length > 0) {
      return NextResponse.json({ ok: true, tokens: searchedTokens });
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
      return NextResponse.json({ ok: true, tokens: [] });
    }

    const tokenByMintRes = await fetch(`${JUP_BASE}/tokens/v1/token/${q}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!tokenByMintRes.ok) {
      return NextResponse.json({ ok: true, tokens: [] });
    }

    const tokenByMint = normalizeToken((await tokenByMintRes.json()) as JupiterToken);
    if (!tokenByMint) {
      return NextResponse.json({ ok: true, tokens: [] });
    }

    return NextResponse.json({ ok: true, tokens: [tokenByMint] });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "token search failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
