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
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <h2 className="mb-3 text-lg font-semibold">Trade</h2>
      <div id="jupiter-plugin" className="min-h-[520px] rounded-2xl bg-black/30" />
    </div>
  );
}
