import { NextResponse } from "next/server";
import { getJupiterBaseCandidates, getJupiterTimeoutMs } from "@/lib/core/jupiter";
import { getWalletTokenBalances, SOL_MINT, type WalletTokenBalance } from "@/lib/core/wallet";

export const runtime = "nodejs";

const JUP_TIMEOUT_MS = getJupiterTimeoutMs();

type JupiterToken = {
  address?: string;
  mint?: string;
  id?: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
};

type TokenOption = {
  symbol: string;
  mint: string;
  name: string;
  logoUri: string;
  balance: number;
};

function fallbackToken(mint: string, balance: number): TokenOption {
  const symbol = mint === SOL_MINT ? "SOL" : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  return {
    symbol,
    mint,
    name: "",
    logoUri: "",
    balance,
  };
}

function normalizeToken(token: JupiterToken, balance: number): TokenOption | null {
  const mint = token.address || token.mint || token.id;
  if (!mint) return null;
  return {
    symbol: token.symbol?.trim() || `${mint.slice(0, 4)}…${mint.slice(-4)}`,
    mint,
    name: token.name?.trim() || "",
    logoUri: token.logoURI || "",
    balance,
  };
}

async function resolveTokenMetadata(tokenBalance: WalletTokenBalance): Promise<TokenOption> {
  if (tokenBalance.mint === SOL_MINT) {
    return {
      symbol: "SOL",
      mint: SOL_MINT,
      name: "Solana",
      logoUri: "",
      balance: tokenBalance.balance,
    };
  }

  for (const base of getJupiterBaseCandidates()) {
    const res = await fetch(`${base}/tokens/v1/token/${tokenBalance.mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
    }).catch(() => null);

    if (!res?.ok) {
      continue;
    }

    const normalized = normalizeToken((await res.json()) as JupiterToken, tokenBalance.balance);
    if (normalized) {
      return normalized;
    }
  }

  return fallbackToken(tokenBalance.mint, tokenBalance.balance);
}

export async function GET() {
  try {
    const walletTokens = await getWalletTokenBalances();
    const topTokens = walletTokens.slice(0, 25);
    const resolved = await Promise.all(topTokens.map((tokenBalance) => resolveTokenMetadata(tokenBalance)));
    return NextResponse.json({ ok: true, tokens: resolved });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "wallet token lookup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
