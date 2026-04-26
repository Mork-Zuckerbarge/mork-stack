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

  async function loadState(force = false) {
    try {
      const endpoint = force ? "/api/wallet/state?force=1" : "/api/wallet/state";
      const res = await fetch(endpoint, { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; wallet?: WalletState };
      if (!res.ok || data.ok === false) {
        setWallet(null);
        return;
      }
      setWallet(data.wallet ?? null);
    } catch {
      setWallet(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadState();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="rounded-3xl border border-emerald-300/20 bg-gradient-to-b from-emerald-400/10 to-transparent p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Wallet</h2>
        <button
          onClick={() => void loadState(true)}
          className="rounded-xl border border-white/20 px-3 py-1 text-sm"
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

          <div className="grid grid-cols-2 gap-2 text-xs">
            <span className="rounded-full bg-white/10 px-3 py-1 text-left">
              User Control: {wallet.address ? "Enabled" : "Needs Wallet"}
            </span>
            <span className="rounded-full bg-white/10 px-3 py-1 text-left">
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
  );
}
