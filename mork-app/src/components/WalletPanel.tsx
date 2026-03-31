"use client";

import { useEffect, useState } from "react";

type WalletState = {
  address: string | null;
  sol: number;
  bbq: number;
  usdc: number;
  requirementMet: boolean;
};

export default function WalletPanel() {
  const [wallet, setWallet] = useState<WalletState | null>(null);

  async function loadState() {
    try {
      const res = await fetch("/api/agent/state");
      const data = await res.json();
      setWallet(data.wallet);
    } catch {
      setWallet(null);
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Wallet</h2>
        <button
          onClick={loadState}
          className="rounded-xl border border-white/10 px-3 py-1 text-sm"
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

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl bg-black/30 p-3">
              <div className="text-xs text-white/50">SOL</div>
              <div className="text-lg">{wallet.sol}</div>
            </div>
            <div className="rounded-2xl bg-black/30 p-3">
              <div className="text-xs text-white/50">BBQ</div>
              <div className="text-lg">{wallet.bbq}</div>
            </div>
            <div className="rounded-2xl bg-black/30 p-3">
              <div className="text-xs text-white/50">USDC</div>
              <div className="text-lg">{wallet.usdc}</div>
            </div>
          </div>

          <div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs">
              {wallet.requirementMet ? "1000 BBQ requirement met" : "Below 1000 BBQ"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
