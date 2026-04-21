"use client";

import { DragEvent, useEffect, useMemo, useState } from "react";

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
  const [loadedSrc, setLoadedSrc] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [memes, setMemes] = useState<string[]>([]);
  const [nextMeme, setNextMeme] = useState("");

  const src = useMemo(() => normalizeUrl(rawUrl), [rawUrl]);
  const resolvedSrc = src || DEFAULT_GRADIO_URL;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (loadedSrc !== resolvedSrc) {
        setIframeError(`Sherpa did not load inside the frame from ${resolvedSrc}.`);
      }
    }, 5000);

    return () => window.clearTimeout(timeout);
  }, [loadedSrc, resolvedSrc]);

  useEffect(() => {
    void fetchMemes();
  }, []);

  async function fetchMemes() {
    try {
      const res = await fetch("/api/sherpa/memes");
      const data = (await res.json()) as { ok?: boolean; memes?: string[] };
      if (!res.ok || !data.ok) throw new Error("Unable to load memes");
      setMemes(data.memes ?? []);
    } catch {
      setUploadMessage("Could not load meme list. Upload still may work.");
    }
  }

  function saveUrl() {
    if (!src) return;
    setIframeError("");
    window.localStorage.setItem("mork.sherpa.gradio.url", src);
    setRawUrl(src);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  async function uploadFile(file: File) {
    const form = new FormData();
    form.set("file", file);

    const res = await fetch("/api/sherpa/memes", {
      method: "POST",
      body: form,
    });

    const data = (await res.json()) as { ok?: boolean; error?: string; fileName?: string };
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Upload failed for ${file.name}`);
    }

    return data.fileName || file.name;
  }

  async function handleFileList(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadMessage("");

    try {
      const names: string[] = [];
      for (const file of Array.from(fileList)) {
        names.push(await uploadFile(file));
      }
      setUploadMessage(`Uploaded ${names.length} meme${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
      await fetchMemes();
      if (!nextMeme && names[0]) setNextMeme(names[0]);
    } catch (error: unknown) {
      setUploadMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    void handleFileList(event.dataTransfer.files);
  }

  async function copyNextMemeHint() {
    if (!nextMeme) return;
    const prompt = `Use meme file: ${nextMeme}`;
    try {
      await navigator.clipboard.writeText(prompt);
      setUploadMessage(`Copied single-post meme hint: ${prompt}`);
    } catch {
      setUploadMessage(`Selected for next post: ${prompt}`);
    }
  }

  return (
    <div className="rounded-3xl border border-fuchsia-300/20 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Sherpa Gradio Control Deck</h2>

      <div className="mb-3 grid grid-cols-1 gap-2 rounded-2xl bg-black/35 p-3 text-xs md:grid-cols-[1fr_auto_auto]">
        <input
          value={rawUrl}
          onChange={(event) => {
            setIframeError("");
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
        src={resolvedSrc}
        title="Sherpa Gradio"
        className="h-[640px] w-full rounded-2xl border border-white/10 bg-black/30"
        onLoad={() => {
          setLoadedSrc(resolvedSrc);
          setIframeError("");
        }}
        onError={() => setIframeError(`Unable to reach Sherpa at ${resolvedSrc}.`)}
      />
      {loadedSrc !== resolvedSrc ? (
        <p className="mt-2 text-xs text-white/50">Waiting for frame response… if this persists, use “Open tab” to verify Sherpa is running.</p>
      ) : null}

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-3">
        <div className="mb-2 text-sm font-semibold">Meme Drop Zone</div>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`rounded-xl border border-dashed px-3 py-5 text-center text-xs transition ${
            dragActive ? "border-fuchsia-200/90 bg-fuchsia-200/10" : "border-white/30 bg-black/30"
          }`}
        >
          Drag and drop memes here to upload into <code>services/sherpa/memes</code>.
          <div className="mt-2">
            <label className="cursor-pointer rounded-lg border border-white/20 px-3 py-1.5 text-xs hover:bg-white/5">
              {uploading ? "Uploading…" : "Pick files"}
              <input
                type="file"
                accept="image/*,.gif,.webp"
                multiple
                className="hidden"
                disabled={uploading}
                onChange={(event) => void handleFileList(event.target.files)}
              />
            </label>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-[1fr_auto]">
          <select
            value={nextMeme}
            onChange={(event) => setNextMeme(event.target.value)}
            className="rounded-lg border border-white/10 bg-black/50 px-2 py-1.5"
          >
            <option value="">Select meme for a one-off post hint</option>
            {memes.map((meme) => (
              <option key={meme} value={meme}>
                {meme}
              </option>
            ))}
          </select>
          <button onClick={copyNextMemeHint} disabled={!nextMeme} className="rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-50">
            Copy single-post hint
          </button>
        </div>

        {uploadMessage ? <p className="mt-2 text-xs text-white/70">{uploadMessage}</p> : null}
      </div>
    </div>
  );
}
