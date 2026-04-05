"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import ArbLogFeed from "@/components/ArbLogFeed";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";

const tokenLogos: Record<string, string> = {
  [SOL_MINT]: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  [BBQ_MINT]: "/window.svg",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  Es9vMFrzaCERmJfrF4H2FYD4Xf9LQ4NVY6Yq6iUiJQw:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4Xf9LQ4NVY6Yq6iUiJQw/logo.svg",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/logo.png",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6X8xXQqfS3RzW2X:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/DezXAZ8z7PnrnRJjz3wXBoRgixCa6X8xXQqfS3RzW2X/logo.png",
};

type Pair = {
  id: string;
  baseSymbol: string;
  baseMint: string;
  quoteSymbol: string;
  quoteMint: string;
  supportsDirectSwap: boolean;
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

function TokenLogo({ mint, symbol }: { mint: string; symbol: string }) {
  const src = tokenLogos[mint] ?? "/globe.svg";

  return (
    <Image
      src={src}
      alt={`${symbol} logo`}
      width={28}
      height={28}
      className="h-7 w-7 rounded-full border border-white/20 bg-black/40 object-cover"
      unoptimized
    />
  );
}

function pairLabel(pair: Pair) {
  return `${pair.baseSymbol}/${pair.quoteSymbol}`;
}

export default function JupiterPanel() {
  const [amountSol, setAmountSol] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPairId, setSelectedPairId] = useState(pairs[0].id);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  const selectedPair = pairs.find((pair) => pair.id === selectedPairId) ?? pairs[0];

  const matchingPairs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return [];
    }

    return pairs
      .map((pair) => {
        const symbolKey = `${pair.baseSymbol}/${pair.quoteSymbol}`.toLowerCase();
        const reverseSymbolKey = `${pair.quoteSymbol}/${pair.baseSymbol}`.toLowerCase();
        const mintKey = `${pair.baseMint} ${pair.quoteMint}`.toLowerCase();

        let score = 0;
        if (symbolKey === q || reverseSymbolKey === q) score += 150;
        if (symbolKey.includes(q) || reverseSymbolKey.includes(q)) score += 75;
        if (pair.baseSymbol.toLowerCase() === q || pair.quoteSymbol.toLowerCase() === q) score += 45;
        if (mintKey.includes(q)) score += 60;

        return { pair, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.pair);
  }, [search]);

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
        body: JSON.stringify({ amountSol: amount }),
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
    } catch {
      setStatus({ kind: "error", text: "Swap request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-violet-500/10 via-fuchsia-500/10 to-transparent p-5">
      <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-fuchsia-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />

      <h2 className="relative mb-4 text-lg font-semibold">Wallet Control</h2>

      <div className="relative rounded-3xl border border-white/15 bg-black/35 p-4 backdrop-blur">
        <div className="mb-3 text-xs text-white/70">Search by ticker pair (SOL/USDC) or contract address.</div>

        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type token ticker or CA"
            className="w-full rounded-2xl border border-white/20 bg-black/40 px-4 py-3 text-sm outline-none ring-fuchsia-300/50 transition focus:ring"
          />

          {search.trim() && (
            <div className="absolute z-20 mt-2 w-full rounded-2xl border border-white/15 bg-[#100f1acc] p-2 shadow-2xl backdrop-blur">
              {matchingPairs.length > 0 ? (
                <div className="space-y-1">
                  {matchingPairs.map((pair) => (
                    <button
                      key={pair.id}
                      type="button"
                      onClick={() => {
                        setSelectedPairId(pair.id);
                        setSearch(pairLabel(pair));
                      }}
                      className="flex w-full items-center justify-between rounded-xl border border-transparent bg-white/5 px-3 py-2 text-left transition hover:border-fuchsia-200/35 hover:bg-white/10"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex -space-x-2">
                          <TokenLogo mint={pair.baseMint} symbol={pair.baseSymbol} />
                          <TokenLogo mint={pair.quoteMint} symbol={pair.quoteSymbol} />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{pairLabel(pair)}</p>
                          <p className="text-[10px] text-white/50">
                            {pair.baseMint.slice(0, 4)}…{pair.baseMint.slice(-4)} · {pair.quoteMint.slice(0, 4)}…
                            {pair.quoteMint.slice(-4)}
                          </p>
                        </div>
                      </div>
                      <span className={`text-[10px] ${pair.supportsDirectSwap ? "text-emerald-200" : "text-white/50"}`}>
                        {pair.supportsDirectSwap ? "Live" : "Watch"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/60">
                  No matching pairs.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-white/15 bg-gradient-to-b from-white/10 to-black/25 p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex -space-x-2">
              <TokenLogo mint={selectedPair.baseMint} symbol={selectedPair.baseSymbol} />
              <TokenLogo mint={selectedPair.quoteMint} symbol={selectedPair.quoteSymbol} />
            </div>
            <div>
              <p className="text-base font-semibold">{pairLabel(selectedPair)}</p>
              <p className="text-[11px] text-white/60">
                {selectedPair.supportsDirectSwap ? "Direct swap enabled" : "Display-only pair"}
              </p>
            </div>
          </div>

          <p className="mb-3 text-xs text-white/70">
            Server-side execution via configured agent keypair. Requires
            <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_AGENT_SWAP_ENABLED=1</code>
            and
            <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_WALLET_SECRET_KEY</code>.
          </p>

          <label className="text-xs text-white/70">
            Amount ({selectedPair.baseSymbol})
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              className="mt-1 block w-full rounded-xl border border-white/20 bg-black/40 px-3 py-2 text-sm"
            />
          </label>

          <button
            onClick={submitDirectSwap}
            disabled={busy}
            className="mt-3 w-full rounded-xl border border-fuchsia-200/50 bg-gradient-to-r from-fuchsia-300/20 to-violet-300/20 px-3 py-2 text-sm disabled:opacity-50"
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
