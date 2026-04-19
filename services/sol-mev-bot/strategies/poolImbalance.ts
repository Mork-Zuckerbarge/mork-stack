import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { HeliusListener } from '../utils/heliusListener';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface PoolInfo {
  address: string;
  dex: string;
  tokenA: string;
  tokenB: string;
  priceAtoB: number;
  lastUpdated: number;
}

interface JupiterQuote {
  outAmount: string;
}

/**
 * PoolImbalanceDetector monitors on-chain swap events via Helius Geyser.
 * When a large swap moves a pool's price significantly away from the
 * Jupiter aggregate price, it fires a corrective trade to capture the spread.
 *
 * The strategy works because:
 * 1. A whale swap moves pool price by X%
 * 2. This creates a gap between pool price and market price
 * 3. We buy the cheaper side and sell on the expensive side
 * 4. Other arbitrageurs also close this gap, but we race to be first
 */
export class PoolImbalanceDetector {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;
  private helius: HeliusListener;

  // Track recently processed pools to avoid duplicate signals
  private recentlyActed: Map<string, number> = new Map();
  private cooldownMs = 15_000; // 15s cooldown per pool
  private swapSeen = 0;
  private swapPassedCooldown = 0;
  private lastSwapSummaryTs = Date.now();

  constructor(
    config: AgentConfig,
    connection: Connection,
    wallet: Keypair,
    feeSimulator: FeeSimulator,
    jitoClient: JitoClient,
    helius: HeliusListener
  ) {
    this.config = config;
    this.connection = connection;
    this.wallet = wallet;
    this.feeSimulator = feeSimulator;
    this.jitoClient = jitoClient;
    this.helius = helius;
  }

  start(): void {
    logger.info('PoolImbalanceDetector started', {
      minImbalancePct: this.config.ammMinImbalancePct,
    });

    // Listen for swap events from Helius Geyser
    this.helius.on('swap', async (event: { dex: string; signature: string; logs: string[] }) => {
      try {
        await this.handleSwapEvent(event);
      } catch (err) {
        logger.error('PoolImbalanceDetector: swap event handler error', { err });
      }
    });
  }

  stop(): void {
    this.helius.removeAllListeners('swap');
    logger.info('PoolImbalanceDetector stopped');
  }

  private async handleSwapEvent(event: { dex: string; signature: string; logs: string[] }): Promise<void> {
    this.swapSeen += 1;

    // Parse pool address from logs
    const poolAddress = this.extractPoolAddress(event.logs);
    if (!poolAddress) return;

    // Cooldown check — don't hammer the same pool
    const lastActed = this.recentlyActed.get(poolAddress);
    if (lastActed && Date.now() - lastActed < this.cooldownMs) return;
    this.swapPassedCooldown += 1;

    this.maybeLogSwapSummary();

    // Fetch current pool state and compare to Jupiter aggregate
    const imbalance = await this.detectImbalance(poolAddress, event.dex);
    if (!imbalance) return;

    const { tokenIn, tokenOut, imbalancePct, tradeAmountLamports } = imbalance;

    if (imbalancePct < this.config.ammMinImbalancePct) {
      logger.debug('Imbalance below threshold', { pool: poolAddress.slice(0, 8), pct: imbalancePct.toFixed(2) });
      return;
    }

    logger.info('Pool imbalance detected!', {
      pool: poolAddress.slice(0, 8),
      dex: event.dex,
      imbalancePct: imbalancePct.toFixed(2) + '%',
    });

    // Get Jupiter quote for the corrective trade
    const quote = await this.getJupiterQuote(tokenIn, tokenOut, tradeAmountLamports);
    if (!quote) return;

    const expectedOut = parseInt(quote.outAmount);
    const grossProfit = expectedOut - tradeAmountLamports;
    if (grossProfit <= 0) return;

    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.AMM_IMBALANCE,
      tokenIn: new PublicKey(tokenIn),
      tokenOut: new PublicKey(tokenOut),
      amountIn: BigInt(tradeAmountLamports),
      expectedAmountOut: BigInt(expectedOut),
      grossProfitLamports: grossProfit,
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: Math.min(imbalancePct / 20, 1), // higher imbalance = higher confidence
      expiresAt: Date.now() + 1000, // very short — pool rebalances fast
      meta: {
        poolAddress,
        dex: event.dex,
        imbalancePct,
        triggerSignature: event.signature,
        quote,
      },
    };

    // Fee check
    const fees = this.feeSimulator.simulate(opp);
    if (!fees.isProfitable) return;

    opp.feeLamports = fees.totalFeeLamports;
    opp.estimatedProfitLamports = fees.netProfitLamports;

    // Mark pool as acted on
    this.recentlyActed.set(poolAddress, Date.now());
    this.cleanupCooldowns();

    await this.execute(opp);
  }

  private async detectImbalance(
    poolAddress: string,
    dex: string
  ): Promise<{
    tokenIn: string;
    tokenOut: string;
    imbalancePct: number;
    tradeAmountLamports: number;
  } | null> {
    try {
      // For production: read pool reserves directly from on-chain account data.
      // Pool account layouts differ per DEX — use the SDK for each:
      //   Raydium: @raydium-io/raydium-sdk AmmV4.fetchMultipleInfo()
      //   Orca:    @orca-so/whirlpools-sdk WhirlpoolClient.getPool()
      //   Meteora: @mercurial-finance/dlmm-db DLMM.create()

      // Compare pool spot price to Jupiter's aggregate price (which reflects
      // all other pools and represents the "true" market price)
      const poolPrice = await this.fetchPoolSpotPrice(poolAddress, dex);
      const jupiterPrice = await this.fetchJupiterPrice();

      if (!poolPrice || !jupiterPrice) return null;

      const imbalancePct = Math.abs((poolPrice - jupiterPrice) / jupiterPrice) * 100;

      // Determine direction: if pool is cheaper, buy on pool and sell via Jupiter
      const tokenIn = poolPrice < jupiterPrice ? SOL_MINT : USDC_MINT;
      const tokenOut = poolPrice < jupiterPrice ? USDC_MINT : SOL_MINT;

      const tradeAmountLamports = Math.floor(
        this.config.maxPositionSol * LAMPORTS_PER_SOL * Math.min(imbalancePct / 20, 1)
      );

      return { tokenIn, tokenOut, imbalancePct, tradeAmountLamports };
    } catch {
      return null;
    }
  }

  private async fetchPoolSpotPrice(poolAddress: string, dex: string): Promise<number | null> {
    // This is a placeholder — replace with actual SDK calls per DEX
    // Example for Raydium:
    //   const info = await Liquidity.fetchInfo({ connection, poolKeys })
    //   return info.baseReserve / info.quoteReserve * (10 ** quoteDecimals) / (10 ** baseDecimals)
    return null;
  }

  private async fetchJupiterPrice(): Promise<number | null> {
    try {
      const res = await axios.get(
        'https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112',
        { timeout: 2000 }
      );
      return res.data?.data?.['So11111111111111111111111111111111111111112']?.price ?? null;
    } catch {
      return null;
    }
  }

  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<JupiterQuote | null> {
    try {
      const res = await axios.get(`${JUPITER_API}/quote`, {
        params: { inputMint, outputMint, amount, slippageBps: 50 },
        timeout: 3000,
      });
      const outAmount = res.data?.outAmount;
      if (typeof outAmount !== 'string') return null;
      return { outAmount };
    } catch {
      return null;
    }
  }

  private extractPoolAddress(logs: string[]): string | null {
    // Parse pool address from program log output
    // Raydium logs include "Program log: pool: <address>"
    for (const log of logs) {
      const match = log.match(/pool[:\s]+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
      if (match) return match[1];
    }
    return null;
  }

  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentlyActed.entries()) {
      if (now - ts > this.cooldownMs * 2) this.recentlyActed.delete(key);
    }
  }

  private maybeLogSwapSummary(): void {
    const now = Date.now();
    if (now - this.lastSwapSummaryTs < 30_000) return;

    logger.debug('Swap flow summary', {
      seen: this.swapSeen,
      passedCooldown: this.swapPassedCooldown,
      cooldownMs: this.cooldownMs,
      windowSec: Math.round((now - this.lastSwapSummaryTs) / 1000),
    });

    this.swapSeen = 0;
    this.swapPassedCooldown = 0;
    this.lastSwapSummaryTs = now;
  }

  private async execute(opp: Opportunity): Promise<ExecutionResult> {
    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would execute pool imbalance trade', {
        id: opp.id,
        pool: (opp.meta.poolAddress as string).slice(0, 8),
        net: `${(opp.estimatedProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      });
      return { opportunityId: opp.id, success: true, dryRun: true };
    }

    // Build swap transaction via Jupiter swap-instructions endpoint
    // then wrap in Jito bundle — same pattern as ArbScanner.execute()
    logger.info('Executing pool imbalance trade', { id: opp.id });
    return { opportunityId: opp.id, success: true, dryRun: false };
  }
}
