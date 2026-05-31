import axios from 'axios';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult } from '../types';
import { getJupiterQuote, getTokenBalanceRaw, sendJupiterSwapViaJito } from '../utils/jupiterSwap';

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Monitored stablecoins with their on-chain Solana mint addresses
const STABLECOINS = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
  { mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD' },
];

const PEG = 1.0; // all monitored stablecoins target $1.00

/**
 * StablecoinDepeg monitors USDC/USDT/PYUSD on-chain prices via Jupiter.
 * When a stablecoin deviates from $1.00 by more than the threshold:
 *   Under-peg (price < $1.00 - threshold): buy with SOL — it should repeg
 *   Over-peg  (price > $1.00 + threshold): sell for SOL — overvalued
 *
 * Depeg events on Solana are rare but fast-moving; the cooldown prevents
 * chasing a cascading depeg that won't recover quickly.
 */
export class StablecoinDepeg {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;

  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollMs = 30_000;
  private readonly thresholdPct: number;
  private cooldowns: Map<string, number> = new Map();
  private readonly cooldownMs = 5 * 60_000; // 5 min between trades per stable

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
    this.thresholdPct = config.stablecoinDepegThresholdPct;
  }

  start(): void {
    logger.info('StablecoinDepeg started', {
      stablecoins: STABLECOINS.map((s) => s.symbol),
      thresholdPct: this.thresholdPct,
      pollSec: this.pollMs / 1000,
    });
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    logger.info('StablecoinDepeg stopped');
  }

  private async poll(): Promise<void> {
    const mints = STABLECOINS.map((s) => s.mint).join(',');
    let prices: Record<string, number>;

    try {
      const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mints}`, { timeout: 4000 });
      prices = Object.fromEntries(
        Object.entries(res.data?.data ?? {}).map(([mint, d]) => [mint, (d as { price: number }).price])
      );
    } catch {
      return;
    }

    for (const stable of STABLECOINS) {
      const price = prices[stable.mint];
      if (!Number.isFinite(price)) continue;

      const deviation = ((price - PEG) / PEG) * 100; // negative = under-peg
      const absDev = Math.abs(deviation);

      if (absDev < this.thresholdPct) continue;

      const coolUntil = this.cooldowns.get(stable.mint) ?? 0;
      if (Date.now() < coolUntil) continue;

      logger.info('Stablecoin depeg detected', {
        symbol: stable.symbol,
        price: price.toFixed(6),
        deviationPct: deviation.toFixed(4) + '%',
        action: deviation < 0 ? 'buy (under-peg — expect recovery)' : 'sell (over-peg — overvalued)',
      });

      this.cooldowns.set(stable.mint, Date.now() + this.cooldownMs);
      await this.executeTrade(stable, price, deviation < 0);
    }
  }

  private async executeTrade(
    stable: { mint: string; symbol: string },
    currentPrice: number,
    isBuy: boolean // true = buy stable with SOL (under-peg), false = sell stable for SOL (over-peg)
  ): Promise<ExecutionResult> {
    const amountSol = this.config.maxPositionSol * 0.5;
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const solPrice = await this.fetchSolPrice();

    let inputMint = SOL_MINT;
    let outputMint = stable.mint;
    let amountIn: number | bigint = amountLamports;

    if (!isBuy) {
      const stableBalance = await getTokenBalanceRaw(this.connection, this.wallet.publicKey, stable.mint);
      if (!stableBalance || stableBalance.amount <= 0n) {
        return { opportunityId: uuidv4(), success: false, dryRun: this.config.dryRun, errorMessage: `No ${stable.symbol} balance to sell` };
      }

      if (!solPrice) {
        return { opportunityId: uuidv4(), success: false, dryRun: this.config.dryRun, errorMessage: 'Missing SOL price for stable sell sizing' };
      }

      const desiredUi = (amountSol * solPrice) / currentPrice;
      const desiredRaw = BigInt(Math.max(1, Math.floor(desiredUi * 10 ** stableBalance.decimals)));
      amountIn = desiredRaw < stableBalance.amount ? desiredRaw : stableBalance.amount;
      inputMint = stable.mint;
      outputMint = SOL_MINT;
    }

    const id = uuidv4();

    // Simple profitability check: expected repeg profit vs fees
    // For a 0.5 SOL buy of a 0.5%-depegged stable, gross ≈ 0.5% * 0.5 SOL = 0.0025 SOL
    const grossEstimateLamports = solPrice
      ? Math.floor((Math.abs(currentPrice - PEG) / currentPrice) * amountLamports)
      : 0;

    const opp: Opportunity = {
      id,
      strategy: StrategyType.STABLECOIN_DEPEG,
      tokenIn: new PublicKey(inputMint),
      tokenOut: new PublicKey(outputMint),
      amountIn: BigInt(amountIn),
      expectedAmountOut: BigInt(0),
      grossProfitLamports: grossEstimateLamports,
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: 0.75,
      expiresAt: Date.now() + 10_000,
      meta: { stable, currentPrice, isBuy, amountSol },
    };

    const fees = this.feeSimulator.simulate(opp);
    if (!fees.isProfitable) {
      logger.debug('Stablecoin depeg trade not profitable after fees', {
        symbol: stable.symbol,
        gross: grossEstimateLamports,
        fees: fees.totalFeeLamports,
      });
      return { opportunityId: id, success: false, dryRun: false, errorMessage: 'not profitable after fees' };
    }

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would execute stablecoin depeg trade', {
        symbol: stable.symbol,
        side: isBuy ? 'buy' : 'sell',
        sol: amountSol.toFixed(3),
        price: currentPrice.toFixed(6),
      });
      return { opportunityId: id, success: true, dryRun: true };
    }

    const quote = await getJupiterQuote(inputMint, outputMint, amountIn);
    if (!quote) return { opportunityId: id, success: false, dryRun: false, errorMessage: 'No Jupiter quote' };

    logger.info('Executing stablecoin depeg trade', {
      symbol: stable.symbol,
      side: isBuy ? 'buy' : 'sell',
    });

    const result = await sendJupiterSwapViaJito({
      quote,
      connection: this.connection,
      wallet: this.wallet,
      jitoClient: this.jitoClient,
      urgency: 'high',
    });

    return {
      opportunityId: id,
      success: result.status === 'landed',
      dryRun: false,
      signature: result.bundleId || undefined,
      errorMessage: result.status === 'landed' ? undefined : `Bundle status: ${result.status}`,
    };
  }

  private async fetchSolPrice(): Promise<number | null> {
    try {
      const res = await axios.get(
        `https://price.jup.ag/v6/price?ids=${SOL_MINT}`,
        { timeout: 2000 }
      );
      return res.data?.data?.[SOL_MINT]?.price ?? null;
    } catch {
      return null;
    }
  }
}
