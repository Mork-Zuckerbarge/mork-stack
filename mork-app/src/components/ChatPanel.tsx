"use client";

import { useState } from "react";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
};

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "agent", content: "Mork is online. Say something." },
  ]);

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

      setMessages([
        ...next,
        {
          role: "agent",
          content:
            data.response ||
            data.reply ||
            data.error ||
            `Chat failed (${res.status})`,
        },
      ]);
    } catch (e: any) {
      setMessages([
        ...next,
        {
          role: "agent",
          content: e?.message || "Something broke between thought and speech.",
        },
      ]);
    } finally {
      setLoading(false);
    }

  }

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <h1 className="text-2xl font-semibold mb-4">Mork Console</h1>

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
