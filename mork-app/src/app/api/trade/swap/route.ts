import { NextResponse } from "next/server";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_BASE = process.env.JUP_BASE_URL ?? "https://lite-api.jup.ag";
const RPC = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

type SwapBody = {
  amountSol?: number;
  slippageBps?: number;
};

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
    const amountSol = Number(body.amountSol ?? 0);
    const slippageBps = Math.min(Math.max(Number(body.slippageBps ?? 50), 10), 300);
    const maxSol = Number(process.env.MORK_AGENT_SWAP_MAX_SOL ?? 0.25);

    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      return NextResponse.json({ ok: false, error: "amountSol must be > 0" }, { status: 400 });
    }

    if (amountSol > maxSol) {
      return NextResponse.json(
        { ok: false, error: `amountSol exceeds configured max of ${maxSol} SOL` },
        { status: 400 }
      );
    }

    const signer = getSigner();
    const connection = new Connection(RPC, "processed");
    const lamports = Math.floor(amountSol * 1_000_000_000);

    const quoteUrl = new URL(`${JUP_BASE}/swap/v1/quote`);
    quoteUrl.searchParams.set("inputMint", SOL_MINT);
    quoteUrl.searchParams.set("outputMint", BBQ_MINT);
    quoteUrl.searchParams.set("amount", String(lamports));
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
        content: `direct_swap SOL->BBQ amount=${amountSol} sig=${signature}`,
        entities: ["arb:manual_swap", `wallet:${signer.publicKey.toBase58()}`],
        importance: 0.65,
        source: "arb",
      },
    });

    return NextResponse.json({
      ok: true,
      signature,
      amountSol,
      wallet: signer.publicKey.toBase58(),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "direct swap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
