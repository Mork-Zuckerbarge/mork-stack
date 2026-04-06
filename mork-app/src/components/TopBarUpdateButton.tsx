"use client";

import { useCallback, useEffect, useState } from "react";

type UpdateState = {
  branch: string;
  behind: number;
  hasUpdates: boolean;
};

export default function TopBarUpdateButton() {
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [statusText, setStatusText] = useState("");

  const loadUpdateState = useCallback(async () => {
    try {
      const res = await fetch("/api/system/update", { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; update?: UpdateState };
      if (!res.ok || !data.ok || !data.update) {
        setUpdateState(null);
        return;
      }
      setUpdateState(data.update);
    } catch {
      setUpdateState(null);
    }
  }, []);

  useEffect(() => {
    void loadUpdateState();
  }, [loadUpdateState]);

  async function runUpdate() {
    if (busy) return;
    setBusy(true);
    setStatusText("");
    try {
      const res = await fetch("/api/system/update", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string; update?: UpdateState };
      if (!res.ok || !data.ok) {
        setStatusText(data.error || `Update failed (${res.status})`);
        return;
      }
      setUpdateState(data.update ?? null);
      setStatusText(data.message || "Updated");
    } catch {
      setStatusText("Update failed");
    } finally {
      setBusy(false);
    }
  }

  const hasUpdates = Boolean(updateState?.hasUpdates);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={hasUpdates ? runUpdate : loadUpdateState}
        disabled={busy}
        className="rounded-xl border border-cyan-300/40 bg-cyan-200/10 px-3 py-1.5 text-xs"
        title="Check for updates and pull latest code while restoring wallet/env/credential files."
      >
        {busy ? "Updating…" : hasUpdates ? `Update (${updateState?.behind})` : "Check updates"}
      </button>
      <div className="text-[11px] text-white/60">
        {statusText || (updateState ? `${updateState.branch} · ${hasUpdates ? `${updateState.behind} behind` : "up to date"}` : "version unknown")}
      </div>
    </div>
  );
}
