"use client";

import { useEffect, useState } from "react";

type RuntimeStatus = "running" | "stopped";

type AppControlState = {
  arb: { status: RuntimeStatus; updatedAt: string };
  sherpa: { status: RuntimeStatus; updatedAt: string };
  controls: {
    memoryEnabled: boolean;
    plannerEnabled: boolean;
    messagingEnabled: boolean;
    walletAutoRefreshEnabled: boolean;
  };
  walletProvisioning: {
    status: "provisioned_existing" | "needs_setup";
    address: string | null;
  };
};

export default function AppControlPanel() {
  const [state, setState] = useState<AppControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");

  async function load() {
    const res = await fetch("/api/app/control");
    const data = await res.json();
    if (data?.ok) setState(data.state);
  }

  useEffect(() => {
    load().catch(() => setState(null));
  }, []);

  async function act(action: string, extra?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setStatusText("");

    try {
      const res = await fetch("/api/app/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });

      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatusText(data?.error || `Action failed (${res.status})`);
      } else {
        setState(data.state);
        setStatusText("Updated");
      }
    } catch {
      setStatusText("Failed to update controls");
    } finally {
      setBusy(false);
    }
  }

  async function refreshWalletMemory() {
    if (busy) return;
    setBusy(true);
    setStatusText("");

    try {
      const res = await fetch("/api/wallet/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatusText(data?.error || `Wallet refresh failed (${res.status})`);
      } else {
        setStatusText("Wallet memory refreshed");
      }
    } catch {
      setStatusText("Wallet refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-cyan-300/20 bg-gradient-to-b from-cyan-400/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">System</h2>
      <p className="mb-3 text-xs text-white/60">Status, orchestration, and channel switches.</p>

      {!state ? (
        <p className="text-sm text-white/60">Unable to load app controls.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 gap-2 rounded-2xl bg-black/35 p-3">
            <InfoLine label="Status" value="ONLINE" ok />
            <InfoLine label="Model" value="Ollama / OpenAI" />
            <InfoLine
              label="Memory"
              value={state.controls.memoryEnabled ? "Active" : "Paused"}
              ok={state.controls.memoryEnabled}
            />
          </div>

          <StatusRow
            label="Arb"
            status={state.arb.status}
            onStart={() => act("arb.start")}
            onStop={() => act("arb.stop")}
            busy={busy}
          />
          <StatusRow
            label="Sherpa"
            status={state.sherpa.status}
            onStart={() => act("sherpa.start")}
            onStop={() => act("sherpa.stop")}
            busy={busy}
          />

          <div className="grid grid-cols-1 gap-2 rounded-2xl bg-black/35 p-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-white/60">Research + Controls</div>
            <FlagToggle
              label="Memory"
              enabled={state.controls.memoryEnabled}
              onToggle={(value) =>
                act("controls.set", { key: "memoryEnabled", value })
              }
              busy={busy}
            />
            <FlagToggle
              label="Planner"
              enabled={state.controls.plannerEnabled}
              onToggle={(value) =>
                act("controls.set", { key: "plannerEnabled", value })
              }
              busy={busy}
            />
            <FlagToggle
              label="Messaging"
              enabled={state.controls.messagingEnabled}
              onToggle={(value) =>
                act("controls.set", { key: "messagingEnabled", value })
              }
              busy={busy}
            />
            <FlagToggle
              label="Wallet Auto Refresh"
              enabled={state.controls.walletAutoRefreshEnabled}
              onToggle={(value) =>
                act("controls.set", {
                  key: "walletAutoRefreshEnabled",
                  value,
                })
              }
              busy={busy}
            />
          </div>

          <div className="rounded-2xl bg-black/35 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-white/60">Channels</div>
            <div className="grid grid-cols-2 gap-2">
              <ChannelBadge label="Telegram" on={state.controls.messagingEnabled} />
              <ChannelBadge label="Twitter / X" on={state.controls.messagingEnabled} />
            </div>
          </div>

          <div className="rounded-2xl bg-black/30 p-3 text-xs text-white/70">
            <div>
              Wallet Provisioning:{" "}
              {state.walletProvisioning.status === "provisioned_existing"
                ? "existing wallet configured"
                : "needs setup"}
            </div>
            <div className="mt-1 break-all">
              {state.walletProvisioning.address || "No MORK_WALLET configured yet."}
            </div>
          </div>

          <button
            onClick={refreshWalletMemory}
            disabled={busy}
            className="w-full rounded-xl border border-cyan-300/30 bg-cyan-200/10 px-3 py-2"
          >
            Refresh Wallet Memory
          </button>

          {statusText ? <p className="text-xs text-white/60">{statusText}</p> : null}
        </div>
      )}
    </div>
  );
}

function InfoLine({
  label,
  value,
  ok = false,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/60">{label}</span>
      <span className={ok ? "text-emerald-300" : "text-white"}>{value}</span>
    </div>
  );
}

function ChannelBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-2">
      <span>{label}</span>
      <span className={on ? "text-emerald-300" : "text-white/60"}>{on ? "ON" : "OFF"}</span>
    </div>
  );
}

function StatusRow({
  label,
  status,
  onStart,
  onStop,
  busy,
}: {
  label: string;
  status: RuntimeStatus;
  onStart: () => void;
  onStop: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-2xl bg-black/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span>{label}</span>
        <span className="text-white/60">{status}</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onStart}
          disabled={busy || status === "running"}
          className="rounded-lg border border-white/10 px-2 py-1"
        >
          Start
        </button>
        <button
          onClick={onStop}
          disabled={busy || status === "stopped"}
          className="rounded-lg border border-white/10 px-2 py-1"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function FlagToggle({
  label,
  enabled,
  onToggle,
  busy,
}: {
  label: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-black/30 px-3 py-2">
      <span>{label}</span>
      <button
        onClick={() => onToggle(!enabled)}
        disabled={busy}
        className="rounded-lg border border-white/10 px-2 py-1 text-xs"
      >
        {enabled ? "Enabled" : "Disabled"}
      </button>
    </div>
  );
}
