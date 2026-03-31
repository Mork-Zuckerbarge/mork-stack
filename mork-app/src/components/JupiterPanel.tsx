"use client";

import { useEffect } from "react";

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
  useEffect(() => {
    const tryInit = () => {
      if (!window.Jupiter) {
        console.log("Jupiter not loaded yet");
        return;
      }

      window.Jupiter.init({
        displayMode: "widget",
        integratedTargetId: "jupiter-plugin",
        formProps: {
          initialInputMint: SOL_MINT,
          initialOutputMint: BBQ_MINT,
        },
      });
    };

    const t = setTimeout(tryInit, 800);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <h2 className="mb-1 text-lg font-semibold">Jupiter Trade Window</h2>
      <p className="mb-3 text-xs text-white/60">Streamlined execution lane for SOL ⇄ BBQ with wallet-connected control.</p>
      <div id="jupiter-plugin" className="min-h-[520px] rounded-2xl bg-black/30" />
    </div>
  );
}
