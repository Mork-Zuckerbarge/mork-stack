"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import ArbLogFeed from "@/components/ArbLogFeed";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const tokenLogos: Record<string, string> = {
  [SOL_MINT]: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
};

type TokenOption = {
  symbol: string;
  mint: string;
  name?: string;
  logoUri?: string;
};

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

type SwapResponse = {
  ok: boolean;
  signature?: string;
  error?: string;
  wallet?: string;
  amountIn?: number;
  inputMint?: string;
  outputMint?: string;
};

type WalletState = {
  address: string | null;
  sol: number;
  bbq: number;
  usdc: number;
  requirementMet: boolean;
};

type QuoteResponse = {
  ok: boolean;
  inAmount?: number;
  outAmount?: number;
  otherAmountThreshold?: number;
  priceImpactPct?: string;
  routeFeeAmount?: number;
  routeFeeSymbol?: string;
  error?: string;
};

type BalanceResponse = {
  ok: boolean;
  balances?: Record<string, number>;
  error?: string;
};

type ExecutionMode = "user_only" | "agent_assisted" | "emergency_stop";

type ExecutionAuthority = {
  mode: ExecutionMode;
  maxTradeUsd: number;
  mintAllowlist: string[];
  cooldownMinutes: number;
};

type RuntimeStatus = "running" | "stopped";
type ActivePanel = "arb" | "trade";

type PoolWatchMode = "all_available";
type RouteMode = "jupiter" | "direct";
type StrategyEngines = {
  poolImbalance: {
    minImbalancePct: number;
    poolsWatched: PoolWatchMode;
    useJitoBundle: boolean;
  };
  crossDexArb: {
    minNetProfitSol: number;
    routeVia: RouteMode;
    enableTriangularRoutes: boolean;
  };
  momentumRunner: {
    entryVolSpikeMultiplier: number;
    exitTrailingStopPct: number;
    maxHoldMinutes: number;
    hardStopLossPct: number;
    watchPumpFunLaunches: boolean;
    useBirdeyeTrendingFeed: boolean;
  };
};

function formatTokenAmount(value: number | undefined, maxFractionDigits = 9): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

function formatPriceImpact(value: string | undefined): string {
  const parsed = Number(value ?? "0");
  if (!Number.isFinite(parsed)) return "0.000";
  return (parsed * 100).toFixed(3);
}

function TokenLogo({ mint, symbol, logoUri }: { mint: string; symbol: string; logoUri?: string }) {
  const src = logoUri || tokenLogos[mint] || "/globe.svg";

  return (
    <Image
      src={src}
      alt={`${symbol} logo`}
      width={24}
      height={24}
      className="h-6 w-6 rounded-full border border-white/20 bg-black/40 object-cover"
      unoptimized
    />
  );
}

function Sparkline({ seed }: { seed: string }) {
  const points = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    const values = Array.from({ length: 20 }).map((_, index) => {
      const wave = Math.sin((index + 1) * 0.55 + Math.abs(hash % 13));
      const jitter = Math.cos((index + 1) * 0.33 + Math.abs(hash % 9)) * 0.25;
      return Math.max(2, Math.min(22, 12 + wave * 7 + jitter * 6));
    });
    return values.map((value, index) => `${index * 8},${24 - value}`).join(" ");
  }, [seed]);

  return (
    <svg viewBox="0 0 152 24" className="h-8 w-full">
      <polyline points={points} fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function JupiterPanel() {
  const [amountSol, setAmountSol] = useState("0.05");
  const [slippageBps, setSlippageBps] = useState(50);
  const [busy, setBusy] = useState(false);
  const [inputSearch, setInputSearch] = useState("SOL");
  const [outputSearch, setOutputSearch] = useState("");
  const [selectedInputMint, setSelectedInputMint] = useState(SOL_MINT);
  const [selectedOutputMint, setSelectedOutputMint] = useState("");
  const [inputTokenResults, setInputTokenResults] = useState<TokenOption[]>([]);
  const [outputTokenResults, setOutputTokenResults] = useState<TokenOption[]>([]);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [pairBalances, setPairBalances] = useState<Record<string, number>>({});
  const [pairBalancesLoading, setPairBalancesLoading] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });
  const [execution, setExecution] = useState<ExecutionAuthority | null>(null);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionStatus, setExecutionStatus] = useState("");
  const [walletRefreshBusy, setWalletRefreshBusy] = useState(false);
  const [arbStatus, setArbStatus] = useState<RuntimeStatus>("stopped");
  const [panelRefreshBusy, setPanelRefreshBusy] = useState(false);
  const [panelRefreshStatus, setPanelRefreshStatus] = useState("");
  const [strategyEngines, setStrategyEngines] = useState<StrategyEngines | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>("trade");

  const selectedInputToken = useMemo(
    () => inputTokenResults.find((token) => token.mint === selectedInputMint) ?? { symbol: shortMint(selectedInputMint), mint: selectedInputMint },
    [inputTokenResults, selectedInputMint],
  );
  const selectedOutputToken = useMemo(
    () =>
      outputTokenResults.find((token) => token.mint === selectedOutputMint) ??
      (selectedOutputMint ? { symbol: shortMint(selectedOutputMint), mint: selectedOutputMint } : null),
    [outputTokenResults, selectedOutputMint],
  );

  const parsedAmountSol = Number(amountSol);
  const hasValidPair = Boolean(selectedInputMint && selectedOutputMint && selectedInputMint !== selectedOutputMint);
  const selectedPairLabel = selectedOutputToken
    ? `${selectedInputToken.symbol} → ${selectedOutputToken.symbol}`
    : `${selectedInputToken.symbol} → Select token`;
  const amountOut = quote?.ok ? quote.outAmount ?? 0 : 0;
  const rate = quote?.ok && amountOut > 0 && parsedAmountSol > 0 ? amountOut / parsedAmountSol : 0;
  const showInputTokenOptions =
    inputTokenResults.length > 1 || (inputTokenResults.length === 1 && inputTokenResults[0].mint !== selectedInputMint);
  const showOutputTokenOptions =
    outputTokenResults.length > 1 || (outputTokenResults.length === 1 && outputTokenResults[0].mint !== selectedOutputMint);
  const tradePaused = activePanel !== "trade";
  const swapBlocked = arbStatus === "running" || activePanel !== "trade";
  const arbPaused = activePanel !== "arb";

  const fetchTokenOptions = useCallback(async (query: string): Promise<TokenOption[]> => {
    const q = query.trim();
    if (!q) {
      return [{ symbol: "SOL", mint: SOL_MINT }];
    }

    try {
      const res = await fetch(`/api/trade/tokens?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; tokens?: TokenOption[] };
      const fromApi = res.ok && data.ok ? data.tokens ?? [] : [];
      return fromApi;
    } catch {
      return [];
    }
  }, []);

  const findBestToken = useCallback((query: string, options: TokenOption[]): TokenOption | null => {
    if (!options.length) return null;
    const q = query.trim().toLowerCase();
    return options.find((option) => option.symbol.toLowerCase() === q) ?? options[0];
  }, []);

  const searchTokens = useCallback(async (query: string, side: "input" | "output") => {
    const results = await fetchTokenOptions(query);
    if (side === "input") {
      setInputTokenResults(results);
    } else {
      setOutputTokenResults(results);
    }
  }, [fetchTokenOptions]);

  const applyPairSearch = useCallback(async (query: string) => {
    const parts = query
      .split(/(?:\/|->|\bto\b|\s+)/i)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      return;
    }

    const [inputQuery, outputQuery] = parts;
    const [inputOptions, outputOptions] = await Promise.all([
      fetchTokenOptions(inputQuery),
      fetchTokenOptions(outputQuery),
    ]);
    const bestInput = findBestToken(inputQuery, inputOptions);
    const bestOutput = findBestToken(outputQuery, outputOptions);

    if (!bestInput || !bestOutput || bestInput.mint === bestOutput.mint) {
      return;
    }

    setInputSearch(bestInput.symbol);
    setOutputSearch(bestOutput.symbol);
    setInputTokenResults(inputOptions);
    setOutputTokenResults(outputOptions);
    setSelectedInputMint(bestInput.mint);
    setSelectedOutputMint(bestOutput.mint);
  }, [fetchTokenOptions, findBestToken]);

  function setSellAmountByPercent(percent: number) {
    const inputBalance = pairBalances[selectedInputMint] ?? 0;
    if (inputBalance <= 0) return;
    setAmountSol((inputBalance * percent).toFixed(4));
  }

  const loadWallet = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/state", { cache: "no-store" });
      const data = (await res.json()) as { wallet?: WalletState };
      setWallet(data.wallet ?? null);
    } catch {
      setWallet(null);
    }
  }, []);

  const loadExecution = useCallback(async () => {
    try {
      const res = await fetch("/api/app/control", { cache: "no-store" });
      const data = (await res.json()) as {
        ok?: boolean;
        state?: {
          arb?: { status?: RuntimeStatus };
          controls?: {
            executionAuthority?: ExecutionAuthority;
            startupCompleted?: boolean;
            activePanel?: ActivePanel;
            strategyEngines?: StrategyEngines;
          };
        };
      };
      if (!res.ok || !data.ok || !data.state?.controls?.executionAuthority) {
        setExecution(null);
        setArbStatus("stopped");
        return;
      }
      setExecution(data.state.controls.executionAuthority);
      setArbStatus(data.state.arb?.status === "running" ? "running" : "stopped");
      setActivePanel(data.state.controls.activePanel === "arb" ? "arb" : "trade");
      setStrategyEngines(data.state.controls.strategyEngines ?? null);
    } catch {
      setExecution(null);
      setArbStatus("stopped");
      setActivePanel("trade");
      setStrategyEngines(null);
    }
  }, []);

  const refreshWalletMemory = useCallback(async () => {
    if (walletRefreshBusy) return;
    setWalletRefreshBusy(true);
    try {
      const res = await fetch("/api/wallet/refresh", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
      } else {
        void loadExecution();
      }
    } catch {
    } finally {
      setWalletRefreshBusy(false);
    }
  }, [loadExecution, walletRefreshBusy]);

  async function saveExecution(nextExecution: ExecutionAuthority) {
    setExecutionBusy(true);
    setExecutionStatus("");
    try {
      const res = await fetch("/api/app/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execution.authority.set",
          ...nextExecution,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        state?: { controls?: { executionAuthority?: ExecutionAuthority } };
        error?: string;
      };
      if (!res.ok || !data.ok || !data.state?.controls?.executionAuthority) {
        setExecutionStatus(data.error || `Save failed (${res.status})`);
        return;
      }
      setExecution(data.state.controls.executionAuthority);
      setExecutionStatus("Execution policy updated");
    } catch {
      setExecutionStatus("Unable to save execution policy");
    } finally {
      setExecutionBusy(false);
    }
  }

  async function saveStrategyEngines(next: StrategyEngines) {
    setExecutionBusy(true);
    setExecutionStatus("");
    try {
      const res = await fetch("/api/app/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "strategy.engines.set",
          strategyEngines: next,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        state?: { controls?: { strategyEngines?: StrategyEngines } };
        error?: string;
      };
      if (!res.ok || !data.ok || !data.state?.controls?.strategyEngines) {
        setExecutionStatus(data.error || `Save failed (${res.status})`);
        return;
      }
      setStrategyEngines(data.state.controls.strategyEngines);
      setExecutionStatus("Strategy controls updated");
    } catch {
      setExecutionStatus("Save failed");
    } finally {
      setExecutionBusy(false);
    }
  }

  const loadQuote = useCallback(async () => {
    if (tradePaused) {
      setQuote(null);
      return;
    }
    if (!Number.isFinite(parsedAmountSol) || parsedAmountSol <= 0 || !hasValidPair) {
      setQuote(null);
      return;
    }
    try {
      const res = await fetch("/api/trade/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountSol: parsedAmountSol,
          inputMint: selectedInputMint,
          outputMint: selectedOutputMint,
          slippageBps,
        }),
      });
      const data = (await res.json()) as QuoteResponse;
      setQuote(res.ok && data.ok ? data : { ok: false, error: data.error || `Quote failed (${res.status})` });
    } catch {
      setQuote({ ok: false, error: "Quote unavailable" });
    }
  }, [hasValidPair, parsedAmountSol, selectedInputMint, selectedOutputMint, slippageBps, tradePaused]);

  const loadPairBalances = useCallback(async () => {
    if (tradePaused) {
      setPairBalances({});
      return;
    }
    if (!hasValidPair) {
      setPairBalances({});
      return;
    }

    setPairBalancesLoading(true);
    try {
      const res = await fetch("/api/trade/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mints: [selectedInputMint, selectedOutputMint] }),
      });
      const data = (await res.json()) as BalanceResponse;
      if (!res.ok || !data.ok || !data.balances) {
        setPairBalances({});
        return;
      }
      setPairBalances(data.balances);
    } catch {
      setPairBalances({});
    } finally {
      setPairBalancesLoading(false);
    }
  }, [hasValidPair, selectedInputMint, selectedOutputMint, tradePaused]);

  const refreshWalletControlPanel = useCallback(async () => {
    if (panelRefreshBusy) return;
    setPanelRefreshBusy(true);
    setPanelRefreshStatus("");
    try {
      await Promise.all([
        loadWallet(),
        loadExecution(),
        loadPairBalances(),
        loadQuote(),
      ]);
      await refreshWalletMemory();
      setPanelRefreshStatus("Wallet control refreshed");
    } catch {
      setPanelRefreshStatus("Wallet control refresh failed");
    } finally {
      setPanelRefreshBusy(false);
    }
  }, [loadExecution, loadPairBalances, loadQuote, loadWallet, panelRefreshBusy, refreshWalletMemory]);

  const onSetActivePanel = useCallback(async (nextPanel: ActivePanel) => {
    try {
      const res = await fetch("/api/app/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "runtime.panel.set", panel: nextPanel }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        state?: { controls?: { activePanel?: ActivePanel } };
      };
      if (res.ok && data.ok) {
        setActivePanel(data.state?.controls?.activePanel === "arb" ? "arb" : "trade");
        return;
      }
    } catch {
      // fall through to refresh fallback
    }
    void loadExecution();
  }, [loadExecution]);

  useEffect(() => {
    void loadWallet();
    void loadExecution();
  }, [loadExecution, loadWallet]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadQuote();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadQuote]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (inputSearch.includes("/") || inputSearch.includes("->") || /\bto\b/i.test(inputSearch)) {
        void applyPairSearch(inputSearch);
        return;
      }
      void searchTokens(inputSearch, "input");
    }, 200);
    return () => window.clearTimeout(timer);
  }, [applyPairSearch, inputSearch, searchTokens]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (outputSearch.includes("/") || outputSearch.includes("->") || /\bto\b/i.test(outputSearch)) {
        void applyPairSearch(outputSearch);
        return;
      }
      void searchTokens(outputSearch, "output");
    }, 200);
    return () => window.clearTimeout(timer);
  }, [applyPairSearch, outputSearch, searchTokens]);

  useEffect(() => {
    void loadPairBalances();
  }, [loadPairBalances]);

  async function submitDirectSwap() {
    if (swapBlocked) {
      setStatus({
        kind: "error",
        text: "Swap is blocked while automation is running or panel is not set to Trade.",
      });
      return;
    }
    if (!hasValidPair) {
      setStatus({
        kind: "error",
        text: "Select different input/output tokens before swapping.",
      });
      return;
    }

    setBusy(true);
    setStatus({ kind: "idle", text: "" });

    try {
      const amount = Number(amountSol);
      const res = await fetch("/api/trade/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountIn: amount,
          slippageBps,
          inputMint: selectedInputMint,
          outputMint: selectedOutputMint,
        }),
      });

      const data = (await res.json()) as SwapResponse;
      if (!res.ok || !data.ok) {
        setStatus({ kind: "error", text: data.error || `Swap failed (${res.status})` });
        return;
      }

      setStatus({
        kind: "ok",
        text: `Swap sent from ${data.wallet || "agent wallet"}. Signature: ${data.signature}`,
      });
      void loadWallet();
      void loadQuote();
      void loadPairBalances();
    } catch {
      setStatus({ kind: "error", text: "Swap request failed" });
    } finally {
      setBusy(false);
    }
  }

  function reverseTradeFlow() {
    if (tradePaused) return;
    if (!selectedOutputMint) return;
    const nextInput = selectedOutputMint;
    const nextOutput = selectedInputMint;
    setSelectedInputMint(nextInput);
    setSelectedOutputMint(nextOutput);
    setInputSearch(selectedOutputToken?.symbol || "");
    setOutputSearch(selectedInputToken.symbol);
    setAmountSol(quote?.ok && quote.outAmount ? String(quote.outAmount) : amountSol);
  }

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-500/10 to-transparent p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">wallet control</h2>
        <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={refreshWalletControlPanel}
          disabled={panelRefreshBusy}
          className="rounded-lg border border-white/20 bg-black/40 px-2 py-1 disabled:opacity-50"
        >
          {panelRefreshBusy ? "Refreshing…" : "Refresh wallet control"}
        </button>
        {panelRefreshStatus ? <span className="text-white/60">{panelRefreshStatus}</span> : null}
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">SOL balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.sol.toFixed(4) : "—"}</div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">BBQ balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.bbq.toFixed(4) : "—"}</div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-black/35 p-3">
          <div className="text-[11px] text-white/55">USDC balance</div>
          <div className="text-lg font-semibold">{wallet ? wallet.usdc.toFixed(4) : "—"}</div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/30 p-2 text-[11px] lg:max-w-md">
        <button
          type="button"
          onClick={() => onSetActivePanel("arb")}
          className={`rounded-md border px-2 py-1 ${activePanel === "arb" ? "border-emerald-300/40 bg-emerald-200/15" : "border-white/15 bg-black/30"}`}
        >
          Automation side active
        </button>
        <button
          type="button"
          onClick={() => onSetActivePanel("trade")}
          className={`rounded-md border px-2 py-1 ${activePanel === "trade" ? "border-cyan-300/40 bg-cyan-200/15" : "border-white/15 bg-black/30"}`}
        >
          Trade side active
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ExecutionControls
          key={JSON.stringify({ execution, strategyEngines })}
          execution={execution}
          busy={executionBusy}
          status={executionStatus}
          strategyEngines={strategyEngines}
          arbPaused={arbPaused}
          onSave={saveExecution}
          onSaveStrategyEngines={saveStrategyEngines}
        />

        <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
          {swapBlocked ? (
            <div className="mb-3 rounded-xl border border-amber-300/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Swap execution is blocked while automation is active. You can still search pairs and inspect quotes.
            </div>
          ) : null}
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-white/15 bg-black/30 px-3 py-2">
            <div className="flex -space-x-2">
              <TokenLogo mint={selectedInputToken.mint} symbol={selectedInputToken.symbol} logoUri={selectedInputToken.logoUri} />
              {selectedOutputToken ? <TokenLogo mint={selectedOutputToken.mint} symbol={selectedOutputToken.symbol} logoUri={selectedOutputToken.logoUri} /> : null}
            </div>
            <div className="min-w-0 text-right">
              <p className="truncate text-base font-semibold">{selectedPairLabel}</p>
              <p className="truncate text-xs text-white/70">
                {shortMint(selectedInputToken.mint)}/{selectedOutputToken ? shortMint(selectedOutputToken.mint) : "—"}
              </p>
            </div>
          </div>

          <div className="mb-3 rounded-2xl border border-emerald-300/25 bg-slate-950/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs text-white/60">Sell</div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSellAmountByPercent(1)}
                  disabled={tradePaused}
                  className="rounded-md border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px]"
                >
                  100%
                </button>
                <button
                  type="button"
                  onClick={() => setSellAmountByPercent(0.5)}
                  disabled={tradePaused}
                  className="rounded-md border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px]"
                >
                  50%
                </button>
              </div>
            </div>
            <div className="mb-2 flex items-center justify-between text-xs text-white/55">
              <span>Balance</span>
              <span>{pairBalancesLoading ? "…" : (pairBalances[selectedInputMint] ?? 0).toFixed(4)}</span>
            </div>
            <label className="block text-xs text-white/70">
              Token
              <input
                type="text"
                value={inputSearch}
                onChange={(e) => setInputSearch(e.target.value)}
                disabled={tradePaused}
                placeholder="Search name, symbol, or CA"
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
            {showInputTokenOptions ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2">
                {inputTokenResults.map((token) => {
                  const selected = token.mint === selectedInputMint;
                  return (
                    <button
                      key={`input-${token.mint}`}
                      type="button"
                      onClick={() => {
                        if (tradePaused) return;
                        setSelectedInputMint(token.mint);
                        setInputSearch(token.symbol);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                        selected ? "bg-amber-300/15 text-amber-100" : "hover:bg-white/10"
                      }`}
                    >
                      <TokenLogo mint={token.mint} symbol={token.symbol} logoUri={token.logoUri} />
                      <div>
                        <div className="text-sm font-medium">{token.symbol}</div>
                        <div className="text-[11px] text-white/60">{token.name || shortMint(token.mint)}</div>
                      </div>
                      <span className="ml-auto text-white/60">{shortMint(token.mint)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <label className="mt-3 text-xs text-white/70">
              Amount ({selectedInputToken.symbol})
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={amountSol}
                onChange={(e) => setAmountSol(e.target.value)}
                disabled={tradePaused}
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
          </div>

          <div className="relative mb-3">
            <button
              type="button"
              onClick={reverseTradeFlow}
              disabled={tradePaused}
              className="absolute -top-5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-slate-900 px-2 py-1 text-sm"
            >
              ⇅
            </button>
          </div>

          <div className="mb-3 rounded-2xl border border-cyan-300/20 bg-slate-950/60 p-3">
            <div className="mb-2 text-xs text-white/60">Buy</div>
            <div className="mb-2 flex items-center justify-between text-xs text-white/55">
              <span>Balance</span>
              <span>{pairBalancesLoading ? "…" : selectedOutputMint ? (pairBalances[selectedOutputMint] ?? 0).toFixed(4) : "—"}</span>
            </div>
            <label className="block text-xs text-white/70">
              Token
              <input
                type="text"
                value={outputSearch}
                onChange={(e) => setOutputSearch(e.target.value)}
                disabled={tradePaused}
                placeholder="Search name, symbol, or CA"
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
            {showOutputTokenOptions ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2">
                {outputTokenResults.map((token) => {
                  const selected = token.mint === selectedOutputMint;
                  return (
                    <button
                      key={`output-${token.mint}`}
                      type="button"
                      onClick={() => {
                        if (tradePaused) return;
                        setSelectedOutputMint(token.mint);
                        setOutputSearch(token.symbol);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                        selected ? "bg-amber-300/15 text-amber-100" : "hover:bg-white/10"
                      }`}
                    >
                      <TokenLogo mint={token.mint} symbol={token.symbol} logoUri={token.logoUri} />
                      <div>
                        <div className="text-sm font-medium">{token.symbol}</div>
                        <div className="text-[11px] text-white/60">{token.name || shortMint(token.mint)}</div>
                      </div>
                      <span className="ml-auto text-white/60">{shortMint(token.mint)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_108px]">
            <div className="rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-[11px] text-white/80">
              <div className="flex items-center justify-between">
                <span>Quote</span>
              </div>
              {!quote ? (
                <p className="mt-1 text-white/55">Enter an amount to view estimated output, fee, and min received.</p>
              ) : quote.ok ? (
                  <div className="mt-1 space-y-1">
                  <div>
                    Rate: 1 {selectedInputToken.symbol} ≈ {formatTokenAmount(rate, 6)} {selectedOutputToken?.symbol || "token"}
                  </div>
                  <div>
                    Estimated output: {formatTokenAmount(quote.outAmount)} {selectedOutputToken?.symbol || "token"}
                  </div>
                  <div>
                    Min received (slippage applied): {formatTokenAmount(quote.otherAmountThreshold)} {selectedOutputToken?.symbol || "token"}
                  </div>
                  <div>
                    Route fee: {formatTokenAmount(quote.routeFeeAmount)} {quote.routeFeeSymbol || selectedOutputToken?.symbol || "token"}
                  </div>
                  <div>Price impact: {formatPriceImpact(quote.priceImpactPct)}%</div>
                </div>
              ) : (
                <p className="mt-1 text-amber-200">{quote.error || "Quote unavailable"}</p>
              )}
            </div>
            <label className="text-xs text-white/70">
              Slippage (bps)
              <input
                type="number"
                min={10}
                max={300}
                step={5}
                value={slippageBps}
                onChange={(e) => setSlippageBps(Math.min(300, Math.max(10, Number(e.target.value) || 50)))}
                disabled={tradePaused}
                className="mt-1 block w-full rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-sm"
              />
            </label>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/30 p-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span>{selectedInputToken.symbol}</span>
                <span className="text-emerald-300">{rate > 0 ? "+0.92%" : "—"}</span>
              </div>
              <Sparkline seed={selectedInputToken.mint} />
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span>{selectedOutputToken?.symbol || "Output"}</span>
                <span className="text-pink-300">{rate > 0 ? "-0.05%" : "—"}</span>
              </div>
              <Sparkline seed={selectedOutputMint || "output"} />
            </div>
          </div>

          <button
            onClick={submitDirectSwap}
            disabled={busy || !hasValidPair || swapBlocked}
            className="mt-3 w-full rounded-xl border border-amber-200/40 bg-amber-300/10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Submitting…" : `Swap ${selectedInputToken.symbol} → ${selectedOutputToken?.symbol || "token"}`}
          </button>

          {!hasValidPair ? (
            <p className="mt-3 text-xs text-white/60">
              Search and select both tokens to enable execution.
            </p>
          ) : null}

          {status.kind !== "idle" ? (
            <p className={`mt-3 text-xs ${status.kind === "ok" ? "text-emerald-200" : "text-amber-200"}`}>
              {status.text}
            </p>
          ) : null}
        </div>
      </div>

      <ArbLogFeed />
    </div>
  );
}

function ExecutionControls({
  execution,
  busy,
  status,
  strategyEngines,
  arbPaused,
  onSave,
  onSaveStrategyEngines,
}: {
  execution: ExecutionAuthority | null;
  busy: boolean;
  status: string;
  strategyEngines: StrategyEngines | null;
  arbPaused: boolean;
  onSave: (input: ExecutionAuthority) => void;
  onSaveStrategyEngines: (input: StrategyEngines) => void;
}) {
  const [mode, setMode] = useState<ExecutionMode>(execution?.mode ?? "user_only");
  const [maxTradeUsd, setMaxTradeUsd] = useState(String(execution?.maxTradeUsd ?? 50));
  const [cooldownMinutes, setCooldownMinutes] = useState(String(execution?.cooldownMinutes ?? 15));
  const [allowlist, setAllowlist] = useState(execution?.mintAllowlist.join(",") ?? "");
  const [allowlistLoadStatus, setAllowlistLoadStatus] = useState("");
  const [minImbalancePct, setMinImbalancePct] = useState(String(strategyEngines?.poolImbalance.minImbalancePct ?? 5));
  const [poolsWatched] = useState<PoolWatchMode>(strategyEngines?.poolImbalance.poolsWatched ?? "all_available");
  const [jitoBundleEnabled, setJitoBundleEnabled] = useState(strategyEngines?.poolImbalance.useJitoBundle ?? true);
  const [minNetProfitSol, setMinNetProfitSol] = useState(String(strategyEngines?.crossDexArb.minNetProfitSol ?? 0.001));
  const [routeVia, setRouteVia] = useState<RouteMode>(strategyEngines?.crossDexArb.routeVia ?? "jupiter");
  const [triangularRoutes, setTriangularRoutes] = useState(strategyEngines?.crossDexArb.enableTriangularRoutes ?? true);
  const [entryVolSpike, setEntryVolSpike] = useState(String(strategyEngines?.momentumRunner.entryVolSpikeMultiplier ?? 5));
  const [trailingStopPct, setTrailingStopPct] = useState(String(strategyEngines?.momentumRunner.exitTrailingStopPct ?? 15));
  const [maxHoldMinutes, setMaxHoldMinutes] = useState(String(strategyEngines?.momentumRunner.maxHoldMinutes ?? 30));
  const [hardStopLossPct, setHardStopLossPct] = useState(String(strategyEngines?.momentumRunner.hardStopLossPct ?? 20));
  const [watchPumpFun, setWatchPumpFun] = useState(strategyEngines?.momentumRunner.watchPumpFunLaunches ?? false);
  const [birdEyeTrending, setBirdEyeTrending] = useState(strategyEngines?.momentumRunner.useBirdeyeTrendingFeed ?? true);

  const loadTopAllowlist = useCallback(async () => {
    setAllowlistLoadStatus("");
    try {
      const res = await fetch("/api/arb/allowlist?limit=500", { cache: "no-store" });
      const data = (await res.json()) as { ok?: boolean; count?: number; mints?: string[] };
      if (!res.ok || !data.ok || !Array.isArray(data.mints)) {
        setAllowlistLoadStatus("Unable to load whitelist.json");
        return;
      }

      setAllowlist(data.mints.join(","));
      setAllowlistLoadStatus(`Loaded top ${data.count ?? data.mints.length} mints from whitelist.json`);
    } catch {
      setAllowlistLoadStatus("Unable to load whitelist.json");
    }
  }, []);

  useEffect(() => {
    if (!execution) return;
    if (execution.mintAllowlist.length > 0) return;
    const id = window.setTimeout(() => {
      void loadTopAllowlist();
    }, 0);
    return () => window.clearTimeout(id);
  }, [execution, loadTopAllowlist]);

  return (
    <div className="rounded-2xl border border-white/15 bg-black/35 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Automation control</h3>
      </div>
      {!execution ? (
        <p className="text-sm text-white/60">Unable to load execution controls.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 text-xs">
          {arbPaused ? (
            <p className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-cyan-100">
              Automation controls are paused while Trade side is active.
            </p>
          ) : null}
          <label className="text-white/70">Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as ExecutionMode)} disabled={arbPaused} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1">
            <option value="user_only">User-only mode</option>
            <option value="agent_assisted">Agent-assisted mode</option>
            <option value="emergency_stop">Emergency stop</option>
          </select>
          <label className="text-white/70">Max trade (USD)</label>
          <input value={maxTradeUsd} onChange={(e) => setMaxTradeUsd(e.target.value)} disabled={arbPaused} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
          <label className="text-white/70">Mint allowlist (comma separated)</label>
          <input value={allowlist} onChange={(e) => setAllowlist(e.target.value)} disabled={arbPaused} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
          <button
            type="button"
            onClick={loadTopAllowlist}
            disabled={arbPaused}
            className="rounded-lg border border-cyan-300/30 bg-cyan-200/10 px-2 py-1 text-left"
          >
            Load top-500 allowlist from automation/whitelist.json
          </button>
          {allowlistLoadStatus ? <p className="text-[11px] text-white/60">{allowlistLoadStatus}</p> : null}
          <label className="text-white/70">Cooldown (minutes)</label>
          <input value={cooldownMinutes} onChange={(e) => setCooldownMinutes(e.target.value)} disabled={arbPaused} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1" />
          <div className="mt-1 rounded-xl border border-white/15 bg-black/30 p-2 text-white/80">
            <div className="mb-2 font-medium text-white/90">Strategy engines</div>
            <div className="space-y-2">
              <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px]">pool imbalance / AMM rebalancer</span>
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">active</span>
                </div>
                <label className="block text-[11px] text-white/70">min imbalance threshold (%)</label>
                <input value={minImbalancePct} onChange={(e) => setMinImbalancePct(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <div className="mt-2 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white/75">
                  DEX coverage: full available universe (auto-expanded)
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={jitoBundleEnabled} onChange={(e) => setJitoBundleEnabled(e.target.checked)} disabled={arbPaused} />
                  use Jito bundle for guaranteed landing
                </label>
              </div>

              <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px]">cross-DEX arbitrage</span>
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">active</span>
                </div>
                <label className="block text-[11px] text-white/70">min net profit (SOL)</label>
                <input value={minNetProfitSol} onChange={(e) => setMinNetProfitSol(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <label className="mt-2 block text-[11px] text-white/70">route via</label>
                <select value={routeVia} onChange={(e) => setRouteVia(e.target.value as RouteMode)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]">
                  <option value="jupiter">Jupiter aggregator API</option>
                  <option value="direct">Direct pools</option>
                </select>
                <label className="mt-2 flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={triangularRoutes} onChange={(e) => setTriangularRoutes(e.target.checked)} disabled={arbPaused} />
                  enable triangular routes (A→B→C→A)
                </label>
              </div>

              <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px]">momentum runner / exit sniper</span>
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">defaults loaded</span>
                </div>
                <label className="block text-[11px] text-white/70">entry: vol spike multiplier</label>
                <input value={entryVolSpike} onChange={(e) => setEntryVolSpike(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <label className="mt-2 block text-[11px] text-white/70">exit: trailing stop (%)</label>
                <input value={trailingStopPct} onChange={(e) => setTrailingStopPct(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <label className="mt-2 block text-[11px] text-white/70">max hold (minutes)</label>
                <input value={maxHoldMinutes} onChange={(e) => setMaxHoldMinutes(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <label className="mt-2 block text-[11px] text-white/70">hard stop loss (%)</label>
                <input value={hardStopLossPct} onChange={(e) => setHardStopLossPct(e.target.value)} disabled={arbPaused} className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px]" />
                <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={watchPumpFun} onChange={(e) => setWatchPumpFun(e.target.checked)} disabled={arbPaused} />
                    watch pump.fun launches
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={birdEyeTrending} onChange={(e) => setBirdEyeTrending(e.target.checked)} disabled={arbPaused} />
                    Birdeye trending feed
                  </label>
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              onSaveStrategyEngines({
                poolImbalance: {
                  minImbalancePct: Number(minImbalancePct) || 0,
                  poolsWatched,
                  useJitoBundle: jitoBundleEnabled,
                },
                crossDexArb: {
                  minNetProfitSol: Number(minNetProfitSol) || 0,
                  routeVia,
                  enableTriangularRoutes: triangularRoutes,
                },
                momentumRunner: {
                  entryVolSpikeMultiplier: Number(entryVolSpike) || 0,
                  exitTrailingStopPct: Number(trailingStopPct) || 0,
                  maxHoldMinutes: Number(maxHoldMinutes) || 30,
                  hardStopLossPct: Number(hardStopLossPct) || 20,
                  watchPumpFunLaunches: watchPumpFun,
                  useBirdeyeTrendingFeed: birdEyeTrending,
                },
              })
            }
            disabled={busy || arbPaused}
            className="mt-1 rounded-lg border border-emerald-300/30 bg-emerald-200/10 px-2 py-1 text-left"
          >
            Save strategy controls
          </button>
          <button
            onClick={() =>
              onSave({
                mode,
                maxTradeUsd: Number(maxTradeUsd) || 0,
                cooldownMinutes: Number(cooldownMinutes) || 0,
                mintAllowlist: allowlist.split(",").map((item) => item.trim()).filter(Boolean),
              })
            }
            disabled={busy || arbPaused}
            className="mt-1 rounded-lg border border-white/10 px-2 py-1"
          >
            Save execution policy
          </button>
          {status ? <p className="text-[11px] text-white/60">{status}</p> : null}
        </div>
      )}
    </div>
  );
}
