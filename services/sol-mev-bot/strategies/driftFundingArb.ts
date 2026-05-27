import axios from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  DriftClient,
  BN,
  PositionDirection,
  BASE_PRECISION,
  getMarketOrderParams,
} from '@drift-labs/sdk';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import { StatsTracker } from '../utils/statsTracker';
import { AgentConfig, Opportunity, StrategyType, ExecutionResult, JupiterQuote } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DRIFT_STATS_API = 'https://data.api.drift.trade';

// Markets to monitor — Drift perp market index + corresponding spot mint
// Only marketIndex 0 (SOL-PERP) gets full spot+perp execution; others get spot only.
const DRIFT_MARKETS = [
  { index: 0,  symbol: 'SOL',   spotMint: SOL_MINT },
  { index: 1,  symbol: 'BTC',   spotMint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' },
  { index: 2,  symbol: 'ETH',   spotMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { index: 3,  symbol: 'APT',   spotMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  { index: 4,  symbol: 'MATIC', spotMint: 'Gz7VkD4MacbEB6yC5XD3HcumEiYx2EtDYYrfikGsvopG' },
];

interface FundingRate {
  marketIndex: number;
  symbol: string;
  spotMint: string;
  fundingRatePctPerHour: number;
  direction: 'long' | 'short';
}

interface OpenPerpPosition {
  marketIndex: number;
  symbol: string;
  direction: PositionDirection;
  entryFundingRatePct: number;
  openedAt: number;
}

export class DriftFundingArb {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;
  private stats: StatsTracker;

  private driftClient: DriftClient | null = null;
  private openPerpPositions: Map<number, OpenPerpPosition> = new Map();

  private pollInterval: NodeJS.Timeout | null = null;
  private positionMonitorInterval: NodeJS.Timeout | null = null;
  private aliveInterval: NodeJS.Timeout | null = null;
  private readonly pollMs = 5 * 60_000;
  private readonly minFundingRatePct: number;
  private pollCount = 0;

  constructor(
    config: AgentConfig,
    connection: Connection,
    wallet: Keypair,
    feeSimulator: FeeSimulator,
    jitoClient: JitoClient,
    stats: StatsTracker,
  ) {
    this.config = config;
    this.connection = connection;
    this.wallet = wallet;
    this.feeSimulator = feeSimulator;
    this.jitoClient = jitoClient;
    this.stats = stats;
    this.minFundingRatePct = config.driftMinFundingRatePct;
  }

  start(): void {
    logger.info('DriftFundingArb started', {
      minFundingRatePct: this.minFundingRatePct,
      pollIntervalMin: this.pollMs / 60_000,
      markets: DRIFT_MARKETS.map((m) => m.symbol),
    });
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), this.pollMs);
    this.positionMonitorInterval = setInterval(() => this.monitorPerpPositions(), 60_000);
    this.aliveInterval = setInterval(() => {
      logger.info('DriftFundingArb alive', {
        polls: this.pollCount,
        openPerpPositions: this.openPerpPositions.size,
        positions: [...this.openPerpPositions.values()].map((p) => ({
          market: p.symbol,
          holdMin: Math.floor((Date.now() - p.openedAt) / 60_000),
        })),
      });
    }, 30 * 60_000);
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
    if (this.aliveInterval) clearInterval(this.aliveInterval);
    if (this.openPerpPositions.size > 0) {
      logger.info('DriftFundingArb: closing open perp positions on shutdown', {
        count: this.openPerpPositions.size,
      });
      for (const [marketIndex] of this.openPerpPositions) {
        this.closePerpPosition(marketIndex).catch((err) =>
          logger.error('Failed to close perp position on shutdown', { marketIndex, err })
        );
      }
    }
    this.driftClient?.unsubscribe().catch(() => {});
    logger.info('DriftFundingArb stopped');
  }

  private async initDrift(): Promise<DriftClient> {
    if (this.driftClient) return this.driftClient;

    const keypair = this.wallet;
    const walletAdapter = {
      publicKey: keypair.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
        } else {
          (tx as Transaction).sign(keypair);
        }
        return tx;
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
        for (const tx of txs) {
          if (tx instanceof VersionedTransaction) {
            tx.sign([keypair]);
          } else {
            (tx as Transaction).sign(keypair);
          }
        }
        return txs;
      },
    };

    const client = new DriftClient({
      connection: this.connection,
      wallet: walletAdapter,
      env: 'mainnet-beta',
    });

    await client.subscribe();

    // Initialize Drift user account if it doesn't exist yet
    const userKey = await client.getUserAccountPublicKey();
    const accountInfo = await this.connection.getAccountInfo(userKey);
    if (!accountInfo) {
      logger.info('DriftFundingArb: initializing Drift user account (first time)...');
      await client.initializeUserAccount();
      logger.info('DriftFundingArb: Drift user account initialized', { key: userKey.toString().slice(0, 8) });
    } else {
      logger.info('DriftFundingArb: Drift user account found', { key: userKey.toString().slice(0, 8) });
    }

    this.driftClient = client;
    return client;
  }

  private async poll(): Promise<void> {
    this.pollCount++;
    try {
      const rates = await this.fetchFundingRates();
      if (!rates.length) return;

      for (const rate of rates) {
        if (this.openPerpPositions.has(rate.marketIndex)) continue;
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
        const rawRate = Number(latest.fundingRate ?? latest.cumulativeFundingRateLong ?? 0);
        const fundingRatePctPerHour = (rawRate / 1e9) * 100;
        if (!Number.isFinite(fundingRatePctPerHour)) continue;

        rates.push({
          marketIndex: market.index,
          symbol: market.symbol,
          spotMint: market.spotMint,
          fundingRatePctPerHour,
          direction: fundingRatePctPerHour > 0 ? 'long' : 'short',
        });
      } catch {
        // skip silently
      }
    }
    return rates;
  }

  private async executeBasisTrade(rate: FundingRate): Promise<ExecutionResult | null> {
    // Positive funding → longs pay shorts → short perp + long spot
    // Negative funding → shorts pay longs → long perp + short spot
    const buySide = rate.direction === 'long';
    const perpDirection = buySide ? PositionDirection.SHORT : PositionDirection.LONG;
    const amountSol = this.config.maxPositionSol * 0.5;
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const id = uuidv4();

    const [inputMint, outputMint] = buySide
      ? [SOL_MINT, rate.spotMint]
      : [rate.spotMint, SOL_MINT];

    if (inputMint === outputMint) return null;

    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would execute Drift basis trade', {
        market: rate.symbol,
        spotSide: buySide ? 'buy spot' : 'sell spot',
        perpSide: buySide ? 'short perp' : 'long perp',
        sol: amountSol.toFixed(3),
        ratePctHour: rate.fundingRatePctPerHour.toFixed(4) + '%',
      });
      const result: ExecutionResult = { opportunityId: id, success: true, dryRun: true };
      this.stats.record(result, StrategyType.DRIFT_FUNDING);
      return result;
    }

    // ── Spot side: execute via Jupiter + Jito ───────────────────────────────
    logger.info('DriftFundingArb: executing spot side', {
      market: rate.symbol,
      side: buySide ? 'buy' : 'sell',
      sol: amountSol.toFixed(3),
    });

    const quote = await this.getQuote(inputMint, outputMint, amountLamports);
    if (!quote) {
      logger.warn('DriftFundingArb: Jupiter quote failed', { market: rate.symbol });
      return { opportunityId: id, success: false, dryRun: false, errorMessage: 'Jupiter quote failed' };
    }

    const swapInstructions = await this.getSwapInstructions(quote);
    if (!swapInstructions) {
      logger.warn('DriftFundingArb: swap instructions failed', { market: rate.symbol });
      return { opportunityId: id, success: false, dryRun: false, errorMessage: 'Swap instructions failed' };
    }

    const tip = await this.jitoClient.computeDynamicTip('medium');
    const spotTx = await this.jitoClient.buildSignedTransaction(swapInstructions, true, tip);
    const bundleResult = await this.jitoClient.sendBundle([spotTx], tip);

    if (bundleResult.status !== 'landed') {
      logger.warn('DriftFundingArb: spot bundle failed', {
        market: rate.symbol,
        status: bundleResult.status,
      });
      const result: ExecutionResult = { opportunityId: id, success: false, dryRun: false, errorMessage: `Bundle: ${bundleResult.status}` };
      this.stats.record(result, StrategyType.DRIFT_FUNDING);
      return result;
    }

    logger.info('DriftFundingArb: spot side landed', {
      market: rate.symbol,
      bundleId: bundleResult.bundleId,
    });

    // ── Perp side: Drift SDK ─────────────────────────────────────────────────
    // Non-SOL markets: spot-only for now (perp sizing requires price conversion)
    if (rate.marketIndex !== 0) {
      logger.info('DriftFundingArb: perp side skipped for non-SOL market (spot hedge only)', {
        market: rate.symbol,
      });
      const result: ExecutionResult = { opportunityId: id, success: true, dryRun: false, signature: bundleResult.bundleId };
      this.stats.record(result, StrategyType.DRIFT_FUNDING);
      return result;
    }

    try {
      const drift = await this.initDrift();
      // BASE_PRECISION for SOL-PERP is 1e9 (matches SOL lamport precision)
      const baseAmount = new BN(Math.floor(amountSol * BASE_PRECISION.toNumber()));

      const orderParams = getMarketOrderParams({
        marketIndex: rate.marketIndex,
        direction: perpDirection,
        baseAssetAmount: baseAmount,
      });

      const perpSig = await drift.placePerpOrder(orderParams);
      logger.info('DriftFundingArb: perp order placed', {
        market: rate.symbol,
        direction: buySide ? 'short' : 'long',
        baseAmount: amountSol.toFixed(3),
        sig: perpSig.slice(0, 8),
      });

      this.openPerpPositions.set(rate.marketIndex, {
        marketIndex: rate.marketIndex,
        symbol: rate.symbol,
        direction: perpDirection,
        entryFundingRatePct: rate.fundingRatePctPerHour,
        openedAt: Date.now(),
      });

      const result: ExecutionResult = { opportunityId: id, success: true, dryRun: false, signature: perpSig };
      this.stats.record(result, StrategyType.DRIFT_FUNDING);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('DriftFundingArb: perp order failed', { market: rate.symbol, err: msg });
      const result: ExecutionResult = { opportunityId: id, success: false, dryRun: false, errorMessage: `Perp: ${msg}` };
      this.stats.record(result, StrategyType.DRIFT_FUNDING);
      return result;
    }
  }

  private async monitorPerpPositions(): Promise<void> {
    if (this.openPerpPositions.size === 0) return;

    let currentRates: FundingRate[];
    try {
      currentRates = await this.fetchFundingRates();
    } catch {
      return;
    }

    const rateMap = new Map(currentRates.map((r) => [r.marketIndex, r]));
    const maxHoldMs = 8 * 60 * 60_000; // 8-hour max hold

    for (const [marketIndex, pos] of this.openPerpPositions.entries()) {
      const currentRate = rateMap.get(marketIndex);
      const holdMs = Date.now() - pos.openedAt;

      // Close when funding normalizes to < 50% of threshold, or max hold reached
      const fundingNormalized = currentRate &&
        Math.abs(currentRate.fundingRatePctPerHour) < this.minFundingRatePct * 0.5;
      const maxHoldReached = holdMs >= maxHoldMs;

      if (fundingNormalized || maxHoldReached) {
        const reason = maxHoldReached ? 'max hold reached' : 'funding normalized';
        logger.info('DriftFundingArb: closing perp position', {
          market: pos.symbol,
          reason,
          holdHr: (holdMs / 3_600_000).toFixed(1),
          entryRatePct: pos.entryFundingRatePct.toFixed(4),
          currentRatePct: currentRate?.fundingRatePctPerHour.toFixed(4) ?? 'unknown',
        });
        await this.closePerpPosition(marketIndex);
      }
    }
  }

  private async closePerpPosition(marketIndex: number): Promise<void> {
    const pos = this.openPerpPositions.get(marketIndex);
    if (!pos) return;
    this.openPerpPositions.delete(marketIndex);
    if (this.config.dryRun) return;
    try {
      const drift = await this.initDrift();
      const sig = await drift.closePosition(marketIndex);
      logger.info('DriftFundingArb: perp position closed', {
        market: pos.symbol,
        sig: sig.slice(0, 8),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('DriftFundingArb: failed to close perp position', { market: pos.symbol, err: msg });
    }
  }

  // ── Jupiter helpers ───────────────────────────────────────────────────────

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps = 75
  ): Promise<JupiterQuote | null> {
    try {
      const res = await axios.get(`${JUPITER_API}/quote`, {
        params: { inputMint, outputMint, amount, slippageBps, asLegacyTransaction: false },
        timeout: 3000,
      });
      return res.data as JupiterQuote;
    } catch {
      return null;
    }
  }

  private async getSwapInstructions(quote: JupiterQuote): Promise<TransactionInstruction[] | null> {
    try {
      const res = await axios.post(
        `${JUPITER_API}/swap-instructions`,
        {
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: 0,
        },
        { timeout: 5000 }
      );
      const data = res.data as {
        setupInstructions?: SerializedInstruction[];
        swapInstruction: SerializedInstruction;
        cleanupInstruction?: SerializedInstruction;
      };
      const instructions: TransactionInstruction[] = [];
      if (data.setupInstructions) instructions.push(...data.setupInstructions.map(deserializeInstruction));
      instructions.push(deserializeInstruction(data.swapInstruction));
      if (data.cleanupInstruction) instructions.push(deserializeInstruction(data.cleanupInstruction));
      return instructions;
    } catch {
      return null;
    }
  }
}

interface SerializedInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

function deserializeInstruction(ix: SerializedInstruction): TransactionInstruction {
  return {
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  };
}
