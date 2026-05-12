export type TradeFeatures = {
  symbol?: string;
  timeframe?: string;
  sideBias: "buy" | "sell" | "neutral";
  hasEntry: boolean;
  hasStop: boolean;
  hasTarget: boolean;
  hasSize: boolean;
  riskWords: number;
  confidenceWords: number;
  edgeSignals: number;
};

export type ScoredSignal = {
  score: number;
  confidence: number;
  readiness: "high" | "medium" | "low";
  rationale: string[];
};

export type PolicyVeto = {
  vetoed: boolean;
  reasons: string[];
};

const TF_RE = /\b(1m|5m|15m|30m|1h|4h|1d|daily|weekly)\b/i;
const SYMBOL_RE = /\b([A-Z]{2,6}(?:\/[A-Z]{2,6})?)\b/;

export function engineerFeatures(message: string, marketContext: string[]): TradeFeatures {
  const text = (message || "").trim();
  const lower = text.toLowerCase();

  const sideBias = /\b(long|buy|bull|bid)\b/.test(lower)
    ? "buy"
    : /\b(short|sell|bear|ask)\b/.test(lower)
      ? "sell"
      : "neutral";

  const symbolMatch = text.match(SYMBOL_RE);
  const tfMatch = text.match(TF_RE);

  const joinedCtx = marketContext.join(" ").toLowerCase();
  const edgeSignals = (joinedCtx.match(/\b(arb|edge|opportunity|spread|net=|edge=)\b/g) || []).length;

  return {
    symbol: symbolMatch?.[1],
    timeframe: tfMatch?.[1],
    sideBias,
    hasEntry: /\bentry\b|\benter\b|\bat\s+\d/.test(lower),
    hasStop: /\bstop\b|\bsl\b/.test(lower),
    hasTarget: /\btarget\b|\btp\b|\btake[- ]?profit\b/.test(lower),
    hasSize: /\bsize\b|\bposition\b|\b\d+(\.\d+)?%\b/.test(lower),
    riskWords: (lower.match(/\brisk|loss|drawdown|invalidat/i) || []).length,
    confidenceWords: (lower.match(/\bconfidence|conviction|probab|likely\b/g) || []).length,
    edgeSignals,
  };
}

export function scoreSignal(f: TradeFeatures): ScoredSignal {
  let score = 0;
  const rationale: string[] = [];

  if (f.symbol) { score += 18; rationale.push("symbol_present"); }
  if (f.timeframe) { score += 12; rationale.push("timeframe_present"); }
  if (f.hasEntry) { score += 14; rationale.push("entry_present"); }
  if (f.hasStop) { score += 16; rationale.push("stop_present"); }
  if (f.hasTarget) { score += 14; rationale.push("target_present"); }
  if (f.hasSize) { score += 10; rationale.push("size_present"); }
  if (f.sideBias !== "neutral") { score += 6; rationale.push("side_bias_present"); }

  score += Math.min(f.edgeSignals * 4, 16);
  if (f.edgeSignals > 0) rationale.push("market_edge_context_detected");

  const confidence = Math.max(0.1, Math.min(0.95, score / 100));
  const readiness = score >= 70 ? "high" : score >= 45 ? "medium" : "low";

  return { score, confidence, readiness, rationale };
}

export function evaluatePolicyVeto(f: TradeFeatures, s: ScoredSignal): PolicyVeto {
  const reasons: string[] = [];

  if (!f.symbol) reasons.push("missing_symbol");
  if (!f.timeframe) reasons.push("missing_timeframe");
  if (!f.hasStop) reasons.push("missing_stop");
  if (s.readiness === "low") reasons.push("low_readiness_score");

  return { vetoed: reasons.length > 0, reasons };
}

export function buildExplanation(f: TradeFeatures, s: ScoredSignal, v: PolicyVeto): string {
  const symbol = f.symbol || "unknown";
  const tf = f.timeframe || "unspecified";
  const vetoBlock = v.vetoed ? `veto=true reasons=${v.reasons.join(",")}` : "veto=false";
  return [
    `INTEL: symbol=${symbol} timeframe=${tf} bias=${f.sideBias}`,
    `INTEL: readiness=${s.readiness} score=${s.score} confidence=${s.confidence.toFixed(2)}`,
    `INTEL: controls ${vetoBlock}`,
    `INTEL: rationale=${s.rationale.join(",") || "none"}`,
  ].join("\n");
}

export function createTradeIntel(message: string, marketContext: string[]): string {
  const f = engineerFeatures(message, marketContext);
  const s = scoreSignal(f);
  const v = evaluatePolicyVeto(f, s);
  return buildExplanation(f, s, v);
}
