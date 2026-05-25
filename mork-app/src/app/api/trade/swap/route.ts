import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getJupiterBaseCandidates, getJupiterTimeoutMs } from "@/lib/core/jupiter";

export const runtime = "nodejs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUP_TIMEOUT_MS = getJupiterTimeoutMs();
const RPC = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

type SwapBody = {
  amountSol?: number;
  amountIn?: number;
  slippageBps?: number;
  inputMint?: string;
  outputMint?: string;
  agentInitiated?: boolean;
  userCommanded?: boolean;
};

type SocialExecutionGate = {
  pass: boolean;
  reason: string;
  socialSignalCount: number;
  sherpaFeedCount: number;
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

async function getTokenDecimalsFromJupiter(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  for (const base of getJupiterBaseCandidates()) {
    const res = await fetch(`${base}/tokens/v1/token/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
    }).catch(() => null);
    if (!res?.ok) continue;
    const token = (await res.json()) as JupiterTokenMeta;
    return Number.isFinite(token.decimals) ? Number(token.decimals) : 0;
  }
  return 0;
}

async function getTokenDecimals(mint: string, connection: Connection): Promise<number> {
  if (mint === SOL_MINT) return 9;

  const jupiterDecimals = await getTokenDecimalsFromJupiter(mint);
  if (jupiterDecimals > 0) return jupiterDecimals;

  try {
    const mintPk = new PublicKey(mint);
    const parsed = await connection.getParsedAccountInfo(mintPk, "processed").catch(() => null);
    const decimals = Number((parsed?.value as { data?: { parsed?: { info?: { decimals?: number } } } } | null)?.data?.parsed?.info?.decimals);
    return Number.isFinite(decimals) ? decimals : 0;
  } catch {
    return 0;
  }
}

async function evaluateSocialExecutionGate(): Promise<SocialExecutionGate> {
  if (process.env.MOLTBOOK_MULTI_FACTOR_REQUIRED !== "1") {
    return { pass: true, reason: "multi_factor_disabled", socialSignalCount: 0, sherpaFeedCount: 0 };
  }

  const socialWindowMinutes = Math.max(1, Number(process.env.MORK_SOCIAL_SIGNAL_WINDOW_MINUTES ?? 180) || 180);
  const minSocialSignals = Math.max(1, Number(process.env.MORK_SOCIAL_SIGNAL_MIN_COUNT ?? 1) || 1);
  const minSherpaFeeds = Math.max(1, Number(process.env.MORK_SOCIAL_SHERPA_MIN_COUNT ?? 1) || 1);
  const since = new Date(Date.now() - socialWindowMinutes * 60_000);

  const [moltbookTicks, sherpaFeeds] = await Promise.all([
    prisma.memory.findMany({
      where: { source: "moltbook", createdAt: { gte: since }, content: { contains: "socialSignals=" } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { content: true },
    }),
    prisma.memory.count({
      where: {
        source: "sherpa",
        createdAt: { gte: since },
      },
    }),
  ]);

  const socialSignalCount = moltbookTicks.reduce((acc, tick) => {
    const m = String(tick.content).match(/socialSignals=(\d+)/i);
    return acc + (m ? Number(m[1] ?? 0) : 0);
  }, 0);

  // If moltbook is unreachable (all recent ticks report moltbookReachable=false),
  // degrade gracefully: sherpa activity alone satisfies the social gate.
  const moltbookReachableInWindow = moltbookTicks.some(
    (t) => !String(t.content).includes("moltbookReachable=false")
  );
  if (!moltbookReachableInWindow && moltbookTicks.length > 0 && sherpaFeeds >= minSherpaFeeds) {
    return { pass: true, reason: "moltbook_offline_sherpa_active", socialSignalCount, sherpaFeedCount: sherpaFeeds };
  }

  if (socialSignalCount < minSocialSignals) {
    // Moltbook signals insufficient — try sherpa as fallback signal source
    if (sherpaFeeds >= minSherpaFeeds) {
      return { pass: true, reason: "sherpa_fallback_signal", socialSignalCount, sherpaFeedCount: sherpaFeeds };
    }
    return {
      pass: false,
      reason: `social_signal_threshold_unmet(${socialSignalCount}<${minSocialSignals})`,
      socialSignalCount,
      sherpaFeedCount: sherpaFeeds,
    };
  }

  // Moltbook has sufficient signals — sherpa check is informational only
  return { pass: true, reason: "social_thresholds_met", socialSignalCount, sherpaFeedCount: sherpaFeeds };
}

export async function POST(req: Request) {
  try {
    const control = await getAppControlState();

    // Parse body first so we can read agentInitiated before applying guards.
    const body = (await req.json()) as SwapBody;
    const agentInitiated = body.agentInitiated === true;
    // userCommanded = explicit chat/operator instruction. Bypasses social gate but
    // still respects emergency_stop. Autonomous planner trades do NOT set this.
    const userCommanded = body.userCommanded === true;

    if (agentInitiated) {
      // Agent-triggered swaps bypass the panel/arb guard (intentional direct commands,
      // not UI trade-panel actions that conflict with the background ARB scanner).
      const authority = control.controls.executionAuthority;
      if (authority.mode === "emergency_stop") {
        return NextResponse.json(
          { ok: false, error: "Trading disabled: emergency_stop mode is active." },
          { status: 403 }
        );
      }

      // Social gate only applies to autonomous decisions — direct operator commands bypass it.
      if (!userCommanded) {
        const socialGate = await evaluateSocialExecutionGate();
        if (!socialGate.pass) {
          return NextResponse.json(
            {
              ok: false,
              error: `Agent execution blocked by social multi-factor gate: ${socialGate.reason}`,
              decisionMeta: {
                socialSignalCount: socialGate.socialSignalCount,
                sherpaFeedCount: socialGate.sherpaFeedCount,
              },
            },
            { status: 403 }
          );
        }
      }
    } else {
      // Manual UI swap: only block when trade panel is not active.
      if (control.controls.activePanel !== "trade") {
        return NextResponse.json(
          { ok: false, error: "Trade panel is paused. Switch panel control to Trade first." },
          { status: 409 }
        );
      }
    }

    if (!agentInitiated && process.env.MORK_AGENT_SWAP_ENABLED !== "1") {
      return NextResponse.json(
        { ok: false, error: "Direct swap is disabled (set MORK_AGENT_SWAP_ENABLED=1 to enable manual swap endpoint)." },
        { status: 403 }
      );
    }

    const amountIn = Number(body.amountIn ?? body.amountSol ?? 0);
    const slippageBps = Math.min(Math.max(Number(body.slippageBps ?? 50), 10), 300);
    const maxSol = Number(process.env.MORK_AGENT_SWAP_MAX_SOL ?? 0.25);
    const inputMint = body.inputMint?.trim() || SOL_MINT;
    const outputMint = body.outputMint?.trim();
    if (!outputMint) {
      return NextResponse.json({ ok: false, error: "outputMint is required" }, { status: 400 });
    }

    if (!Number.isFinite(amountIn) || amountIn <= 0) {
      return NextResponse.json({ ok: false, error: "amountIn must be > 0" }, { status: 400 });
    }

    if (inputMint === SOL_MINT && amountIn > maxSol) {
      return NextResponse.json(
        { ok: false, error: `amountIn exceeds configured max of ${maxSol} SOL` },
        { status: 400 }
      );
    }

    const signer = getSigner();
    const connection = new Connection(RPC, "processed");
    const inDecimals = await getTokenDecimals(inputMint, connection);
    if (inDecimals <= 0 || inDecimals > 12) {
      return NextResponse.json(
        { ok: false, error: `Unable to resolve decimals for input mint ${inputMint}` },
        { status: 400 }
      );
    }
    const inUnits = Math.floor(amountIn * 10 ** inDecimals);

    let quoteResponse: Record<string, unknown> | null = null;
    let jupiterBaseForSwap: string | null = null;
    let quoteError = "Quote failed across all configured Jupiter endpoints.";
    for (const base of getJupiterBaseCandidates()) {
      const quoteUrl = new URL(`${base}/swap/v1/quote`);
      quoteUrl.searchParams.set("inputMint", inputMint);
      quoteUrl.searchParams.set("outputMint", outputMint);
      quoteUrl.searchParams.set("amount", String(inUnits));
      quoteUrl.searchParams.set("slippageBps", String(slippageBps));

      const quoteRes = await fetch(quoteUrl.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
      }).catch(() => null);

      if (!quoteRes) continue;
      if (!quoteRes.ok) {
        const text = await quoteRes.text().catch(() => "");
        quoteError = `Quote failed (${quoteRes.status}): ${text}`;
        continue;
      }
      quoteResponse = (await quoteRes.json()) as Record<string, unknown>;
      jupiterBaseForSwap = base;
      break;
    }

    if (!quoteResponse || !jupiterBaseForSwap) {
      return NextResponse.json({ ok: false, error: quoteError }, { status: 502 });
    }

    const swapRes = await fetch(`${jupiterBaseForSwap}/swap/v1/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(JUP_TIMEOUT_MS),
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

    return NextResponse.json({ ok: true, signature, amountIn, inputMint, outputMint, wallet: signer.publicKey.toBase58() });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "direct swap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
