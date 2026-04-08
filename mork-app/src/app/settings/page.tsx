"use client";

import { useEffect, useState } from "react";

type Settings = {
  walletAddress: string;
  solanaRpc: string;
  telegramBotToken: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  ollamaHost: string;
  ollamaModel: string;
};

const emptySettings: Settings = {
  walletAddress: "",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  telegramBotToken: "",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
  ollamaHost: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2:3b",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setSettings({ ...emptySettings, ...data }))
      .catch(() => setStatus("Failed to load settings"));
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (!res.ok) throw new Error("Save failed");
      setStatus("Saved. Restart app services to apply to running Sherpa/Telegram processes.");
    } catch {
      setStatus("Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-black p-6 text-white">
      <div className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-white/5 p-6">
        <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

        <div className="grid grid-cols-1 gap-4">
          <Field label="Wallet Address" value={settings.walletAddress} onChange={(v) => update("walletAddress", v)} />
          <Field label="Solana RPC" value={settings.solanaRpc} onChange={(v) => update("solanaRpc", v)} />
          <Field label="Telegram Bot Token" value={settings.telegramBotToken} onChange={(v) => update("telegramBotToken", v)} secret />
          <Field label="ElevenLabs API Key" value={settings.elevenLabsApiKey} onChange={(v) => update("elevenLabsApiKey", v)} secret />
          <Field label="ElevenLabs Voice ID" value={settings.elevenLabsVoiceId} onChange={(v) => update("elevenLabsVoiceId", v)} />
          <Field label="Ollama Host" value={settings.ollamaHost} onChange={(v) => update("ollamaHost", v)} />
          <Field label="Ollama Model" value={settings.ollamaModel} onChange={(v) => update("ollamaModel", v)} />
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-2xl bg-white px-5 py-3 font-medium text-black disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
          <span className="text-sm text-white/70">{status}</span>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm text-white/70">{label}</div>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 outline-none"
      />
    </label>
  );
}
