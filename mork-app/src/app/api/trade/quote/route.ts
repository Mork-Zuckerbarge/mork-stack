import { NextResponse } from "next/server";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";

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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as QuoteBody;
    const amountSol = Number(body.amountSol ?? 0);
    const slippageBps = Math.min(Math.max(Number(body.slippageBps ?? 50), 10), 300);
    const inputMint = body.inputMint?.trim() || SOL_MINT;
    const outputMint = body.outputMint?.trim() || BBQ_MINT;

    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      return NextResponse.json({ ok: false, error: "amountSol must be > 0" }, { status: 400 });
    }

    const lamports = Math.floor(amountSol * 1_000_000_000);
    const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
    quoteUrl.searchParams.set("inputMint", inputMint);
    quoteUrl.searchParams.set("outputMint", outputMint);
    quoteUrl.searchParams.set("amount", String(lamports));
    quoteUrl.searchParams.set("slippageBps", String(slippageBps));

    const quoteRes = await fetch(quoteUrl.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!quoteRes.ok) {
      const text = await quoteRes.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Quote failed (${quoteRes.status}): ${text}` }, { status: 502 });
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
      inAmount: Number(quote.inAmount ?? 0),
      outAmount: Number(quote.outAmount ?? 0),
      otherAmountThreshold: Number(quote.otherAmountThreshold ?? 0),
      priceImpactPct: quote.priceImpactPct ?? "0",
      routeFeeAmount: feeInOutput,
      routeFeeSymbol: quote.outputMint === BBQ_MINT ? "BBQ" : quote.outputMint === SOL_MINT ? "SOL" : "token",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "quote failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
