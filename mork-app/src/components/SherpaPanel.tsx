"use client";

import { useMemo, useState } from "react";

const DEFAULT_GRADIO_URL = process.env.NEXT_PUBLIC_SHERPA_GRADIO_URL || "http://127.0.0.1:7860";

function normalizeUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export default function SherpaPanel() {
  const [rawUrl, setRawUrl] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_GRADIO_URL;
    return window.localStorage.getItem("mork.sherpa.gradio.url") || DEFAULT_GRADIO_URL;
  });
  const [saved, setSaved] = useState(false);
  const [iframeError, setIframeError] = useState("");
  const src = useMemo(() => normalizeUrl(rawUrl), [rawUrl]);

  function saveUrl() {
    if (!src) return;
    setIframeError("");
    window.localStorage.setItem("mork.sherpa.gradio.url", src);
    setRawUrl(src);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Sherpa Gradio Control Deck</h2>
      <p className="mb-3 text-xs text-white/60">Embed the full Sherpa control surface so scheduler and posting knobs stay in one panel.</p>

      <div className="mb-3 grid grid-cols-1 gap-2 rounded-2xl bg-black/35 p-3 text-xs md:grid-cols-[1fr_auto_auto]">
        <input
          value={rawUrl}
          onChange={(event) => setRawUrl(event.target.value)}
          placeholder="http://127.0.0.1:7860"
          className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-sm"
        />
        <button onClick={saveUrl} className="rounded-lg border border-white/10 px-3 py-1.5">
          {saved ? "Saved" : "Save"}
        </button>
        <a href={src || DEFAULT_GRADIO_URL} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 px-3 py-1.5 text-center">
          Open tab
        </a>
      </div>
      {iframeError ? (
        <div className="mb-3 rounded-xl border border-fuchsia-300/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-100">
          <div>{iframeError}</div>
          <div className="mt-1 text-fuchsia-50/90">
            Use the repo-root <code>./start.sh</code> flow first, then point this panel to the Sherpa host:port if you run Sherpa externally.
          </div>
        </div>
      ) : null}

      <iframe
        key={src}
        src={src || DEFAULT_GRADIO_URL}
        title="Sherpa Gradio"
        className="h-[640px] w-full rounded-2xl border border-white/10 bg-black/30"
        onError={() => setIframeError(`Unable to reach Sherpa at ${src || DEFAULT_GRADIO_URL}.`)}
      />
    </div>
  );
}
