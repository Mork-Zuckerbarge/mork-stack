import { logger } from './logger';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface CircuitBreakerConfig {
  maxLossPerHourSol: number;      // halt if we lose more than X SOL/hour
  maxLossPerSessionSol: number;   // halt if session loss exceeds X SOL
  maxConsecutiveLosses: number;   // halt after N consecutive losing trades
  maxTradesPerMinute: number;     // rate limit to avoid runaway loops
}

const DEFAULTS: CircuitBreakerConfig = {
  maxLossPerHourSol: 0.5,
  maxLossPerSessionSol: 1.0,
  maxConsecutiveLosses: 5,
  maxTradesPerMinute: 30,
};

/**
 * CircuitBreaker protects capital by automatically halting the agent
 * when loss thresholds or anomalous trade rates are exceeded.
 *
 * Always-on — not configurable off. This is your safety net.
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private tripped = false;
  private tripReason = '';

  private sessionLossLamports = 0;
  private hourlyLossLamports = 0;
  private consecutiveLosses = 0;

  private tradeTimestamps: number[] = []; // for rate limiting
  private hourlyResetInterval: NodeJS.Timeout;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };

    // Reset hourly loss counter every hour
    this.hourlyResetInterval = setInterval(() => {
      this.hourlyLossLamports = 0;
      logger.debug('Hourly loss counter reset');
    }, 60 * 60 * 1000);
  }

  /**
   * Call before every trade attempt. Returns false if trading should halt.
   */
  check(): { allowed: boolean; reason?: string } {
    if (this.tripped) {
      return { allowed: false, reason: `Circuit tripped: ${this.tripReason}` };
    }

    // Rate limit check
    const now = Date.now();
    this.tradeTimestamps = this.tradeTimestamps.filter((ts) => now - ts < 60_000);
    if (this.tradeTimestamps.length >= this.config.maxTradesPerMinute) {
      return { allowed: false, reason: `Rate limit: ${this.config.maxTradesPerMinute} trades/min` };
    }

    return { allowed: true };
  }

  /**
   * Record the result of a completed trade. Will trip the breaker if
   * any threshold is breached.
   */
  recordResult(netProfitLamports: number, dryRun: boolean): void {
    if (dryRun) return;

    this.tradeTimestamps.push(Date.now());

    if (netProfitLamports < 0) {
      const loss = Math.abs(netProfitLamports);
      this.sessionLossLamports += loss;
      this.hourlyLossLamports += loss;
      this.consecutiveLosses++;

      logger.debug('CircuitBreaker: loss recorded', {
        loss: (loss / LAMPORTS_PER_SOL).toFixed(6) + ' SOL',
        sessionTotal: (this.sessionLossLamports / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
        consecutive: this.consecutiveLosses,
      });

      this.evaluate();
    } else {
      // Reset consecutive loss counter on any win
      this.consecutiveLosses = 0;
    }
  }

  private evaluate(): void {
    if (this.sessionLossLamports > this.config.maxLossPerSessionSol * LAMPORTS_PER_SOL) {
      this.trip(`Session loss limit reached: ${(this.sessionLossLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      return;
    }

    if (this.hourlyLossLamports > this.config.maxLossPerHourSol * LAMPORTS_PER_SOL) {
      this.trip(`Hourly loss limit reached: ${(this.hourlyLossLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      return;
    }

    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} consecutive losses — pausing`);
      return;
    }
  }

  private trip(reason: string): void {
    this.tripped = true;
    this.tripReason = reason;
    logger.error('🚨 CIRCUIT BREAKER TRIPPED 🚨', { reason });
    logger.error('Agent halted. Review logs, then call circuitBreaker.reset() to resume.');
  }

  /**
   * Manually reset the breaker after reviewing logs.
   * Clears all counters — use with caution.
   */
  reset(): void {
    this.tripped = false;
    this.tripReason = '';
    this.sessionLossLamports = 0;
    this.hourlyLossLamports = 0;
    this.consecutiveLosses = 0;
    this.tradeTimestamps = [];
    logger.warn('Circuit breaker manually reset — trading resumed');
  }

  isTripped(): boolean {
    return this.tripped;
  }

  status(): object {
    return {
      tripped: this.tripped,
      reason: this.tripReason || null,
      sessionLossSol: (this.sessionLossLamports / LAMPORTS_PER_SOL).toFixed(4),
      hourlyLossSol: (this.hourlyLossLamports / LAMPORTS_PER_SOL).toFixed(4),
      consecutiveLosses: this.consecutiveLosses,
      tradesLastMinute: this.tradeTimestamps.filter((ts) => Date.now() - ts < 60_000).length,
      limits: {
        maxLossPerHourSol: this.config.maxLossPerHourSol,
        maxLossPerSessionSol: this.config.maxLossPerSessionSol,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        maxTradesPerMinute: this.config.maxTradesPerMinute,
      },
    };
  }

  destroy(): void {
    clearInterval(this.hourlyResetInterval);
  }
}
