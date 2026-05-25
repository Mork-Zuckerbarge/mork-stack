// Rolling Pearson correlation tracker for active positions.
// Prevents entering a new position when it is highly correlated with an
// already-open one — e.g. two dog-themed memecoins that crash together.
const WINDOW = 60;        // price samples kept per token (1 per minute = 1 h window)
const SAMPLE_MS = 60_000; // minimum gap between samples

interface Series {
  prices: number[];
  lastAt: number;
}

export class CorrelationFilter {
  private series: Map<string, Series> = new Map();
  private readonly threshold: number;

  constructor(threshold = 0.75) {
    this.threshold = threshold;
  }

  recordPrice(mint: string, price: number): void {
    const now = Date.now();
    let s = this.series.get(mint);
    if (!s) {
      s = { prices: [], lastAt: 0 };
      this.series.set(mint, s);
    }
    if (now - s.lastAt >= SAMPLE_MS) {
      s.prices.push(price);
      if (s.prices.length > WINDOW) s.prices.shift();
      s.lastAt = now;
    }
  }

  // Returns true if the candidate would add concentrated correlated exposure.
  isTooCorrelated(candidate: string, activeMints: string[]): boolean {
    if (!activeMints.length) return false;
    const cs = this.series.get(candidate);
    if (!cs || cs.prices.length < 10) return false;

    for (const m of activeMints) {
      if (m === candidate) continue;
      const as = this.series.get(m);
      if (!as || as.prices.length < 10) continue;
      if (Math.abs(pearson(cs.prices, as.prices)) >= this.threshold) return true;
    }
    return false;
  }
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const av = a.slice(-n);
  const bv = b.slice(-n);
  const ma = av.reduce((s, x) => s + x, 0) / n;
  const mb = bv.reduce((s, x) => s + x, 0) / n;
  let num = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - ma;
    const db = bv[i] - mb;
    num += da * db;
    sa += da * da;
    sb += db * db;
  }
  const d = Math.sqrt(sa * sb);
  return d === 0 ? 0 : num / d;
}
