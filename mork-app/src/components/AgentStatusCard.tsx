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

type ChannelActivity = {
  telegram?: {
    count: number;
    items: Array<{ createdAt: string; content: string; source: string | null }>;
  };
  arbLearning?: {
    routeResearchCount: number;
  };
  latestEpisode?: {
    createdAt: string;
    learned: string;
    summary: string;
  } | null;
  arbRuntime?: {
    armed: boolean;
    paper: boolean;
  };
};

export default function AgentStatusCard() {
  const [state, setState] = useState<AgentState | null>(null);
  const [activity, setActivity] = useState<ChannelActivity | null>(null);
  const [plannerStatus] = useState("server-managed");

  useEffect(() => {
    let cancelled = false;

    async function refreshState() {
      try {
        const [agentRes, activityRes] = await Promise.all([
          fetch("/api/agent/state", { cache: "no-store" }),
          fetch("/api/channel/activity", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        setState(await agentRes.json());
        setActivity(await activityRes.json());
      } catch {
        if (!cancelled) {
          setState(null);
          setActivity(null);
        }
      }
    }

    void refreshState();
    const interval = window.setInterval(() => {
      void refreshState();
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
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
          <div>
            <span className="text-white/50">Arb execution: </span>
            {activity?.arbRuntime?.armed ? "ARMED" : "SAFE (not armed)"} / {activity?.arbRuntime?.paper ? "paper" : "live"}
          </div>
          <div><span className="text-white/50">Planner tick: </span>{plannerStatus}</div>
          <div><span className="text-white/50">Telegram memory events: </span>{activity?.telegram?.count ?? 0}</div>
          <div><span className="text-white/50">Arb learning events: </span>{activity?.arbLearning?.routeResearchCount ?? 0}</div>

          {activity?.telegram?.items?.length ? (
            <div className="rounded-2xl border border-white/10 bg-black/30 p-2 text-xs text-white/70">
              <div className="mb-1 text-[11px] text-white/50">Recent Telegram activity</div>
              {activity.telegram.items.slice(0, 3).map((item) => (
                <div key={`${item.createdAt}-${item.content.slice(0, 32)}`} className="truncate">
                  {item.content}
                </div>
              ))}
            </div>
          ) : null}

          {activity?.latestEpisode?.learned ? (
            <div className="rounded-2xl border border-white/10 bg-black/30 p-2 text-xs text-white/70">
              <div className="mb-1 text-[11px] text-white/50">Latest learning note</div>
              <div className="line-clamp-3">{activity.latestEpisode.learned}</div>
            </div>
          ) : null}

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
