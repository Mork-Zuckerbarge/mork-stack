"use client";

import { useCallback, useEffect, useState } from "react";

type ArbLog = {
  id: string;
  createdAt: string;
  source: string | null;
  content: string;
};

type LogScope = "arb" | "core" | "sherpa" | "telegram" | "all";

export default function ArbLogFeed() {
  const [logs, setLogs] = useState<ArbLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollMs = 60000;
  const [scope, setScope] = useState<LogScope>("arb");

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/arb/logs?limit=30&scope=${scope}`, { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; items?: ArbLog[]; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || `Failed to load logs (${res.status})`);
        return;
      }
      setLogs(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch {
      setError("Failed to load logs");
    }
  }, [scope]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => {
      void loadLogs();
    }, 0);
    const timer = window.setInterval(() => {
      void loadLogs();
    }, pollMs);

    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [pollMs, loadLogs]);

  return (
    <div className="mt-4 rounded-2xl border border-white/15 bg-black/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Service Logs Feed</h3>
        <div className="flex items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as LogScope)}
            className="rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-xs"
          >
            <option value="arb">arb</option>
            <option value="core">core</option>
            <option value="sherpa">sherpa</option>
            <option value="telegram">telegram</option>
            <option value="all">all</option>
          </select>
          <span className="text-xs text-white/70">Refresh: 60s</span>
          <button className="rounded-lg border border-white/20 px-2 py-1 text-xs" onClick={loadLogs}>
            Refresh
          </button>
        </div>
      </div>

      {error ? <p className="text-xs text-amber-200">{error}</p> : null}

      <div className="max-h-64 space-y-2 overflow-auto pr-1 text-xs">
        {logs.length === 0 ? (
          <p className="text-white/60">No logs yet for this scope.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="rounded-lg border border-white/10 bg-black/35 px-2 py-1">
              <div className="text-[10px] text-white/50">
                {new Date(log.createdAt).toLocaleTimeString()} · {log.source || "unknown"}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-white/85">{log.content}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
