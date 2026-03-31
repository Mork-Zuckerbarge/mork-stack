"use client";

import { useEffect, useState } from "react";

type AgentState = {
  agent: {
    name: string;
    status: string;
    model: string;
  };
  app?: {
    arb: { status: string };
    sherpa: { status: string };
  };
};

export default function AgentStatusCard() {
  const [state, setState] = useState<AgentState | null>(null);

  useEffect(() => {
    fetch("/api/agent/state")
      .then((r) => r.json())
      .then(setState)
      .catch(() => setState(null));
  }, []);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <h2 className="mb-3 text-lg font-semibold">Agent Status</h2>

      {!state ? (
        <p className="text-sm text-white/60">Unable to load state.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div><span className="text-white/50">Name: </span>{state.agent.name}</div>
          <div><span className="text-white/50">Status: </span>{state.agent.status}</div>
          <div><span className="text-white/50">Model: </span>{state.agent.model}</div>
          <div><span className="text-white/50">Arb: </span>{state.app?.arb?.status || "unknown"}</div>
          <div><span className="text-white/50">Sherpa: </span>{state.app?.sherpa?.status || "unknown"}</div>
        </div>
      )}
    </div>
  );
}
