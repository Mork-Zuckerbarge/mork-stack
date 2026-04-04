"use client";

import { useEffect, useState } from "react";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
};

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [preflightWarning, setPreflightWarning] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "agent", content: "Mork is online. Say something." },
  ]);

  useEffect(() => {
    fetch("/api/preflight", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { checks?: Array<{ key: string; ok: boolean; message: string }> }) => {
        const failed = (data.checks || []).filter((check) =>
          check.key === "ollama_reachable" || check.key === "model_available"
        ).find((check) => !check.ok);
        setPreflightWarning(failed?.message || "");
      })
      .catch(() => setPreflightWarning("Unable to verify Ollama/model readiness."));
  }, []);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      const content =
        data.response ||
        data.reply ||
        data.message ||
        data.text ||
        (typeof data.error === "string" ? data.error : "") ||
        `Chat failed (${res.status})`;

      setMessages([...next, { role: "agent", content }]);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Something broke between thought and speech.";
      setMessages([
        ...next,
        {
          role: "agent",
          content: message,
        },
      ]);
    } finally {
      setLoading(false);
    }

  }

  return (
    <div className="rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-5">
      <h1 className="mb-1 text-2xl font-semibold">Vibecode Session</h1>
      <p className="mb-4 text-sm text-white/70">Fast iterations for app logic, prompts, and runbook-level commands.</p>
      {preflightWarning ? (
        <div className="mb-3 rounded-2xl border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Chat dependency warning: {preflightWarning}
        </div>
      ) : null}

      <div className="h-[60vh] overflow-y-auto rounded-2xl bg-black/30 p-4 space-y-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-2xl p-3 ${
              m.role === "user"
                ? "ml-auto bg-white text-black"
                : "border border-white/10 bg-zinc-900 text-white"
            }`}
          >
            {m.content}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {[
          "Ship a safer trade flow",
          "Draft Telegram CEO-style update",
          "Write cynical X thread",
        ].map((preset) => (
          <button
            key={preset}
            onClick={() => setInput(preset)}
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1"
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Ask Mork something..."
          className="flex-1 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 outline-none"
        />
        <button
          onClick={sendMessage}
          disabled={loading}
          className="rounded-2xl bg-white px-5 py-3 font-medium text-black disabled:opacity-50"
        >
          {loading ? "Thinking..." : "Send"}
        </button>
      </div>
    </div>
  );
}
