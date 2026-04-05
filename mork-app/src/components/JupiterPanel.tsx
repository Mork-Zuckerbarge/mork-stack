"use client";

import { useMemo, useState } from "react";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";

export default function JupiterPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showEmbed, setShowEmbed] = useState(false);
  const swapUrl = useMemo(
    () => `https://jup.ag/swap?sell=${encodeURIComponent(SOL_MINT)}&buy=${encodeURIComponent(BBQ_MINT)}`,
    []
  );

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Jupiter Trade Window</h2>
      <p className="mb-3 text-xs text-white/60">Direct Jupiter swap surface for SOL ⇄ BBQ with a quick Solana pair reference.</p>
      <div className="mb-3 rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-100">
        Wallet note: Jupiter uses the wallet connected inside the embedded jup.ag window (usually your browser wallet extension),
        not the backend MORK runtime wallet shown in the Wallet panel.
      </div>

      <div className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-[11px] text-white/80">
        Pair link: SOL ({SOL_MINT.slice(0, 4)}…{SOL_MINT.slice(-4)}) / BBQ ({BBQ_MINT.slice(0, 4)}…{BBQ_MINT.slice(-4)}) ·{" "}
        <a
          className="underline"
          href={`https://solscan.io/token/${SOL_MINT}`}
          target="_blank"
          rel="noreferrer"
        >
          SOL mint
        </a>{" "}
        ·{" "}
        <a
          className="underline"
          href={`https://solscan.io/token/${BBQ_MINT}`}
          target="_blank"
          rel="noreferrer"
        >
          BBQ mint
        </a>{" "}
        ·{" "}
        <a className="underline" href={swapUrl} target="_blank" rel="noreferrer">
          Open on jup.ag
        </a>
      </div>

      {!showEmbed ? (
        <div className="rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div>Embedded Jupiter is disabled by default to prevent surprise wallet/session confusion.</div>
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              setShowEmbed(true);
            }}
            className="mt-2 rounded-lg border border-amber-200/40 px-2 py-1 text-amber-50"
          >
            Open embedded Jupiter
          </button>
        </div>
      ) : (
        <>
          {status === "loading" ? (
            <p className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-xs text-white/70">Loading Jupiter window…</p>
          ) : null}

          {status === "error" ? (
            <div className="mb-3 rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              <div>Jupiter window failed to load in-app.</div>
              <div className="mt-1 text-amber-50/90">
                Open directly:{" "}
                <a className="underline" href={swapUrl} target="_blank" rel="noreferrer">
                  {swapUrl}
                </a>
              </div>
              <div className="mt-1 text-amber-50/80">If an ad/tracker blocker is active, allow jup.ag and refresh.</div>
            </div>
          ) : null}

          <iframe
            key={swapUrl}
            src={swapUrl}
            title="Jupiter SOL to BBQ swap"
            className="min-h-[520px] w-full rounded-2xl bg-black/30"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="clipboard-write"
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
        </>
      )}
    </div>
  );
}
