"use client";

import { useEffect, useState } from "react";

type State = {
  agent: {
    status: string;
  };
  wallet: {
    address: string | null;
  };
};

export default function StatusPanel() {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    fetch("/api/agent/state")
      .then((r) => r.json())
      .then(setState)
      .catch(() => setState(null));
  }, []);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <h2 className="mb-3 text-lg font-semibold">Status</h2>

      {!state ? (
        <p className="text-sm text-white/60">Unable to load status.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div>Core: {state.agent.status}</div>
          <div>Wallet: {state.wallet.address ? "configured" : "not configured"}</div>
        </div>
      )}
    </div>
  );
}
