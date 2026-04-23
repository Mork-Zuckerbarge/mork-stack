import { NextResponse } from "next/server";
import { getAppControlState } from "@/lib/core/appControl";
import { getJupiterBaseCandidates, getJupiterTimeoutMs } from "@/lib/core/jupiter";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_TIMEOUT_MS = getJupiterTimeoutMs();

type QuoteBody = {
  amountSol?: number;
  inputMint?: string;
  outputMint?: string;
  slippageBps?: number;
};

type JupiterRouteHop = {
  swapInfo?: {
    feeAmount?: string;
    feeMint?: string;
  };
};

type JupiterQuote = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  routePlan?: JupiterRouteHop[];
};

type JupiterToken = {
  decimals?: number;
};

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  for (const base of getJupiterBaseCandidates()) {
    const tokenRes = await fetch(`${base}/tokens/v1/token/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
    }).catch(() => null);
    if (!tokenRes?.ok) continue;
    const token = (await tokenRes.json()) as JupiterToken;
    return Number.isFinite(token.decimals) ? Number(token.decimals) : 0;
  }
  return 0;
}

function fromRawAmount(rawAmount: string | number | undefined, decimals: number): number {
  const base = Number(rawAmount ?? 0);
  if (!Number.isFinite(base)) return 0;
  return base / 10 ** decimals;
}

export async function POST(req: Request) {
  try {
    const control = await getAppControlState();
    if (control.controls.activePanel !== "trade") {
      return NextResponse.json(
        { ok: false, error: "Trade panel is paused. Switch panel control to Trade first." },
        { status: 409 }
      );
    }

    const body = (await req.json()) as QuoteBody;
    const amountSol = Number(body.amountSol ?? 0);
    const slippageBps = Math.min(Math.max(Number(body.slippageBps ?? 50), 10), 300);
    const inputMint = body.inputMint?.trim() || SOL_MINT;
    const outputMint = body.outputMint?.trim() || BBQ_MINT;

    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      return NextResponse.json({ ok: false, error: "amountSol must be > 0" }, { status: 400 });
    }

    const [inputDecimals, outputDecimals] = await Promise.all([
      getTokenDecimals(inputMint),
      getTokenDecimals(outputMint),
    ]);
    const baseAmount = Math.floor(amountSol * 10 ** inputDecimals);
    let quoteRes: Response | null = null;
    let quoteError = "Quote failed across all configured Jupiter endpoints.";
    for (const base of getJupiterBaseCandidates()) {
      const quoteUrl = new URL(`${base}/swap/v1/quote`);
      quoteUrl.searchParams.set("inputMint", inputMint);
      quoteUrl.searchParams.set("outputMint", outputMint);
      quoteUrl.searchParams.set("amount", String(baseAmount));
      quoteUrl.searchParams.set("slippageBps", String(slippageBps));

      const res = await fetch(quoteUrl.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
      }).catch(() => null);

      if (!res) {
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        quoteError = `Quote failed (${res.status}): ${text}`;
        continue;
      }
      quoteRes = res;
      break;
    }

    if (!quoteRes) {
      return NextResponse.json({ ok: false, error: quoteError }, { status: 502 });
    }

    const quote = (await quoteRes.json()) as JupiterQuote;
    const feeInOutput = (quote.routePlan ?? []).reduce((sum, hop) => {
      const feeMint = hop.swapInfo?.feeMint;
      const feeAmount = Number(hop.swapInfo?.feeAmount ?? 0);
      if (feeMint !== quote.outputMint || !Number.isFinite(feeAmount)) {
        return sum;
      }
      return sum + feeAmount;
    }, 0);

    return NextResponse.json({
      ok: true,
      inAmount: fromRawAmount(quote.inAmount, inputDecimals),
      outAmount: fromRawAmount(quote.outAmount, outputDecimals),
      otherAmountThreshold: fromRawAmount(quote.otherAmountThreshold, outputDecimals),
      priceImpactPct: quote.priceImpactPct ?? "0",
      routeFeeAmount: fromRawAmount(feeInOutput, outputDecimals),
      routeFeeSymbol: quote.outputMint === BBQ_MINT ? "BBQ" : quote.outputMint === SOL_MINT ? "SOL" : "token",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "quote failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
