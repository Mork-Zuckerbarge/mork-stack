import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { ExecutionResult, StrategyType } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const STATS_FILE = 'logs/stats.json';

interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
  totalProfitLamports: number;
  totalFeesLamports: number;
  largestWinLamports: number;
  largestLossLamports: number;
}

interface SessionStats {
  startedAt: string;
  startBalanceSol: number;
  currentBalanceSol: number;
  totalTrades: number;
  wins: number;
  losses: number;
  dryRunTrades: number;
  netProfitLamports: number;
  byStrategy: Record<string, StrategyStats>;
  recentTrades: TradeRecord[];
}

interface TradeRecord {
  ts: string;
  strategy: string;
  success: boolean;
  netProfitLamports: number;
  dryRun: boolean;
  signature?: string;
}

function emptyStrategyStats(): StrategyStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    totalProfitLamports: 0,
    totalFeesLamports: 0,
    largestWinLamports: 0,
    largestLossLamports: 0,
  };
}

export class StatsTracker {
  private session: SessionStats;

  constructor(startBalanceSol: number) {
    this.session = {
      startedAt: new Date().toISOString(),
      startBalanceSol,
      currentBalanceSol: startBalanceSol,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      dryRunTrades: 0,
      netProfitLamports: 0,
      byStrategy: {
        [StrategyType.ARBITRAGE]: emptyStrategyStats(),
        [StrategyType.AMM_IMBALANCE]: emptyStrategyStats(),
        [StrategyType.MOMENTUM]: emptyStrategyStats(),
      },
      recentTrades: [],
    };
  }

  record(result: ExecutionResult, strategy: StrategyType): void {
    const profit = result.netProfitLamports ?? 0;

    if (result.dryRun) {
      this.session.dryRunTrades++;
    } else {
      this.session.totalTrades++;

      if (result.success && profit > 0) {
        this.session.wins++;
      } else {
        this.session.losses++;
      }

      this.session.netProfitLamports += profit;
    }

    // Update per-strategy stats
    const strat = this.session.byStrategy[strategy] ?? emptyStrategyStats();
    strat.trades++;
    if (result.success && profit > 0) {
      strat.wins++;
      strat.totalProfitLamports += profit;
      strat.largestWinLamports = Math.max(strat.largestWinLamports, profit);
    } else if (!result.dryRun) {
      strat.losses++;
      strat.largestLossLamports = Math.max(strat.largestLossLamports, -profit);
    }

    // Keep last 100 trades
    const record: TradeRecord = {
      ts: new Date().toISOString(),
      strategy,
      success: result.success,
      netProfitLamports: profit,
      dryRun: result.dryRun,
      signature: result.signature,
    };
    this.session.recentTrades.unshift(record);
    if (this.session.recentTrades.length > 100) {
      this.session.recentTrades.pop();
    }

    this.persist();
  }

  updateBalance(currentBalanceSol: number): void {
    this.session.currentBalanceSol = currentBalanceSol;
  }

  printSummary(): void {
    const net = this.session.netProfitLamports;
    const winRate = this.session.totalTrades > 0
      ? ((this.session.wins / this.session.totalTrades) * 100).toFixed(1)
      : 'n/a';

    logger.info('── Session Summary ─────────────────────────────────');
    logger.info(`Started:       ${this.session.startedAt}`);
    logger.info(`Balance:       ${this.session.startBalanceSol.toFixed(4)} → ${this.session.currentBalanceSol.toFixed(4)} SOL`);
    logger.info(`Net PnL:       ${(net / LAMPORTS_PER_SOL).toFixed(6)} SOL (${net >= 0 ? '+' : ''}${net})`);
    logger.info(`Total trades:  ${this.session.totalTrades} (${this.session.wins}W / ${this.session.losses}L)`);
    logger.info(`Win rate:      ${winRate}%`);
    logger.info(`Dry-run sims:  ${this.session.dryRunTrades}`);
    logger.info('── By Strategy ─────────────────────────────────────');

    for (const [name, s] of Object.entries(this.session.byStrategy)) {
      if (s.trades === 0) continue;
      const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : '0';
      logger.info(`${name.padEnd(15)} ${s.trades} trades  ${wr}% win  +${(s.totalProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }

    logger.info('────────────────────────────────────────────────────');
  }

  private persist(): void {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.session, null, 2));
    } catch {
      // non-fatal
    }
  }

  getSession(): Readonly<SessionStats> {
    return this.session;
  }
}
