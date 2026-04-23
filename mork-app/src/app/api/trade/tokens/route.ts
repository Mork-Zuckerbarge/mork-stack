import { NextResponse } from "next/server";
import { getJupiterBaseCandidates, getJupiterTimeoutMs } from "@/lib/core/jupiter";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_TIMEOUT_MS = getJupiterTimeoutMs();

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
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim() ?? "";

    if (!q) {
      return NextResponse.json({
        ok: true,
        tokens: [{ symbol: "SOL", mint: SOL_MINT }],
      });
    }

    if (q.length < 2) {
      return NextResponse.json({
        ok: true,
        tokens: [{ symbol: "SOL", mint: SOL_MINT }],
      });
    }

    const bases = getJupiterBaseCandidates();
    let searchedTokens: Array<ReturnType<typeof normalizeToken>> = [];
    for (const base of bases) {
      const url = new URL(`${base}/tokens/v1/search`);
      url.searchParams.set("query", q);
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
      }).catch(() => null);

      if (!res?.ok) {
        continue;
      }
      searchedTokens = ((await res.json()) as JupiterToken[])
        .map((token) => normalizeToken(token))
        .filter((token): token is NonNullable<typeof token> => Boolean(token))
        .slice(0, 25);
      if (searchedTokens.length > 0) {
        break;
      }
    }

    if (searchedTokens.length > 0) {
      return NextResponse.json({ ok: true, tokens: searchedTokens });
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
      return NextResponse.json({ ok: true, tokens: [] });
    }

    for (const base of bases) {
      const tokenByMintRes = await fetch(`${base}/tokens/v1/token/${q}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
      }).catch(() => null);

      if (!tokenByMintRes?.ok) {
        continue;
      }

      const tokenByMint = normalizeToken((await tokenByMintRes.json()) as JupiterToken);
      if (!tokenByMint) {
        continue;
      }

      return NextResponse.json({ ok: true, tokens: [tokenByMint] });
    }

    return NextResponse.json({ ok: true, tokens: [] });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "token search failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
