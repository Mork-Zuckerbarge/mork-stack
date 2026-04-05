"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import ArbLogFeed from "@/components/ArbLogFeed";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";

const tokenLogos: Record<string, string> = {
  [SOL_MINT]: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  [BBQ_MINT]: "/window.svg",
};

type Pair = {
  id: string;
  baseSymbol: string;
  baseMint: string;
  quoteSymbol: string;
  quoteMint: string;
  supportsDirectSwap: boolean;
};

function pairLabel(pair: Pair): string {
  return `${pair.baseSymbol} → ${pair.quoteSymbol}`;
}

const pairs: Pair[] = [
  {
    id: "sol-bbq",
    baseSymbol: "SOL",
    baseMint: SOL_MINT,
    quoteSymbol: "BBQ",
    quoteMint: BBQ_MINT,
    supportsDirectSwap: true,
  },
  {
    id: "sol-usdc",
    baseSymbol: "SOL",
    baseMint: SOL_MINT,
    quoteSymbol: "USDC",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    supportsDirectSwap: false,
  },
  {
    id: "sol-usdt",
    baseSymbol: "SOL",
    baseMint: SOL_MINT,
    quoteSymbol: "USDT",
    quoteMint: "Es9vMFrzaCERmJfrF4H2FYD4Xf9LQ4NVY6Yq6iUiJQw",
    supportsDirectSwap: false,
  },
  {
    id: "sol-jup",
    baseSymbol: "SOL",
    baseMint: SOL_MINT,
    quoteSymbol: "JUP",
    quoteMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    supportsDirectSwap: false,
  },
  {
    id: "sol-bonk",
    baseSymbol: "SOL",
    baseMint: SOL_MINT,
    quoteSymbol: "BONK",
    quoteMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6X8xXQqfS3RzW2X",
    supportsDirectSwap: false,
  },
];

type SwapResponse = {
  ok: boolean;
  signature?: string;
  error?: string;
  wallet?: string;
};

type WalletState = {
  address: string | null;
  sol: number;
  bbq: number;
  usdc: number;
  requirementMet: boolean;
};

type QuoteResponse = {
  ok: boolean;
  inAmount?: number;
  outAmount?: number;
  otherAmountThreshold?: number;
  priceImpactPct?: string;
  routeFeeAmount?: number;
  routeFeeSymbol?: string;
  error?: string;
};

function TokenLogo({ mint, symbol }: { mint: string; symbol: string }) {
  const src = tokenLogos[mint] ?? "/globe.svg";

  return (
    <Image
      src={src}
      alt={`${symbol} logo`}
      width={24}
      height={24}
      className="h-6 w-6 rounded-full border border-white/20 bg-black/40 object-cover"
      unoptimized
    />
  );
}

export default function JupiterPanel() {
  const [amountSol, setAmountSol] = useState("0.05");
  const [slippageBps, setSlippageBps] = useState(50);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPairId, setSelectedPairId] = useState(pairs[0].id);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  const filteredPairs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pairs;

    return pairs.filter((pair) => {
      const symbols = `${pair.baseSymbol}/${pair.quoteSymbol}`.toLowerCase();
      const mints = `${pair.baseMint} ${pair.quoteMint}`.toLowerCase();
      return symbols.includes(q) || mints.includes(q);
    });
  }, [search]);

  const selectedPair = pairs.find((pair) => pair.id === selectedPairId) ?? pairs[0];
  const parsedAmountSol = Number(amountSol);

  function tradeMaxAmount() {
    if (!wallet) return;
    const max = Math.max(wallet.sol - 0.01, 0);
    setAmountSol(max.toFixed(4));
  }

  const loadWallet = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/state", { cache: "no-store" });
      const data = (await res.json()) as { wallet?: WalletState };
      setWallet(data.wallet ?? null);
    } catch {
      setWallet(null);
    }
  }, []);

  const loadQuote = useCallback(async () => {
    if (!Number.isFinite(parsedAmountSol) || parsedAmountSol <= 0) {
      setQuote(null);
      return;
    }
    try {
      const res = await fetch("/api/trade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountSol: parsedAmountSol,
          inputMint: selectedPair.baseMint,
          outputMint: selectedPair.quoteMint,
          slippageBps,
        }),
      });
      const data = (await res.json()) as QuoteResponse;
      setQuote(res.ok && data.ok ? data : { ok: false, error: data.error || `Quote failed (${res.status})` });
    } catch {
      setQuote({ ok: false, error: "Quote unavailable" });
    }
  }, [parsedAmountSol, selectedPair.baseMint, selectedPair.quoteMint, slippageBps]);

  useEffect(() => {
    void loadWallet();
  }, [loadWallet]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadQuote();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadQuote]);

  async function submitDirectSwap() {
    if (!selectedPair.supportsDirectSwap) {
      setStatus({
        kind: "error",
        text: "This pair is display-only for now. Direct execution is currently enabled only for SOL/BBQ.",
      });
      return;
    }

    setBusy(true);
    setStatus({ kind: "idle", text: "" });

    try {
      const amount = Number(amountSol);
      const res = await fetch("/api/trade/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountSol: amount,
          slippageBps,
          inputMint: selectedPair.baseMint,
          outputMint: selectedPair.quoteMint,
        }),
      });

      const data = (await res.json()) as SwapResponse;
      if (!res.ok || !data.ok) {
        setStatus({ kind: "error", text: data.error || `Swap failed (${res.status})` });
        return;
      }

      setStatus({
        kind: "ok",
        text: `Swap sent from ${data.wallet || "agent wallet"}. Signature: ${data.signature}`,
      });
      void loadWallet();
      void loadQuote();
    } catch {
      setStatus({ kind: "error", text: "Swap request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">wallet control</h2>
      <p className="mb-3 text-xs text-white/70">Control position size, slippage, and execution for agent wallet swaps.</p>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">SOL balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.sol.toFixed(4) : "—"}</div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">BBQ balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.bbq.toFixed(4) : "—"}</div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">USDC balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.usdc.toFixed(4) : "—"}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Pairs</h3>
            <input
              type="text"
              placeholder="Search pair or mint"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-52 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-xs"
            />
          </div>

          <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
            {filteredPairs.map((pair) => {
              const selected = pair.id === selectedPair.id;

              return (
                <button
                  key={pair.id}
                  type="button"
                  onClick={() => setSelectedPairId(pair.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    selected
                      ? "border-amber-200/50 bg-amber-300/15"
                      : "border-white/10 bg-black/25 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex -space-x-2">
                        <TokenLogo mint={pair.baseMint} symbol={pair.baseSymbol} />
                        <TokenLogo mint={pair.quoteMint} symbol={pair.quoteSymbol} />
                      </div>
                      <span className="text-sm font-medium">
                        {pair.baseSymbol}/{pair.quoteSymbol}
                      </span>
                    </div>
                    <span className={`text-[10px] ${pair.supportsDirectSwap ? "text-emerald-200" : "text-white/55"}`}>
                      {pair.supportsDirectSwap ? "Live" : "Watch"}
                    </span>
                  </div>
                </button>
              );
            })}

            {filteredPairs.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-4 text-xs text-white/60">
                No pairs found for “{search}”.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex -space-x-2">
              <TokenLogo mint={selectedPair.baseMint} symbol={selectedPair.baseSymbol} />
              <TokenLogo mint={selectedPair.quoteMint} symbol={selectedPair.quoteSymbol} />
            </div>
            <div>
              <p className="text-base font-semibold">{pairLabel(selectedPair)}</p>
              <p className="text-sm font-semibold">
                {selectedPair.baseSymbol}/{selectedPair.quoteSymbol}
              </p>
              <p className="text-[11px] text-white/60">
                {selectedPair.supportsDirectSwap ? "Direct swap enabled" : "Display-only pair"}
              </p>
            </div>
          </div>

          <p className="mb-3 text-xs text-white/70">
            Executes server-side via the configured agent keypair (no browser extension). Requires
            <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_AGENT_SWAP_ENABLED=1</code>
            and
            <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_WALLET_SECRET_KEY</code>.
          </p>

          <div className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-[11px] text-white/80">
            Mints: {selectedPair.baseMint.slice(0, 4)}…{selectedPair.baseMint.slice(-4)} / {selectedPair.quoteMint.slice(0, 4)}…
            {selectedPair.quoteMint.slice(-4)}
          </div>

          <label className="text-xs text-white/70">
            Amount ({selectedPair.baseSymbol})
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
            />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={tradeMaxAmount}
              className="rounded-lg border border-white/20 bg-black/40 px-2 py-1"
            >
              Trade max
            </button>
            <button
              type="button"
              onClick={loadWallet}
              className="rounded-lg border border-white/20 bg-black/40 px-2 py-1"
            >
              Refresh balances
            </button>
          </div>

          <label className="mt-3 block text-xs text-white/70">
            Slippage tolerance (bps)
            <input
              type="number"
              min={10}
              max={300}
              step={5}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Math.min(300, Math.max(10, Number(e.target.value) || 50)))}
              className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
            />
          </label>

          <div className="mt-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-[11px] text-white/80">
            <div className="flex items-center justify-between">
              <span>Quote</span>
              <button type="button" onClick={loadQuote} className="rounded border border-white/20 px-1.5 py-0.5 text-[10px]">
                Refresh
              </button>
            </div>
            {!quote ? (
              <p className="mt-1 text-white/55">Enter an amount to view estimated output, fee, and min received.</p>
            ) : quote.ok ? (
              <div className="mt-1 space-y-1">
                <div>
                  Estimated output: {quote.outAmount?.toLocaleString()} {selectedPair.quoteSymbol}
                </div>
                <div>
                  Min received (slippage applied): {quote.otherAmountThreshold?.toLocaleString()} {selectedPair.quoteSymbol}
                </div>
                <div>
                  Route fee: {quote.routeFeeAmount?.toLocaleString()} {quote.routeFeeSymbol || selectedPair.quoteSymbol}
                </div>
                <div>Price impact: {quote.priceImpactPct || "0"}%</div>
              </div>
            ) : (
              <p className="mt-1 text-amber-200">{quote.error || "Quote unavailable"}</p>
            )}
          </div>

          <button
            onClick={submitDirectSwap}
            disabled={busy || !selectedPair.supportsDirectSwap}
            className="mt-3 w-full rounded-xl border border-amber-200/40 bg-amber-300/10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Submitting…" : `Swap ${selectedPair.baseSymbol} → ${selectedPair.quoteSymbol}`}
          </button>

          {status.kind !== "idle" ? (
            <p className={`mt-3 text-xs ${status.kind === "ok" ? "text-emerald-200" : "text-amber-200"}`}>
              {status.text}
            </p>
          ) : null}
        </div>
      </div>

      <ArbLogFeed />
    </div>
  );
}
