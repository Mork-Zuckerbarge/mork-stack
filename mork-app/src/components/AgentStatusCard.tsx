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
    <div className="rounded-3xl border border-violet-300/20 bg-gradient-to-b from-violet-500/10 to-transparent p-5">
      <h2 className="mb-3 text-lg font-semibold">Channels</h2>

      {!state ? (
        <p className="text-sm text-white/60">Unable to load state.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div><span className="text-white/50">Name: </span>{state.agent.name}</div>
          <div><span className="text-white/50">Status: </span>{state.agent.status}</div>
          <div><span className="text-white/50">Model: </span>{state.agent.model}</div>
          <div><span className="text-white/50">Arb: </span>{state.app?.arb?.status || "unknown"}</div>
          <div><span className="text-white/50">Sherpa: </span>{state.app?.sherpa?.status || "unknown"}</div>

          <div className="mt-3 space-y-2">
            <PersonaRow channel="App Control Panel" tone="Code-first copilot" enabled />
            <PersonaRow channel="Telegram" tone="Helpful CEO operator" enabled />
            <PersonaRow channel="X / Twitter" tone="Cynical updates + banter" enabled />
          </div>
        </div>
      )}
    </div>
  );
}

function PersonaRow({
  channel,
  tone,
  enabled,
}: {
  channel: string;
  tone: string;
  enabled: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{channel}</span>
        <span className={enabled ? "text-emerald-300" : "text-white/60"}>
          {enabled ? "ON" : "OFF"}
        </span>
      </div>
      <div className="mt-1 text-xs text-white/60">{tone}</div>
    </div>
  );
}
