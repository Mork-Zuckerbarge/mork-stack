import axios from 'axios';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Drift v2 public stats endpoint for perpetual market funding rates
const DRIFT_STATS_API = 'https://data.api.drift.trade';

// Markets to monitor — Drift market index + corresponding spot mint
const DRIFT_MARKETS = [
  { index: 0,  symbol: 'SOL',  spotMint: SOL_MINT },
  { index: 1,  symbol: 'BTC',  spotMint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' },
  { index: 2,  symbol: 'ETH',  spotMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { index: 3,  symbol: 'APT',  spotMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  { index: 4,  symbol: 'MATIC', spotMint: 'Gz7VkD4MacbEB6yC5XD3HcumEiYx2EtDYYrfikGsvopG' },
];

interface FundingRate {
  marketIndex: number;
  symbol: string;
  spotMint: string;
  fundingRatePctPerHour: number;
  direction: 'long' | 'short'; // direction favoured by funding (who pays whom)
}

/**
 * DriftFundingArb monitors Drift Protocol perpetual funding rates.
 *
 * When |funding rate| exceeds the configured threshold, there is a basis trade:
 *   Positive funding → longs pay shorts → short perp + long spot (collect funding)
 *   Negative funding → shorts pay longs → long perp + short spot (collect funding)
 *
 * This strategy executes the SPOT side via Jupiter and logs the perp side.
 * Full perp-side execution requires Drift SDK integration (see stub below).
 *
 * Min default: 0.05% per hour ≈ 1.2% per day — a meaningful carry edge.
 */
export class DriftFundingArb {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;

  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollMs = 5 * 60_000; // check every 5 minutes
  private readonly minFundingRatePct: number;

  constructor(
    config: AgentConfig,
    connection: Connection,
    wallet: Keypair,
    feeSimulator: FeeSimulator,
    jitoClient: JitoClient
  ) {
    this.config = config;
    this.connection = connection;
    this.wallet = wallet;
    this.feeSimulator = feeSimulator;
    this.jitoClient = jitoClient;
    this.minFundingRatePct = config.driftMinFundingRatePct;
  }

  start(): void {
    logger.info('DriftFundingArb started', {
      minFundingRatePct: this.minFundingRatePct,
      pollIntervalMin: this.pollMs / 60_000,
    });
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    logger.info('DriftFundingArb stopped');
  }

  private async poll(): Promise<void> {
    try {
      const rates = await this.fetchFundingRates();
      if (!rates.length) return;

      for (const rate of rates) {
        if (Math.abs(rate.fundingRatePctPerHour) < this.minFundingRatePct) continue;

        logger.info('Drift funding rate opportunity', {
          market: rate.symbol,
          ratePctHour: rate.fundingRatePctPerHour.toFixed(4) + '%',
          ratePctDay: (rate.fundingRatePctPerHour * 24).toFixed(3) + '%',
          direction: rate.direction,
          action: rate.direction === 'long'
            ? 'short perp + buy spot (collect funding from longs)'
            : 'long perp + sell spot (collect funding from shorts)',
        });

        await this.executeBasisTrade(rate);
      }
    } catch (err) {
      logger.warn('DriftFundingArb poll error', { err });
    }
  }

  private async fetchFundingRates(): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];

    for (const market of DRIFT_MARKETS) {
      try {
        // Drift's public funding rate history endpoint
        const res = await axios.get(`${DRIFT_STATS_API}/fundingRates`, {
          params: { marketIndex: market.index, limit: 1 },
          timeout: 5000,
        });

        const records = Array.isArray(res.data?.fundingRates)
          ? res.data.fundingRates
          : Array.isArray(res.data)
            ? res.data
            : [];

        if (!records.length) continue;

        const latest = records[0];
        // Drift stores rates in PRICE_PRECISION (1e6). Hourly rate as a decimal.
        const rawRate = Number(latest.fundingRate ?? latest.cumulativeFundingRateLong ?? 0);
        const fundingRatePctPerHour = (rawRate / 1e9) * 100; // convert to %

        if (!Number.isFinite(fundingRatePctPerHour)) continue;

        rates.push({
          marketIndex: market.index,
          symbol: market.symbol,
          spotMint: market.spotMint,
          fundingRatePctPerHour,
          direction: fundingRatePctPerHour > 0 ? 'long' : 'short',
        });
      } catch {
        // API may not have all markets — skip silently
      }
    }

    return rates;
  }

  private async executeBasisTrade(rate: FundingRate): Promise<ExecutionResult | null> {
    // Spot side: buy if funding is positive (we'll short perp, so buy spot as hedge)
    //            sell if funding is negative (we'll long perp, so sell spot as hedge)
    const buySide = rate.direction === 'long';
    const amountSol = this.config.maxPositionSol * 0.5;
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const [inputMint, outputMint] = buySide
      ? [SOL_MINT, rate.spotMint]
      : [rate.spotMint, SOL_MINT];

    if (outputMint === SOL_MINT && inputMint === SOL_MINT) return null; // degenerate

    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.DRIFT_FUNDING,
      tokenIn: new PublicKey(inputMint),
      tokenOut: new PublicKey(outputMint),
      amountIn: BigInt(amountLamports),
      expectedAmountOut: BigInt(0),
      grossProfitLamports: 0,
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: 0.6,
      expiresAt: Date.now() + 30_000,
      meta: { rate, buySide, amountSol },
    };

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would execute Drift basis trade (spot side)', {
        market: rate.symbol,
        side: buySide ? 'buy spot' : 'sell spot',
        sol: amountSol.toFixed(3),
        perpAction: buySide ? 'short perp via Drift SDK' : 'long perp via Drift SDK',
      });
      return { opportunityId: opp.id, success: true, dryRun: true };
    }

    logger.warn('Drift live execution blocked: perp side is not wired, so no unhedged spot order was sent.', {
      market: rate.symbol,
      side: buySide ? 'buy spot + short perp' : 'sell spot + long perp',
    });

    return {
      opportunityId: opp.id,
      success: false,
      dryRun: false,
      errorMessage: 'Drift perp-side execution is not wired; live basis trade blocked',
    };
  }
}
