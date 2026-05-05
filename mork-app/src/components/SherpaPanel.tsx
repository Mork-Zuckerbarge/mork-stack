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
  const [loadedSrc, setLoadedSrc] = useState("");

  const src = useMemo(() => normalizeUrl(rawUrl), [rawUrl]);
  const resolvedSrc = src || DEFAULT_GRADIO_URL;

  function saveUrl() {
    if (!src) return;
    window.localStorage.setItem("mork.sherpa.gradio.url", src);
    setRawUrl(src);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Sherpa Gradio Control Deck</h2>
        <div className="grid flex-1 grid-cols-[minmax(220px,1fr)_auto_auto] gap-2 rounded-2xl bg-black/35 p-2 text-xs">
          <input
            value={rawUrl}
            onChange={(event) => {
              setRawUrl(event.target.value);
            }}
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
      </div>

      <iframe
        key={src}
        src={resolvedSrc}
        title="Sherpa Gradio"
        className="h-[640px] w-full rounded-2xl border border-white/10 bg-black/30"
        onLoad={() => {
          setLoadedSrc(resolvedSrc);
        }}
      />
      {loadedSrc !== resolvedSrc ? (
        <p className="mt-2 text-xs text-white/50">Waiting for frame response… if this persists, use “Open tab” to verify Sherpa is running.</p>
      ) : null}
    </div>
  );
}
