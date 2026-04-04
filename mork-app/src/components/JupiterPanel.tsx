"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    Jupiter?: {
      init: (props: Record<string, unknown>) => void;
    };
  }
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";

export default function JupiterPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tryInit = () => {
      if (cancelled) {
        return;
      }

      if (!window.Jupiter) {
        attempts += 1;
        if (attempts <= 10) {
          timer = setTimeout(tryInit, 500);
        } else {
          console.warn("Jupiter plugin script did not load in time");
          setStatus("error");
          setErrorText("Jupiter widget script did not load. Check ad-block/privacy extensions and network filtering.");
        }
        return;
      }

      const target = document.getElementById("jupiter-plugin");
      if (!target) {
        return;
      }

      target.innerHTML = "";
      try {
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
    };

    timer = setTimeout(tryInit, 200);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Jupiter Trade Window</h2>
      <p className="mb-3 text-xs text-white/60">Streamlined execution lane for SOL ⇄ BBQ with wallet-connected control.</p>
      {status === "loading" ? (
        <p className="mb-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-xs text-white/70">
          Loading Jupiter widget…
        </p>
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
        </div>
      ) : null}
      <div id="jupiter-plugin" className="min-h-[520px] rounded-2xl bg-black/30" />
    </div>
  );
}
