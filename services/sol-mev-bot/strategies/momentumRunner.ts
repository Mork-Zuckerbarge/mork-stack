import axios from 'axios';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { HeliusListener } from '../utils/heliusListener';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BIRDEYE_API = 'https://public-api.birdeye.so/defi';

interface ActivePosition {
  mint: string;
  entryPriceSol: number;
  peakPriceSol: number;
  entryTime: number;
  amountSol: number;
  trailingStopPct: number;
}

interface TokenVolumeBaseline {
  mint: string;
  avgVol1m: number;       // average volume per minute
  lastUpdated: number;
}

/**
 * MomentumRunner detects volume spikes on Birdeye and pump.fun,
 * enters positions on confirmed runners, and exits via a trailing stop.
 *
 * Risk warning: This is the highest-risk strategy of the three.
 * Many apparent "runners" are wash-traded. The exit timing is critical.
 * Start with small positions (0.05–0.1 SOL) until you calibrate the params.
 */
export class MomentumRunner {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;
  private helius: HeliusListener;

  private volumeBaselines: Map<string, TokenVolumeBaseline> = new Map();
  private activePositions: Map<string, ActivePosition> = new Map();
  private watchlistMints: Set<string> = new Set();

  private scanning = false;
  private monitorInterval: NodeJS.Timeout | null = null;

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

  async start(): Promise<void> {
    logger.info('MomentumRunner started', {
      volMultiplier: this.config.momentumVolSpikeMultiplier,
      trailingStop: this.config.momentumTrailingStopPct + '%',
    });

    // Build initial volume baselines from Birdeye trending tokens
    await this.refreshWatchlist();

    this.scanning = true;

    // Scan for volume spikes every 10 seconds
    this.monitorInterval = setInterval(async () => {
      await this.scanForSpikes();
      await this.monitorPositions();
    }, 10_000);

    // Also listen for pump.fun launches if enabled
    if (this.config.watchPumpFun) {
      this.helius.watchPumpFun();
      this.helius.on('pumpfun_buy', (event: { signature: string; logs: string[] }) => {
        this.handlePumpFunBuy(event).catch((err) =>
          logger.error('pump.fun buy handler error', { err })
        );
      });
    }
  }

  stop(): void {
    this.scanning = false;
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.helius.removeAllListeners('pumpfun_buy');
    logger.info('MomentumRunner stopped', {
      openPositions: this.activePositions.size,
    });
  }

  private async refreshWatchlist(): Promise<void> {
    try {
      // Fetch trending tokens from Birdeye
      const res = await axios.get(`${BIRDEYE_API}/token_trending`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY ?? 'public' },
        params: { sort_by: 'v24hUSD', sort_type: 'desc', offset: 0, limit: 20 },
        timeout: 5000,
      });

      const tokens: Array<{ address: string; v1hUSD: number }> = res.data?.data?.tokens ?? [];

      for (const token of tokens) {
        this.watchlistMints.add(token.address);

        // Baseline: average 1m volume (estimated from 1h volume / 60)
        if (token.v1hUSD && !this.volumeBaselines.has(token.address)) {
          this.volumeBaselines.set(token.address, {
            mint: token.address,
            avgVol1m: token.v1hUSD / 60,
            lastUpdated: Date.now(),
          });
        }
      }

      logger.debug('Watchlist refreshed', { count: this.watchlistMints.size });
    } catch (err) {
      logger.warn('Failed to refresh watchlist from Birdeye', { err });
    }
  }

  private async scanForSpikes(): Promise<void> {
    if (!this.scanning) return;

    // Refresh watchlist every 5 minutes
    if (this.watchlistMints.size === 0 || Math.random() < 0.033) {
      await this.refreshWatchlist();
    }

    // Check current 1m volume for all watchlist tokens
    for (const mint of this.watchlistMints) {
      if (this.activePositions.has(mint)) continue; // already in position

      try {
        const current1mVol = await this.fetch1mVolume(mint);
        if (!current1mVol) continue;

        const baseline = this.volumeBaselines.get(mint);
        if (!baseline) {
          // No baseline yet — set it
          this.volumeBaselines.set(mint, { mint, avgVol1m: current1mVol, lastUpdated: Date.now() });
          continue;
        }

        const spikeMultiplier = current1mVol / baseline.avgVol1m;

        if (spikeMultiplier >= this.config.momentumVolSpikeMultiplier) {
          logger.info('Volume spike detected!', {
            mint: mint.slice(0, 8),
            spike: spikeMultiplier.toFixed(1) + 'x',
            vol1m: current1mVol.toFixed(0),
            baseline: baseline.avgVol1m.toFixed(0),
          });

          await this.enterPosition(mint, spikeMultiplier);
        }

        // Update rolling baseline (exponential moving average)
        baseline.avgVol1m = baseline.avgVol1m * 0.95 + current1mVol * 0.05;
        baseline.lastUpdated = Date.now();
      } catch {
        // swallow per-token errors
      }
    }
  }

  private async enterPosition(mint: string, spikeMultiplier: number): Promise<void> {
    // Scale position size with spike strength, but cap at maxPositionSol
    const positionSol = Math.min(
      this.config.maxPositionSol * Math.min(spikeMultiplier / 10, 1),
      this.config.maxPositionSol
    );

    const amountInLamports = Math.floor(positionSol * LAMPORTS_PER_SOL);

    // Get current price from Jupiter
    const entryPrice = await this.getPriceSol(mint);
    if (!entryPrice) return;

    // Get quote and check profitability
    const quote = await this.getJupiterQuote(SOL_MINT, mint, amountInLamports);
    if (!quote) return;

    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.MOMENTUM,
      tokenIn: new PublicKey(SOL_MINT),
      tokenOut: new PublicKey(mint),
      amountIn: BigInt(amountInLamports),
      expectedAmountOut: BigInt(parseInt(quote.outAmount as string)),
      grossProfitLamports: 0, // unknown at entry
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: Math.min(spikeMultiplier / 20, 1),
      expiresAt: Date.now() + 5000,
      meta: { mint, quote, spikeMultiplier, entryPrice },
    };

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would enter momentum position', {
        mint: mint.slice(0, 8),
        sol: positionSol.toFixed(3),
        spike: spikeMultiplier.toFixed(1) + 'x',
      });
    } else {
      // Execute buy via Jupiter + Jito bundle
      logger.info('Entering momentum position', { mint: mint.slice(0, 8), sol: positionSol });
    }

    // Record position for monitoring
    this.activePositions.set(mint, {
      mint,
      entryPriceSol: entryPrice,
      peakPriceSol: entryPrice,
      entryTime: Date.now(),
      amountSol: positionSol,
      trailingStopPct: this.config.momentumTrailingStopPct,
    });
  }

  private async monitorPositions(): Promise<void> {
    for (const [mint, pos] of this.activePositions.entries()) {
      const currentPrice = await this.getPriceSol(mint);
      if (!currentPrice) continue;

      // Update peak price
      if (currentPrice > pos.peakPriceSol) {
        pos.peakPriceSol = currentPrice;
      }

      const drawdownFromPeak = ((pos.peakPriceSol - currentPrice) / pos.peakPriceSol) * 100;
      const pnlPct = ((currentPrice - pos.entryPriceSol) / pos.entryPriceSol) * 100;
      const holdingMinutes = (Date.now() - pos.entryTime) / 60000;

      logger.debug('Position status', {
        mint: mint.slice(0, 8),
        pnl: pnlPct.toFixed(2) + '%',
        drawdown: drawdownFromPeak.toFixed(2) + '%',
        holdingMin: holdingMinutes.toFixed(1),
      });

      const shouldExit =
        drawdownFromPeak >= pos.trailingStopPct ||   // trailing stop triggered
        holdingMinutes >= 30 ||                       // max hold time
        pnlPct <= -20;                                // hard stop loss at -20%

      if (shouldExit) {
        const reason =
          drawdownFromPeak >= pos.trailingStopPct ? 'trailing stop' :
          holdingMinutes >= 30 ? 'max hold time' : 'stop loss';

        logger.info('Exiting momentum position', {
          mint: mint.slice(0, 8),
          reason,
          pnl: pnlPct.toFixed(2) + '%',
        });

        await this.exitPosition(mint, pos);
      }
    }
  }

  private async exitPosition(mint: string, pos: ActivePosition): Promise<void> {
    this.activePositions.delete(mint);

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would exit momentum position', { mint: mint.slice(0, 8) });
      return;
    }

    // Get token balance and sell all via Jupiter
    // Build exit transaction and send as Jito bundle
    logger.info('Executing exit', { mint: mint.slice(0, 8) });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async fetch1mVolume(mint: string): Promise<number | null> {
    try {
      const res = await axios.get(`${BIRDEYE_API}/ohlcv`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY ?? 'public' },
        params: { address: mint, type: '1m', time_from: Math.floor(Date.now() / 1000) - 60, time_to: Math.floor(Date.now() / 1000) },
        timeout: 3000,
      });
      const items: Array<{ v: number }> = res.data?.data?.items ?? [];
      return items.reduce((sum, i) => sum + (i.v ?? 0), 0);
    } catch {
      return null;
    }
  }

  private async getPriceSol(mint: string): Promise<number | null> {
    try {
      const res = await axios.get(`${BIRDEYE_API}/price`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY ?? 'public' },
        params: { address: mint },
        timeout: 3000,
      });
      return res.data?.data?.value ?? null;
    } catch {
      return null;
    }
  }

  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
        params: { inputMint, outputMint, amount, slippageBps: 100 },
        timeout: 3000,
      });
      return res.data;
    } catch {
      return null;
    }
  }

  private async handlePumpFunBuy(event: { signature: string; logs: string[] }): Promise<void> {
    // Parse mint address from pump.fun buy logs
    const mintMatch = event.logs.join('\n').match(/mint[:\s]+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (!mintMatch) return;

    const mint = mintMatch[1];
    if (this.activePositions.has(mint)) return;

    logger.debug('pump.fun buy detected', { mint: mint.slice(0, 8), sig: event.signature.slice(0, 8) });

    // Add to watchlist with elevated baseline
    this.watchlistMints.add(mint);
  }
}
