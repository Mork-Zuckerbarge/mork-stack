"use client";

import { useEffect, useState } from "react";

type RuntimeStatus = "running" | "stopped";
type ExecutionMode = "user_only" | "agent_assisted" | "emergency_stop";

type AppControlState = {
  arb: { status: RuntimeStatus; updatedAt: string };
  sherpa: { status: RuntimeStatus; updatedAt: string };
  controls: {
    memoryEnabled: boolean;
    plannerEnabled: boolean;
    telegramEnabled: boolean;
    xEnabled: boolean;
    walletAutoRefreshEnabled: boolean;
    appPersonaMode: string;
    telegramPersonaMode: string;
    xPersonaMode: string;
    appPersonaGuidelines: string;
    telegramPersonaGuidelines: string;
    xPersonaGuidelines: string;
    selectedOllamaModel: string;
    startupCompleted: boolean;
    executionAuthority: {
      mode: ExecutionMode;
      maxTradeUsd: number;
      mintAllowlist: string[];
      cooldownMinutes: number;
    };
  };
  walletProvisioning: {
    status: "provisioned_existing" | "needs_setup";
    address: string | null;
  };
};

const modelCatalog = [
  { value: "llama3.2:3b", label: "Llama 3.2 3B", description: "Fast, lightweight default for local assistant chats." },
  { value: "llama3.1:8b", label: "Llama 3.1 8B", description: "Balanced quality and speed for planning and coding." },
  { value: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", description: "Better for code generation and refactors." },
  { value: "mistral:7b", label: "Mistral 7B", description: "General purpose, concise responses." },
];

const personaModes = {
  app: ["code-first", "operator", "teacher"],
  telegram: ["ceo-helpful", "supportive", "briefing"],
  x: ["cynical-banter", "poetic", "market-snark"],
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
      <p className="mb-3 text-xs text-white/60">One surface for models, personas, channels, and execution authority.</p>

      {!state ? (
        <p className="text-sm text-white/60">Unable to load app controls.</p>
      ) : (
        <div className="space-y-4 text-sm">
          {!state.controls.startupCompleted ? (
            <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              First startup setup is incomplete. Select a model and persona defaults, then click <strong>Complete First-Time Setup</strong>.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-2 rounded-2xl bg-black/35 p-3">
            <InfoLine label="Status" value="ONLINE" ok />
            <InfoLine label="Model" value={state.controls.selectedOllamaModel} />
            <InfoLine
              label="Memory"
              value={state.controls.memoryEnabled ? "Active" : "Paused"}
              ok={state.controls.memoryEnabled}
            />
          </div>

          <div className="rounded-2xl bg-black/35 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-white/60">First-Time Agent Setup</div>
            <label className="mb-2 block text-xs text-white/70">Ollama model selection</label>
            <select
              value={state.controls.selectedOllamaModel}
              onChange={(e) => act("ollama.model.set", { model: e.target.value })}
              disabled={busy}
              className="mb-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2"
            >
              {modelCatalog.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
            <div className="space-y-1 text-xs text-white/65">
              {modelCatalog.map((model) => (
                <div key={model.value}>
                  <span className="font-medium text-white/80">{model.label}:</span> {model.description}
                </div>
              ))}
            </div>
            <button
              onClick={() => act("startup.completed.set", { value: true })}
              disabled={busy}
              className="mt-3 w-full rounded-xl border border-white/10 px-3 py-2"
            >
              Complete First-Time Setup
            </button>
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
            <FlagToggle label="Memory" enabled={state.controls.memoryEnabled} onToggle={(value) => act("controls.set", { key: "memoryEnabled", value })} busy={busy} />
            <FlagToggle label="Planner" enabled={state.controls.plannerEnabled} onToggle={(value) => act("controls.set", { key: "plannerEnabled", value })} busy={busy} />
            <FlagToggle label="Wallet Auto Refresh" enabled={state.controls.walletAutoRefreshEnabled} onToggle={(value) => act("controls.set", { key: "walletAutoRefreshEnabled", value })} busy={busy} />
          </div>

          <div className="rounded-2xl bg-black/35 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-white/60">Channel-level Controls</div>
            <FlagToggle label="Telegram Enabled" enabled={state.controls.telegramEnabled} onToggle={(value) => act("controls.set", { key: "telegramEnabled", value })} busy={busy} />
            <FlagToggle label="X Enabled" enabled={state.controls.xEnabled} onToggle={(value) => act("controls.set", { key: "xEnabled", value })} busy={busy} />
            <PersonaEditor
              key={`app-${state.controls.appPersonaMode}-${state.controls.appPersonaGuidelines}`}
              title="App Persona"
              mode={state.controls.appPersonaMode}
              modeOptions={personaModes.app}
              guidelines={state.controls.appPersonaGuidelines}
              busy={busy}
              onModeChange={(mode) => act("persona.mode.set", { channel: "app", mode })}
              onGuidelinesSave={(guidelines) => act("persona.guidelines.set", { channel: "app", guidelines })}
            />
            <PersonaEditor
              key={`telegram-${state.controls.telegramPersonaMode}-${state.controls.telegramPersonaGuidelines}`}
              title="Telegram Persona"
              mode={state.controls.telegramPersonaMode}
              modeOptions={personaModes.telegram}
              guidelines={state.controls.telegramPersonaGuidelines}
              busy={busy}
              onModeChange={(mode) => act("persona.mode.set", { channel: "telegram", mode })}
              onGuidelinesSave={(guidelines) => act("persona.guidelines.set", { channel: "telegram", guidelines })}
            />
            <PersonaEditor
              key={`x-${state.controls.xPersonaMode}-${state.controls.xPersonaGuidelines}`}
              title="X Persona"
              mode={state.controls.xPersonaMode}
              modeOptions={personaModes.x}
              guidelines={state.controls.xPersonaGuidelines}
              busy={busy}
              onModeChange={(mode) => act("persona.mode.set", { channel: "x", mode })}
              onGuidelinesSave={(guidelines) => act("persona.guidelines.set", { channel: "x", guidelines })}
            />
          </div>

          <ExecutionAuthorityEditor
            key={JSON.stringify(state.controls.executionAuthority)}
            state={state}
            busy={busy}
            onSave={({ mode, maxTradeUsd, cooldownMinutes, mintAllowlist }) =>
              act("execution.authority.set", { mode, maxTradeUsd, cooldownMinutes, mintAllowlist })
            }
          />

          <div className="rounded-2xl bg-black/30 p-3 text-xs text-white/70">
            <div>
              Wallet Provisioning: {" "}
              {state.walletProvisioning.status === "provisioned_existing"
                ? "existing wallet configured"
                : "needs setup"}
            </div>
            <div className="mt-1 break-all">{state.walletProvisioning.address || "No MORK_WALLET configured yet."}</div>
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

function PersonaEditor({
  title,
  mode,
  modeOptions,
  guidelines,
  busy,
  onModeChange,
  onGuidelinesSave,
}: {
  title: string;
  mode: string;
  modeOptions: string[];
  guidelines: string;
  busy: boolean;
  onModeChange: (mode: string) => void;
  onGuidelinesSave: (guidelines: string) => void;
}) {
  const [draft, setDraft] = useState(guidelines);

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="mb-1 text-xs text-white/70">{title}</div>
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        disabled={busy}
        className="mb-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1"
      >
        {modeOptions.map((item) => (
          <option key={item} value={item}>{item}</option>
        ))}
      </select>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Tone + guideline instructions"
        rows={3}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs"
      />
      <button
        onClick={() => onGuidelinesSave(draft)}
        disabled={busy}
        className="mt-2 rounded-lg border border-white/10 px-2 py-1 text-xs"
      >
        Save guidelines
      </button>
    </div>
  );
}

function ExecutionAuthorityEditor({
  state,
  busy,
  onSave,
}: {
  state: AppControlState;
  busy: boolean;
  onSave: (input: {
    mode: ExecutionMode;
    maxTradeUsd: number;
    cooldownMinutes: number;
    mintAllowlist: string[];
  }) => void;
}) {
  const [mode, setMode] = useState<ExecutionMode>(state.controls.executionAuthority.mode);
  const [maxTradeUsd, setMaxTradeUsd] = useState(String(state.controls.executionAuthority.maxTradeUsd));
  const [cooldownMinutes, setCooldownMinutes] = useState(String(state.controls.executionAuthority.cooldownMinutes));
  const [allowlist, setAllowlist] = useState(state.controls.executionAuthority.mintAllowlist.join(","));

  return (
    <div className="rounded-2xl bg-black/35 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-white/60">Execution Authority (Wallet)</div>
      <div className="grid grid-cols-1 gap-2">
        <label className="text-xs text-white/70">Mode</label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ExecutionMode)}
          className="rounded-lg border border-white/10 bg-black/40 px-2 py-1"
        >
          <option value="user_only">User-only mode</option>
          <option value="agent_assisted">Agent-assisted mode</option>
          <option value="emergency_stop">Emergency stop</option>
        </select>
        <label className="text-xs text-white/70">Max trade (USD)</label>
        <input value={maxTradeUsd} onChange={(e) => setMaxTradeUsd(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
        <label className="text-xs text-white/70">Mint allowlist (comma separated)</label>
        <input value={allowlist} onChange={(e) => setAllowlist(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
        <label className="text-xs text-white/70">Cooldown (minutes)</label>
        <input value={cooldownMinutes} onChange={(e) => setCooldownMinutes(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
        <button
          onClick={() =>
            onSave({
              mode,
              maxTradeUsd: Number(maxTradeUsd) || 0,
              cooldownMinutes: Number(cooldownMinutes) || 0,
              mintAllowlist: allowlist.split(",").map((item) => item.trim()).filter(Boolean),
            })
          }
          disabled={busy}
          className="rounded-lg border border-white/10 px-2 py-1"
        >
          Save execution policy
        </button>
      </div>
    </div>
  );
}

function InfoLine({ label, value, ok = false }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/60">{label}</span>
      <span className={ok ? "text-emerald-300" : "text-white"}>{value}</span>
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
        <button onClick={onStart} disabled={busy || status === "running"} className="rounded-lg border border-white/10 px-2 py-1">Start</button>
        <button onClick={onStop} disabled={busy || status === "stopped"} className="rounded-lg border border-white/10 px-2 py-1">Stop</button>
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
      <button onClick={() => onToggle(!enabled)} disabled={busy} className="rounded-lg border border-white/10 px-2 py-1 text-xs">
        {enabled ? "Enabled" : "Disabled"}
      </button>
    </div>
  );
}
