"use client";

import { useState } from "react";
import ArbLogFeed from "@/components/ArbLogFeed";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";

type SwapResponse = {
  ok: boolean;
  signature?: string;
  error?: string;
  wallet?: string;
};

export default function JupiterPanel() {
  const [amountSol, setAmountSol] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  async function submitDirectSwap() {
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
      <div className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-[11px] text-white/80">
        Pair: SOL ({SOL_MINT.slice(0, 4)}…{SOL_MINT.slice(-4)}) / BBQ ({BBQ_MINT.slice(0, 4)}…{BBQ_MINT.slice(-4)}) ·{" "}
        <a className="underline" href={`https://solscan.io/token/${SOL_MINT}`} target="_blank" rel="noreferrer">
          SOL mint
        </a>{" "}
        ·{" "}
        <a className="underline" href={`https://solscan.io/token/${BBQ_MINT}`} target="_blank" rel="noreferrer">
          BBQ mint
        </a>
      </div>

      <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
        <p className="mb-3 text-xs text-white/70">
          Executes server-side via the configured agent keypair (no browser extension). Requires
          <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_AGENT_SWAP_ENABLED=1</code>
          and
          <code className="mx-1 rounded bg-black/50 px-1 py-0.5">MORK_WALLET_SECRET_KEY</code>.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-white/70">
            Amount (SOL)
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              className="mt-1 block w-40 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
            />
          </label>

          <button
            onClick={submitDirectSwap}
            disabled={busy}
            className="rounded-xl border border-amber-200/40 bg-amber-300/10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Swap SOL → BBQ"}
          </button>
        </div>

        {status.kind !== "idle" ? (
          <p className={`mt-3 text-xs ${status.kind === "ok" ? "text-emerald-200" : "text-amber-200"}`}>
            {status.text}
          </p>
        ) : null}
      </div>

      <ArbLogFeed />
    </div>
  );
}
