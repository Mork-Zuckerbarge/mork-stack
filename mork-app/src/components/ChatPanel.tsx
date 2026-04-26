"use client";

import { useEffect, useState } from "react";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
  media?: {
    kind: "image" | "video";
    url: string;
    filename: string;
    provider?: string;
    prompt?: string;
  };
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch("/api/chat/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, maxChars: 1600 }),
        signal: controller.signal,
      });

      const data = await res.json();

      const content =
        data.response ||
        data.reply ||
        data.message ||
        data.text ||
        (typeof data.error === "string" ? data.error : "") ||
        `Chat failed (${res.status})`;

      setMessages([
        ...next,
        {
          role: "agent",
          content,
          media:
            data?.media && typeof data.media?.url === "string" && typeof data.media?.filename === "string"
              ? {
                  kind: data.media.kind === "video" ? "video" : "image",
                  url: data.media.url,
                  filename: data.media.filename,
                  provider: data.media.provider,
                  prompt: data.media.prompt,
                }
              : undefined,
        },
      ]);
    } catch (e: unknown) {
      const message =
        e instanceof DOMException && e.name === "AbortError"
          ? "Chat request timed out after 120s. Model is overloaded; try a shorter prompt or raise OLLAMA_TIMEOUT_MS."
          : e instanceof Error
          ? e.message
          : "Something broke between thought and speech.";
      setMessages([
        ...next,
        {
          role: "agent",
          content: message,
        },
      ]);
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }

  }

  return (
    <div className="rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-5">
      <h1 className="mb-4 text-2xl font-semibold">TERMINAL</h1>
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
            <div>{m.content}</div>
            {m.media ? (
              <div className="mt-3 space-y-2">
                {m.media.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.media.url} alt={m.media.prompt || m.media.filename} className="max-h-80 rounded-xl border border-white/10" />
                ) : (
                  <video src={m.media.url} controls className="max-h-80 rounded-xl border border-white/10" />
                )}
                <div className="flex flex-wrap gap-2 text-xs">
                  <a
                    className="rounded-full border border-white/20 bg-white/5 px-3 py-1"
                    href={m.media.url}
                    download={m.media.filename}
                  >
                    Download
                  </a>
                  <button
                    onClick={() =>
                      setInput(
                        `send ${m.media?.filename} to telegram with caption: ${m.media?.prompt || "Generated in Mork"}`
                      )
                    }
                    className="rounded-full border border-white/20 bg-white/5 px-3 py-1"
                  >
                    Send to Telegram
                  </button>
                  <button
                    onClick={() =>
                      setInput(`load ${m.media?.filename} to sherpa with caption: ${m.media?.prompt || "Generated in Mork"}`)
                    }
                    className="rounded-full border border-white/20 bg-white/5 px-3 py-1"
                  >
                    Load to Sherpa
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {[
          { label: "show services", value: "show services" },
          { label: "start arb", value: "start arb" },
          { label: "stop sherpa", value: "stop sherpa" },
          { label: "telegram:", value: "post to telegram:" },
          { label: "generate image:", value: "generate image:" },
          { label: "generate video:", value: "generate video:" },
          { label: "buy:", value: "buy:" },
        ].map((preset) => (
          <button
            key={preset.label}
            onClick={() => setInput(preset.value)}
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Try: post to telegram: ... | generate image: ... | generate video ... | send <file> to telegram with caption: ..."
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
      <p className="mt-2 text-xs text-white/55">
        Chat waits longer for model replies now. If responses still time out, raise <code>OLLAMA_TIMEOUT_MS</code> in{" "}
        <code>mork-app/.env.local</code> and restart.
      </p>
    </div>
  );
}
