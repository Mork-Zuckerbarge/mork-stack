"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
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
      width={24}
      height={24}
      className="h-6 w-6 rounded-full border border-white/20 bg-black/40 object-cover"
      unoptimized
    />
  );
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
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Jupiter Direct (Agent Wallet)</h2>
      <p className="mb-3 text-xs text-white/70">DEX-style pair browser with quick search and token logos.</p>

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
            Server-side execution via configured agent keypair. Requires
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

          <button
            onClick={submitDirectSwap}
            disabled={busy}
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
