"use client";

import { useState } from "react";
import {
  getMoltbookFeed,
  getMoltbookHome,
  getSavedMoltbookApiKey,
  saveMoltbookApiKey,
  clearSavedMoltbookApiKey,
} from "@/lib/integrations/moltbookAgent";

type MoltbookSnapshot = {
  checkedAt: string;
  feedCount: number;
};

export default function MoltbookStatusCard() {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [snapshot, setSnapshot] = useState<MoltbookSnapshot | null>(null);

  const hasKey = typeof window !== "undefined" && Boolean(getSavedMoltbookApiKey());

  async function runHeartbeat() {
    setRunning(true);
    setStatus("Checking Moltbook /home and /feed...");
    try {
      await getMoltbookHome();
      const feed = await getMoltbookFeed({ sort: "new", limit: 3 });
      const posts = Array.isArray(feed.posts) ? feed.posts.length : 0;
      setSnapshot({ checkedAt: new Date().toISOString(), feedCount: posts });
      setStatus("Moltbook heartbeat passed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Moltbook error";
      setStatus(`Moltbook heartbeat failed: ${message}`);
    } finally {
      setRunning(false);
    }
  }

  function saveKey() {
    if (!apiKeyInput.trim()) {
      setStatus("Enter a Moltbook API key first.");
      return;
    }

    saveMoltbookApiKey(apiKeyInput.trim());
    setApiKeyInput("");
    setStatus("Saved Moltbook API key to browser storage.");
  }

  function clearKey() {
    clearSavedMoltbookApiKey();
    setStatus("Cleared Moltbook API key from browser storage.");
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-4 space-y-3">
      <h3 className="text-lg font-semibold">Moltbook Status</h3>
      <p className="text-sm text-white/70">Use this panel to store the API key and run a manual heartbeat check.</p>

      <div className="text-sm">
        <span className="text-white/70">API key present:</span>{" "}
        <span className={hasKey ? "text-emerald-300" : "text-amber-300"}>{hasKey ? "yes" : "no"}</span>
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          placeholder="moltbook_xxx"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
        />
        <button onClick={saveKey} className="rounded-xl bg-cyan-300/90 px-3 py-2 text-sm font-medium text-black">
          Save Key
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={runHeartbeat}
          disabled={running || !hasKey}
          className="rounded-xl bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {running ? "Checking..." : "Run Heartbeat"}
        </button>
        <button onClick={clearKey} className="rounded-xl border border-white/20 px-3 py-2 text-sm">
          Clear Key
        </button>
      </div>

      {snapshot ? (
        <div className="text-xs text-white/70">
          Last check: {snapshot.checkedAt} · feed sample count: {snapshot.feedCount}
        </div>
      ) : null}

      {status ? <div className="text-xs text-white/80">{status}</div> : null}
    </div>
  );
}
