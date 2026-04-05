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

type TokenOption = {
  symbol: string;
  mint: string;
};

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
  const [inputSearch, setInputSearch] = useState("");
  const [outputSearch, setOutputSearch] = useState("");
  const [selectedInputMint, setSelectedInputMint] = useState(SOL_MINT);
  const [selectedOutputMint, setSelectedOutputMint] = useState(BBQ_MINT);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  const tokens = useMemo(() => {
    const tokenMap = new Map<string, TokenOption>();
    for (const pair of pairs) {
      tokenMap.set(pair.baseMint, { symbol: pair.baseSymbol, mint: pair.baseMint });
      tokenMap.set(pair.quoteMint, { symbol: pair.quoteSymbol, mint: pair.quoteMint });
    }
    return Array.from(tokenMap.values());
  }, []);

  const selectedInputToken = tokens.find((token) => token.mint === selectedInputMint) ?? tokens[0];
  const selectedOutputToken = tokens.find((token) => token.mint === selectedOutputMint) ?? tokens[1];
  const selectedPair = useMemo(
    () =>
      pairs.find((pair) => pair.baseMint === selectedInputMint && pair.quoteMint === selectedOutputMint) ?? {
        id: "custom",
        baseSymbol: selectedInputToken.symbol,
        baseMint: selectedInputToken.mint,
        quoteSymbol: selectedOutputToken.symbol,
        quoteMint: selectedOutputToken.mint,
        supportsDirectSwap: false,
      },
    [selectedInputMint, selectedOutputMint, selectedInputToken, selectedOutputToken],
  );
  const filteredInputTokens = useMemo(() => {
    const q = inputSearch.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) => token.symbol.toLowerCase().includes(q) || token.mint.toLowerCase().includes(q));
  }, [inputSearch, tokens]);
  const filteredOutputTokens = useMemo(() => {
    const q = outputSearch.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((token) => token.symbol.toLowerCase().includes(q) || token.mint.toLowerCase().includes(q));
  }, [outputSearch, tokens]);
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
          inputMint: selectedInputMint,
          outputMint: selectedOutputMint,
          slippageBps,
        }),
      });
      const data = (await res.json()) as QuoteResponse;
      setQuote(res.ok && data.ok ? data : { ok: false, error: data.error || `Quote failed (${res.status})` });
    } catch {
      setQuote({ ok: false, error: "Quote unavailable" });
    }
  }, [parsedAmountSol, selectedInputMint, selectedOutputMint, slippageBps]);

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
          inputMint: selectedInputMint,
          outputMint: selectedOutputMint,
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

  const selectedPairLabel = pairLabel(selectedPair);

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

      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Wallet</h3>
            <button
              type="button"
              onClick={loadWallet}
              className="rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-xs"
            >
              Refresh
            </button>
          </div>

          {!wallet ? (
            <p className="text-sm text-white/60">No wallet data yet.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-white/50">Address</div>
                <div className="break-all">{wallet.address || "Not configured"}</div>
              </div>
              <div className="rounded-2xl bg-black/35 p-3 text-xs text-white/70">
                Full control is user-custodied; agent actions are constrained by active runtime and your configured wallet.
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="rounded-full bg-white/10 px-3 py-1 text-center">
                  User Control: {wallet.address ? "Enabled" : "Needs Wallet"}
                </span>
                <span className="rounded-full bg-white/10 px-3 py-1 text-center">
                  Agent Control: {wallet.address ? "Enabled" : "Locked"}
                </span>
              </div>
              <div>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs">
                  {wallet.requirementMet ? "BBQ requirement met ✅" : "Below BBQ threshold"}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex -space-x-2">
              <TokenLogo mint={selectedPair.baseMint} symbol={selectedPair.baseSymbol} />
              <TokenLogo mint={selectedPair.quoteMint} symbol={selectedPair.quoteSymbol} />
            </div>
            <div>
              <p className="text-base font-semibold">{selectedPairLabel}</p>
              <p className="text-sm font-semibold">
                {selectedPair.baseSymbol}/{selectedPair.quoteSymbol}
              </p>
            </div>
          </div>

          <div className="mb-3 space-y-2">
            <label className="block text-xs text-white/70">
              Input token (ticker or CA)
              <input
                type="text"
                value={inputSearch}
                onChange={(e) => setInputSearch(e.target.value)}
                placeholder="Search ticker or contract address"
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2">
              {filteredInputTokens.map((token) => {
                const selected = token.mint === selectedInputMint;
                return (
                  <button
                    key={`input-${token.mint}`}
                    type="button"
                    onClick={() => setSelectedInputMint(token.mint)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs ${
                      selected ? "bg-amber-300/15 text-amber-100" : "hover:bg-white/10"
                    }`}
                  >
                    <span>{token.symbol}</span>
                    <span className="text-white/60">
                      {token.mint.slice(0, 4)}…{token.mint.slice(-4)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-3 space-y-2">
            <label className="block text-xs text-white/70">
              Output token (ticker or CA)
              <input
                type="text"
                value={outputSearch}
                onChange={(e) => setOutputSearch(e.target.value)}
                placeholder="Search ticker or contract address"
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2">
              {filteredOutputTokens.map((token) => {
                const selected = token.mint === selectedOutputMint;
                return (
                  <button
                    key={`output-${token.mint}`}
                    type="button"
                    onClick={() => setSelectedOutputMint(token.mint)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs ${
                      selected ? "bg-amber-300/15 text-amber-100" : "hover:bg-white/10"
                    }`}
                  >
                    <span>{token.symbol}</span>
                    <span className="text-white/60">
                      {token.mint.slice(0, 4)}…{token.mint.slice(-4)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="text-xs text-white/70">
            Amount ({selectedInputToken.symbol})
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
                  Estimated output: {quote.outAmount?.toLocaleString()} {selectedOutputToken.symbol}
                </div>
                <div>
                  Min received (slippage applied): {quote.otherAmountThreshold?.toLocaleString()} {selectedOutputToken.symbol}
                </div>
                <div>
                  Route fee: {quote.routeFeeAmount?.toLocaleString()} {quote.routeFeeSymbol || selectedOutputToken.symbol}
                </div>
                <div>Price impact: {quote.priceImpactPct || "0"}%</div>
              </div>
            ) : (
              <p className="mt-1 text-amber-200">{quote.error || "Quote unavailable"}</p>
            )}
          </div>

          <button
            onClick={submitDirectSwap}
            disabled={busy || !selectedPair.supportsDirectSwap || selectedInputMint === selectedOutputMint}
            className="mt-3 w-full rounded-xl border border-amber-200/40 bg-amber-300/10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Submitting…" : `Swap ${selectedInputToken.symbol} → ${selectedOutputToken.symbol}`}
          </button>

          {!selectedPair.supportsDirectSwap ? (
            <p className="mt-3 text-xs text-white/60">
              Direct execution is currently enabled only for SOL/BBQ in this environment.
            </p>
          ) : null}

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
