"use client";

import { useCallback, useEffect, useState } from "react";

declare global {
  interface Window {
    Jupiter?: {
      init: (props: Record<string, unknown>) => void;
    };
  }
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const JUPITER_SCRIPT_SRC = "https://plugin.jup.ag/plugin-v1.js";

function ensureScriptLoaded() {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${JUPITER_SCRIPT_SRC}"]`);
  if (existing) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JUPITER_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load Jupiter plugin script."));
    document.body.appendChild(script);
  });
}

export default function JupiterPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");

  const initWidget = useCallback(async () => {
    setStatus("loading");
    setErrorText("");

    try {
      await ensureScriptLoaded();

      let attempts = 0;
      while (!window.Jupiter && attempts < 10) {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!window.Jupiter) {
        throw new Error("Jupiter widget script loaded but global object is unavailable.");
      }

      const target = document.getElementById("jupiter-plugin");
      if (!target) {
        throw new Error("Jupiter widget target container was not found.");
      }

      target.innerHTML = "";
      window.Jupiter.init({
        displayMode: "widget",
        integratedTargetId: "jupiter-plugin",
        formProps: {
          initialInputMint: SOL_MINT,
          initialOutputMint: BBQ_MINT,
        },
      });
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setErrorText(error instanceof Error ? error.message : "Unknown Jupiter widget initialization failure.");
    }
  }, []);

  useEffect(() => {
    initWidget().catch(() => {
      // handled in initWidget
    });
  }, [initWidget]);

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Jupiter Trade Window</h2>
      <p className="mb-3 text-xs text-white/60">Streamlined execution lane for SOL ⇄ BBQ with wallet-connected control.</p>
      {status === "loading" ? (
        <p className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-xs text-white/70">Loading Jupiter widget…</p>
      ) : null}
      {status === "error" ? (
        <div className="mb-3 rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div>{errorText || "Jupiter widget failed to initialize."}</div>
          <div className="mt-1 text-amber-50/90">
            Fallback: open{" "}
            <a className="underline" href="https://jup.ag/swap/SOL-BBQ" target="_blank" rel="noreferrer">
              jup.ag swap
            </a>{" "}
            and verify wallet adapter permissions.
          </div>
          <button onClick={() => initWidget()} className="mt-2 rounded-lg border border-amber-100/40 px-2 py-1 text-[11px] text-amber-50">
            Retry widget load
          </button>
        </div>
      ) : null}
      <div id="jupiter-plugin" className="min-h-[520px] rounded-2xl bg-black/30" />
    </div>
  );
}
