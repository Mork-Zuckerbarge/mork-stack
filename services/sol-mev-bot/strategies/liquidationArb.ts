import axios from 'axios';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { HeliusListener } from '../utils/heliusListener';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult } from '../types';
import { getJupiterQuote, getTokenBalanceRaw, sendJupiterSwapViaJito } from '../utils/jupiterSwap';

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_CACHE_TTL_MS = 30_000;
// Minimum price drop from cached baseline to trigger a recovery buy
const DEFAULT_DIP_THRESHOLD_PCT = 3.0;

interface CachedPrice {
  price: number; // price in USD from Jupiter
  cachedAt: number;
}

interface ActivePosition {
  mint: string;
  entryPriceUsd: number;
  peakPriceUsd: number;
  entryTime: number;
  amountSol: number;
}

/**
 * LiquidationArb listens for MarginFi/Kamino/Solend liquidation events via
 * Helius Geyser. Liquidations force-sell collateral which can temporarily move
 * pool prices below fair value. We buy the dip and exit via trailing stop.
 */
export class LiquidationArb {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;
  private helius: HeliusListener;

  private priceCache: Map<string, CachedPrice> = new Map();
  private activePositions: Map<string, ActivePosition> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;
  private readonly dipThresholdPct: number;
  private readonly cooldownMs = 60_000;

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
    this.dipThresholdPct = parseFloat(process.env.LIQUIDATION_DIP_THRESHOLD_PCT ?? String(DEFAULT_DIP_THRESHOLD_PCT));
  }

  start(): void {
    logger.info('LiquidationArb started', { dipThresholdPct: this.dipThresholdPct });
    this.helius.watchLendingProtocols();

    this.helius.on('liquidation', async (event: { program: string; signature: string; mint: string | null }) => {
      try {
        await this.handleLiquidationEvent(event);
      } catch (err) {
        logger.error('LiquidationArb: event handler error', { err });
      }
    });

    // Monitor open positions every 15s
    this.monitorInterval = setInterval(() => {
      this.monitorPositions().catch((err) =>
        logger.error('LiquidationArb: position monitor error', { err })
      );
    }, 15_000);
  }

  stop(): void {
    this.helius.removeAllListeners('liquidation');
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    logger.info('LiquidationArb stopped', { openPositions: this.activePositions.size });
  }

  private async handleLiquidationEvent(event: {
    program: string;
    signature: string;
    mint: string | null;
  }): Promise<void> {
    const mint = event.mint;
    if (!mint || mint === SOL_MINT) return;
    if (this.activePositions.has(mint)) return;

    // Cooldown: don't react to rapid successive liquidations on same token
    const coolUntil = this.cooldowns.get(mint) ?? 0;
    if (Date.now() < coolUntil) return;

    logger.debug('Liquidation event detected', {
      program: event.program.slice(0, 8),
      mint: mint.slice(0, 8),
      sig: event.signature.slice(0, 8),
    });

    // Get current and cached price to measure the dip
    const currentPrice = await this.fetchJupiterPrice(mint);
    if (!currentPrice) return;

    const cached = this.priceCache.get(mint);
    if (!cached || Date.now() - cached.cachedAt > 5 * 60_000) {
      // No recent baseline — set it and wait for the next event
      this.priceCache.set(mint, { price: currentPrice, cachedAt: Date.now() });
      return;
    }

    const dipPct = ((cached.price - currentPrice) / cached.price) * 100;

    if (dipPct < this.dipThresholdPct) {
      logger.debug('Liquidation dip below threshold', {
        mint: mint.slice(0, 8),
        dipPct: dipPct.toFixed(2),
        threshold: this.dipThresholdPct,
      });
      return;
    }

    logger.info('Liquidation dip detected — entering recovery position', {
      mint: mint.slice(0, 8),
      baselineUsd: cached.price.toFixed(6),
      currentUsd: currentPrice.toFixed(6),
      dipPct: dipPct.toFixed(2) + '%',
    });

    await this.enterPosition(mint, currentPrice);
    this.cooldowns.set(mint, Date.now() + this.cooldownMs);
  }

  private async enterPosition(mint: string, entryPriceUsd: number): Promise<void> {
    const amountSol = Math.min(this.config.maxPositionSol * 0.5, this.config.maxPositionSol);
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const quote = await getJupiterQuote(SOL_MINT, mint, amountLamports);
    if (!quote) return;

    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.LIQUIDATION_ARB,
      tokenIn: new PublicKey(SOL_MINT),
      tokenOut: new PublicKey(mint),
      amountIn: BigInt(amountLamports),
      expectedAmountOut: BigInt(parseInt(quote.outAmount)),
      grossProfitLamports: 0,
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: 0.7,
      expiresAt: Date.now() + 5000,
      meta: { mint, quote, entryPriceUsd },
    };

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would enter liquidation recovery position', {
        mint: mint.slice(0, 8),
        sol: amountSol.toFixed(3),
      });
      this.recordActivePosition(mint, entryPriceUsd, amountSol);
      return;
    }

    logger.info('Entering liquidation recovery position', { mint: mint.slice(0, 8), sol: amountSol });
    const result = await sendJupiterSwapViaJito({
      quote,
      connection: this.connection,
      wallet: this.wallet,
      jitoClient: this.jitoClient,
      urgency: 'high',
    });

    if (result.status !== 'landed') {
      logger.warn('Liquidation entry bundle did not land', { mint: mint.slice(0, 8), status: result.status });
      return;
    }

    this.recordActivePosition(mint, entryPriceUsd, amountSol);
  }

  private async monitorPositions(): Promise<void> {
    for (const [mint, pos] of this.activePositions.entries()) {
      const current = await this.fetchJupiterPrice(mint);
      if (!current) continue;

      this.priceCache.set(mint, { price: current, cachedAt: Date.now() });
      if (current > pos.peakPriceUsd) pos.peakPriceUsd = current;

      const drawdownPct = ((pos.peakPriceUsd - current) / pos.peakPriceUsd) * 100;
      const pnlPct = ((current - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const holdMin = (Date.now() - pos.entryTime) / 60_000;

      // Use momentum-style exit: 10% trailing stop, 20% hard stop, 20 min max hold
      const trailingStop = parseFloat(process.env.LIQUIDATION_TRAILING_STOP_PCT ?? '10');
      const hardStop = -20;
      const maxHoldMin = 20;

      const shouldExit =
        drawdownPct >= trailingStop ||
        pnlPct <= hardStop ||
        holdMin >= maxHoldMin;

      if (shouldExit) {
        const reason =
          drawdownPct >= trailingStop ? 'trailing stop' :
          pnlPct <= hardStop ? 'hard stop' : 'max hold';

        logger.info('Exiting liquidation recovery position', {
          mint: mint.slice(0, 8),
          reason,
          pnl: pnlPct.toFixed(2) + '%',
        });

        await this.exitPosition(mint, pos);
      }
    }
  }

  private async exitPosition(mint: string, pos: ActivePosition): Promise<ExecutionResult> {
    this.activePositions.delete(mint);

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would exit liquidation position', { mint: mint.slice(0, 8) });
      return { opportunityId: uuidv4(), success: true, dryRun: true };
    }

    const balance = await getTokenBalanceRaw(this.connection, this.wallet.publicKey, mint);
    if (!balance || balance.amount <= 0n) {
      return { opportunityId: uuidv4(), success: false, dryRun: false, errorMessage: 'No token balance to exit' };
    }

    const quote = await getJupiterQuote(mint, SOL_MINT, balance.amount);
    if (!quote) return { opportunityId: uuidv4(), success: false, dryRun: false, errorMessage: 'No Jupiter quote for exit' };

    logger.info('Executing liquidation exit', { mint: mint.slice(0, 8), tokenUiAmount: balance.uiAmount });
    const result = await sendJupiterSwapViaJito({
      quote,
      connection: this.connection,
      wallet: this.wallet,
      jitoClient: this.jitoClient,
      urgency: 'high',
    });

    return {
      opportunityId: uuidv4(),
      success: result.status === 'landed',
      dryRun: false,
      signature: result.bundleId || undefined,
      errorMessage: result.status === 'landed' ? undefined : `Bundle status: ${result.status}`,
    };
  }

  private recordActivePosition(mint: string, entryPriceUsd: number, amountSol: number): void {
    this.activePositions.set(mint, {
      mint,
      entryPriceUsd,
      peakPriceUsd: entryPriceUsd,
      entryTime: Date.now(),
      amountSol,
    });

    this.priceCache.set(mint, { price: entryPriceUsd, cachedAt: Date.now() });
  }

  private async fetchJupiterPrice(mint: string): Promise<number | null> {
    // Check cache first to avoid hammering the API
    const cached = this.priceCache.get(mint);
    if (cached && Date.now() - cached.cachedAt < PRICE_CACHE_TTL_MS) {
      return cached.price;
    }
    try {
      const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mint}`, { timeout: 2500 });
      const price = res.data?.data?.[mint]?.price ?? null;
      if (price != null) this.priceCache.set(mint, { price, cachedAt: Date.now() });
      return price;
    } catch {
      return null;
    }
  }
}
