import { NextResponse } from "next/server";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";
const JUP_TIMEOUT_MS = Math.max(2500, Number(process.env.JUP_TIMEOUT_MS ?? 10000));
const RPC = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

type SwapBody = {
  amountSol?: number;
  amountIn?: number;
  slippageBps?: number;
  inputMint?: string;
  outputMint?: string;
};

type JupiterTokenMeta = { decimals?: number };

function parseSecretKey(raw: string): Uint8Array | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "number")) {
      return null;
    }
    return Uint8Array.from(parsed);
  } catch {
    return null;
  }
}

function getSigner(): Keypair {
  const secretRaw = process.env.MORK_WALLET_SECRET_KEY?.trim();
  if (!secretRaw) {
    throw new Error("MORK_WALLET_SECRET_KEY is required for direct agent swaps");
  }
  const secret = parseSecretKey(secretRaw);
  if (!secret) {
    throw new Error("MORK_WALLET_SECRET_KEY must be a JSON array of bytes");
  }
  return Keypair.fromSecretKey(secret);
}

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  try {
    const res = await fetch(`${JUP_BASE}/tokens/v1/token/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
    });
    if (!res.ok) return 0;
    const token = (await res.json()) as JupiterTokenMeta;
    return Number.isFinite(token.decimals) ? Number(token.decimals) : 0;
  } catch {
    return 0;
  }
}

export async function POST(req: Request) {
  try {
    const control = await getAppControlState();
    if (control.arb.status === "running" || control.controls.activePanel !== "trade") {
      return NextResponse.json(
        { ok: false, error: "Trade panel is paused while ARB is active. Switch panel to Trade and stop ARB first." },
        { status: 409 }
      );
    }

    if (process.env.MORK_AGENT_SWAP_ENABLED !== "1") {
      return NextResponse.json(
        { ok: false, error: "Direct agent swap is disabled (set MORK_AGENT_SWAP_ENABLED=1 to enable)." },
        { status: 403 }
      );
    }

    const body = (await req.json()) as SwapBody;
    const amountIn = Number(body.amountIn ?? body.amountSol ?? 0);
    const slippageBps = Math.min(Math.max(Number(body.slippageBps ?? 50), 10), 300);
    const maxSol = Number(process.env.MORK_AGENT_SWAP_MAX_SOL ?? 0.25);
    const inputMint = body.inputMint?.trim() || SOL_MINT;
    const outputMint = body.outputMint?.trim() || BBQ_MINT;

    if (!Number.isFinite(amountIn) || amountIn <= 0) {
      return NextResponse.json({ ok: false, error: "amountIn must be > 0" }, { status: 400 });
    }

    if (amountIn > maxSol) {
      return NextResponse.json(
        { ok: false, error: `amountIn exceeds configured max of ${maxSol} ${inputMint === SOL_MINT ? "SOL" : "input token units"}` },
        { status: 400 }
      );
    }

    const signer = getSigner();
    const connection = new Connection(RPC, "processed");
    const inDecimals = await getTokenDecimals(inputMint);
    if (inDecimals <= 0 || inDecimals > 12) {
      return NextResponse.json(
        { ok: false, error: `Unable to resolve decimals for input mint ${inputMint}` },
        { status: 400 }
      );
    }
    const inUnits = Math.floor(amountIn * 10 ** inDecimals);

    const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
    quoteUrl.searchParams.set("inputMint", inputMint);
    quoteUrl.searchParams.set("outputMint", outputMint);
    quoteUrl.searchParams.set("amount", String(inUnits));
    quoteUrl.searchParams.set("slippageBps", String(slippageBps));

    const quoteRes = await fetch(quoteUrl.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!quoteRes.ok) {
      const text = await quoteRes.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Quote failed (${quoteRes.status}): ${text}` }, { status: 502 });
    }

    const quoteResponse = (await quoteRes.json()) as Record<string, unknown>;

    const swapRes = await fetch(`${JUP_BASE}/swap/v1/swap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });

    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Swap build failed (${swapRes.status}): ${text}` }, { status: 502 });
    }

    const swapJson = (await swapRes.json()) as { swapTransaction?: string };
    if (!swapJson.swapTransaction) {
      return NextResponse.json({ ok: false, error: "Jupiter swap transaction missing" }, { status: 502 });
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(swapJson.swapTransaction, "base64"));
    tx.sign([signer]);

    const signature = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
    await connection.confirmTransaction(signature, "confirmed");

    await prisma.memory.create({
      data: {
        type: "event",
        content: `direct_swap ${inputMint}->${outputMint} amount=${amountIn} sig=${signature}`,
        entities: ["arb:manual_swap", `wallet:${signer.publicKey.toBase58()}`],
        importance: 0.65,
        source: "arb",
      },
    });

    return NextResponse.json({
      ok: true,
      signature,
      amountIn,
      inputMint,
      outputMint,
      wallet: signer.publicKey.toBase58(),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "direct swap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
