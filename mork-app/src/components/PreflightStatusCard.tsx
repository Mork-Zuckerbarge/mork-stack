"use client";

import { useEffect, useState } from "react";

type PreflightCheck = {
  key: string;
  ok: boolean;
  message: string;
  action?: string;
};

type PreflightState = {
  ok: boolean;
  checks: PreflightCheck[];
};

export default function PreflightStatusCard() {
  const [state, setState] = useState<PreflightState | null>(null);

  async function load() {
    const res = await fetch("/api/preflight", { cache: "no-store" });
    const data = (await res.json()) as PreflightState;
    setState(data);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch(() => setState(null));
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Preflight</h2>
        <button onClick={load} className="rounded-xl border border-white/20 px-3 py-1 text-sm">
          Recheck
        </button>
      </div>

      {!state ? (
        <p className="text-sm text-white/60">Unable to run startup checks.</p>
      ) : (
        <div className="space-y-2 text-sm">
          {state.checks.map((check) => (
            <div key={check.key} className="rounded-xl bg-black/30 p-3">
              <div className={check.ok ? "text-emerald-300" : "text-amber-200"}>
                {check.ok ? "✓" : "!"} {check.message}
              </div>
              {check.action ? <div className="mt-1 text-xs text-white/70">Action: {check.action}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
