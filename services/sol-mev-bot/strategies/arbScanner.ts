import axios from 'axios';
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { FeeSimulator } from '../utils/feeSimulator';
import { JitoClient } from '../utils/jitoClient';
import {
  AgentConfig,
  JupiterQuote,
  Opportunity,
  StrategyType,
  ExecutionResult,
} from '../types';

const JUPITER_API = 'https://quote-api.jup.ag/v6';
const LAMPORTS_PER_SOL = 1_000_000_000;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Candidate intermediary tokens for triangular routes (SOL → B → TOKEN → SOL).
// SOL_MINT is included for completeness but filtered out at scan time since it
// can't serve as an intermediary when SOL is already the base currency.
const TRIANGULAR_INTERMEDIARIES = [
  { mint: SOL_MINT,                                               symbol: 'SOL'  },
  { mint: USDC_MINT,                                              symbol: 'USDC' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',       symbol: 'USDT' },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',      symbol: 'ETH'  },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',        symbol: 'JUP'  },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',      symbol: 'BONK' },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',        symbol: 'bSOL' },
];

/**
 * ArbScanner finds profitable circular routes using Jupiter's aggregator.
 *
 * Strategy: For each monitored token, get a quote for SOL → TOKEN → SOL.
 * If outAmount > inAmount after fees, execute the arbitrage.
 *
 * Jupiter already checks all DEXes (Raydium, Orca, Meteora, Phoenix, etc.)
 * so a single quote call covers the entire Solana DEX landscape.
 */
export class ArbScanner {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private feeSimulator: FeeSimulator;
  private jitoClient: JitoClient;
  private scanning = false;
  private scanIntervalMs = 500; // scan every 500ms
  private dynamicUniverseMints: string[] = [];
  private dynamicUniverseLastFetchedAt = 0;

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
  }

  start(): void {
    if (this.scanning) return;
    this.scanning = true;
    logger.info('ArbScanner started', {
      configuredTokens: this.config.arbTokenMints.length,
      openUniverse: this.config.arbTokenMints.includes('ALL') || this.config.arbTokenMints.includes('*'),
    });
    this.scanLoop();
  }

  stop(): void {
    this.scanning = false;
    logger.info('ArbScanner stopped');
  }

  private async scanLoop(): Promise<void> {
    while (this.scanning) {
      try {
        await this.scanAllTokens();
      } catch (err) {
        logger.error('ArbScanner loop error', { err });
      }
      await sleep(this.scanIntervalMs);
    }
  }

  private async scanAllTokens(): Promise<void> {
    const mintsToScan = await this.getScanMints();
    const tokenMints = mintsToScan.filter((mint: string) => mint !== SOL_MINT);

    const scans: Promise<void>[] = tokenMints.map((mint: string) => this.scanCircularRoute(mint));

    if (this.config.enableTriangularArb) {
      for (const mint of tokenMints) {
        for (const inter of TRIANGULAR_INTERMEDIARIES) {
          // Skip: SOL can't be an intermediary when SOL is already the base currency
          if (inter.mint === SOL_MINT || inter.mint === mint) continue;
          scans.push(this.scanTriangularRoute(mint, inter));
        }
      }
    }

    await Promise.allSettled(scans);
  }

  private async getScanMints(): Promise<string[]> {
    const openUniverse = this.config.arbTokenMints.includes('ALL') || this.config.arbTokenMints.includes('*');
    if (!openUniverse) {
      return this.config.arbTokenMints;
    }

    const now = Date.now();
    const universeCacheMs = 5 * 60_000;
    if (this.dynamicUniverseMints.length > 0 && (now - this.dynamicUniverseLastFetchedAt) < universeCacheMs) {
      return this.dynamicUniverseMints;
    }

    const discovered = await this.fetchTradableMints();
    if (discovered.length > 0) {
      this.dynamicUniverseMints = discovered;
      this.dynamicUniverseLastFetchedAt = now;
      logger.debug('Refreshed open token universe', { tradableCount: discovered.length });
    }

    return this.dynamicUniverseMints;
  }

  // ── Circular route: SOL → TOKEN → SOL ────────────────────────────────────
  private async scanCircularRoute(tokenMint: string): Promise<void> {
    const amountInLamports = Math.floor(
      this.config.maxPositionSol * LAMPORTS_PER_SOL
    );

    // ── Circular route ─────────────────────────────────────────────────────
    const [outQuote, backQuote] = await Promise.all([
      this.getQuote(SOL_MINT, tokenMint, amountInLamports),
      null, // we use the round-trip quote below
    ]);

    if (!outQuote) return;

    const tokenAmount = parseInt(outQuote.outAmount);

    // Get quote back to SOL
    const roundTripQuote = await this.getQuote(tokenMint, SOL_MINT, tokenAmount);
    if (!roundTripQuote) return;

    const finalSolAmount = parseInt(roundTripQuote.outAmount);
    const grossProfitLamports = finalSolAmount - amountInLamports;

    if (grossProfitLamports <= 0) return;

    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.ARBITRAGE,
      tokenIn: new PublicKey(SOL_MINT),
      tokenOut: new PublicKey(SOL_MINT),
      amountIn: BigInt(amountInLamports),
      expectedAmountOut: BigInt(finalSolAmount),
      grossProfitLamports,
      estimatedProfitLamports: 0, // set after fee sim
      feeLamports: 0,
      confidence: 0.9,
      expiresAt: Date.now() + 2000, // stale after 2s
      meta: {
        tokenMint,
        outQuote,
        roundTripQuote,
        route: `SOL → ${tokenMint.slice(0, 6)} → SOL`,
      },
    };

    await this.evaluateAndExecute(opp);
  }

  // ── Triangular route: SOL → B → TOKEN → SOL ──────────────────────────────
  private async scanTriangularRoute(
    tokenMint: string,
    inter: { mint: string; symbol: string }
  ): Promise<void> {
    const amountInLamports = Math.floor(this.config.maxPositionSol * LAMPORTS_PER_SOL);

    const leg1 = await this.getQuote(SOL_MINT, inter.mint, amountInLamports);
    if (!leg1) return;

    const interAmount = parseInt(leg1.outAmount);
    const leg2 = await this.getQuote(inter.mint, tokenMint, interAmount);
    if (!leg2) return;

    const tokenAmount = parseInt(leg2.outAmount);
    const leg3 = await this.getQuote(tokenMint, SOL_MINT, tokenAmount);
    if (!leg3) return;

    const finalSol = parseInt(leg3.outAmount);
    const grossProfitLamports = finalSol - amountInLamports;
    if (grossProfitLamports <= 0) return;

    const route = `SOL → ${inter.symbol} → ${tokenMint.slice(0, 6)} → SOL`;
    const opp: Opportunity = {
      id: uuidv4(),
      strategy: StrategyType.TRIANGULAR_ARB,
      tokenIn: new PublicKey(SOL_MINT),
      tokenOut: new PublicKey(SOL_MINT),
      amountIn: BigInt(amountInLamports),
      expectedAmountOut: BigInt(finalSol),
      grossProfitLamports,
      estimatedProfitLamports: 0,
      feeLamports: 0,
      confidence: 0.85,
      expiresAt: Date.now() + 1500,
      meta: { tokenMint, interMint: inter.mint, leg1, leg2, leg3, route },
    };

    await this.evaluateAndExecute(opp);
  }

  private async evaluateAndExecute(opp: Opportunity): Promise<void> {
    // Check expiry
    if (Date.now() > opp.expiresAt) {
      logger.debug('Opportunity expired before evaluation', { id: opp.id });
      return;
    }

    // Fee simulation — abort if not profitable
    const fees = this.feeSimulator.simulate(opp);
    if (!fees.isProfitable) return;

    opp.feeLamports = fees.totalFeeLamports;
    opp.estimatedProfitLamports = fees.netProfitLamports;

    logger.info('ARB opportunity found', {
      id: opp.id,
      route: opp.meta.route,
      gross: `${(opp.grossProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      net: `${(fees.netProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
    });

    await this.execute(opp);
  }

  private async execute(opp: Opportunity): Promise<ExecutionResult> {
    try {
      if (this.config.dryRun) {
        logger.info('[DRY RUN] Would execute ARB', {
          id: opp.id,
          route: opp.meta.route ?? `${opp.strategy}`,
          net: `${(opp.estimatedProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        });
        return { opportunityId: opp.id, success: true, dryRun: true };
      }

      let transactions;

      if (opp.strategy === StrategyType.TRIANGULAR_ARB) {
        // Three-leg triangular: each leg is a separate tx in the Jito bundle (atomic)
        const [ix1, ix2, ix3] = await Promise.all([
          this.getSwapInstructions(opp.meta.leg1 as JupiterQuote),
          this.getSwapInstructions(opp.meta.leg2 as JupiterQuote),
          this.getSwapInstructions(opp.meta.leg3 as JupiterQuote),
        ]);
        if (!ix1 || !ix2 || !ix3) {
          return { opportunityId: opp.id, success: false, dryRun: false, errorMessage: 'Failed to get triangular swap instructions' };
        }
        const tip = await this.jitoClient.computeDynamicTip('high');
        transactions = await Promise.all([
          this.jitoClient.buildSignedTransaction(ix1, false),
          this.jitoClient.buildSignedTransaction(ix2, false),
          this.jitoClient.buildSignedTransaction(ix3, true, tip),
        ]);
      } else {
        // Standard two-leg circular: both legs in one transaction
        const leg1Instructions = await this.getSwapInstructions(opp.meta.outQuote as JupiterQuote);
        const leg2Instructions = await this.getSwapInstructions(opp.meta.roundTripQuote as JupiterQuote);
        if (!leg1Instructions || !leg2Instructions) {
          return { opportunityId: opp.id, success: false, dryRun: false, errorMessage: 'Failed to get swap instructions' };
        }
        const tx = await this.jitoClient.buildSignedTransaction([...leg1Instructions, ...leg2Instructions], true);
        transactions = [tx];
      }

      const result = await this.jitoClient.sendBundle(transactions);

      if (result.status === 'landed') {
        logger.info('ARB executed successfully', {
          id: opp.id,
          bundleId: result.bundleId,
          slot: result.slot,
          profit: `${(opp.estimatedProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        });
        return { opportunityId: opp.id, success: true, dryRun: false, netProfitLamports: opp.estimatedProfitLamports };
      }

      return { opportunityId: opp.id, success: false, dryRun: false, errorMessage: `Bundle status: ${result.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('ARB execution error', { id: opp.id, err: msg });
      return { opportunityId: opp.id, success: false, dryRun: false, errorMessage: msg };
    }
  }

  // ── Jupiter API calls ────────────────────────────────────────────────────


  private async fetchTradableMints(): Promise<string[]> {
    try {
      const res = await axios.get('https://token.jup.ag/all', { timeout: 5000 });
      const tokens = Array.isArray(res.data) ? res.data : [];
      return tokens
        .map((t: { address?: string }) => t.address)
        .filter((mint: string | undefined): mint is string => Boolean(mint));
    } catch (err) {
      logger.warn('Failed to fetch Jupiter token universe', { err });
      return this.dynamicUniverseMints;
    }
  }

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps = 50
  ): Promise<JupiterQuote | null> {
    try {
      const res = await axios.get(`${JUPITER_API}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount,
          slippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
        timeout: 3000,
      });
      return res.data as JupiterQuote;
    } catch {
      return null;
    }
  }

  private async getSwapInstructions(
    quote: JupiterQuote
  ): Promise<TransactionInstruction[] | null> {
    try {
      const res = await axios.post(
        `${JUPITER_API}/swap-instructions`,
        {
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: 0, // we handle fees via Jito tip
        },
        { timeout: 5000 }
      );

      // Jupiter returns serialized instructions — deserialize them
      const data = res.data as {
        setupInstructions?: SerializedInstruction[];
        swapInstruction: SerializedInstruction;
        cleanupInstruction?: SerializedInstruction;
      };

      const instructions: TransactionInstruction[] = [];
      if (data.setupInstructions) {
        instructions.push(...data.setupInstructions.map(deserializeInstruction));
      }
      instructions.push(deserializeInstruction(data.swapInstruction));
      if (data.cleanupInstruction) {
        instructions.push(deserializeInstruction(data.cleanupInstruction));
      }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
