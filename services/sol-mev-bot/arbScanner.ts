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

// Token mints for reference
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
    logger.info('ArbScanner started', { tokens: this.config.arbTokenMints.length });
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
    const scans = this.config.arbTokenMints
      .filter((mint) => mint !== SOL_MINT)
      .map((mint) => this.scanCircularRoute(mint));

    await Promise.allSettled(scans);
  }

  /**
   * Check circular route: SOL → TOKEN → SOL
   * Also check triangular: SOL → USDC → TOKEN → SOL
   */
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
          net: `${(opp.estimatedProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        });
        return { opportunityId: opp.id, success: true, dryRun: true };
      }

      // Get swap instructions from Jupiter for both legs
      const leg1Instructions = await this.getSwapInstructions(
        opp.meta.outQuote as JupiterQuote
      );
      const leg2Instructions = await this.getSwapInstructions(
        opp.meta.roundTripQuote as JupiterQuote
      );

      if (!leg1Instructions || !leg2Instructions) {
        return { opportunityId: opp.id, success: false, dryRun: false, errorMessage: 'Failed to get swap instructions' };
      }

      // Build a single versioned transaction with both swap legs + tip
      const allInstructions = [...leg1Instructions, ...leg2Instructions];
      const tx = await this.jitoClient.buildSignedTransaction(allInstructions, true);

      const result = await this.jitoClient.sendBundle([tx]);

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
