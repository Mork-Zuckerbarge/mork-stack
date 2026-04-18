import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import axios from 'axios';
import { logger } from './logger';
import { AgentConfig, BundleResult, AnyTransaction } from '../types';

// Jito tip accounts — one is picked at random per bundle
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13eDzZQD',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
];

export interface Bundle {
  transactions: AnyTransaction[];
  tipLamports: number;
}

/**
 * JitoClient handles Jito bundle submission.
 *
 * A bundle is an ordered, atomic set of transactions (up to 5) that either
 * all land in the same slot or none do. This prevents partial execution
 * and eliminates frontrunning risk within the bundle.
 *
 * Jito docs: https://docs.jito.wtf/
 */
export class JitoClient {
  private config: AgentConfig;
  private connection: Connection;
  private wallet: Keypair;
  private blockEngineUrl: string;

  constructor(config: AgentConfig, connection: Connection, wallet: Keypair) {
    this.config = config;
    this.connection = connection;
    this.wallet = wallet;
    this.blockEngineUrl = config.jitoBlockEngineUrl;
  }

  /**
   * Build a tip instruction — sends SOL to a random Jito tip account.
   * This is required for Jito to include your bundle.
   */
  buildTipInstruction(tipLamports: number): TransactionInstruction {
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );
    return SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });
  }

  /**
   * Submit a bundle to Jito's block engine.
   * Transactions should be pre-signed VersionedTransactions.
   * The tip instruction should be appended to the last transaction.
   */
  async sendBundle(
    transactions: VersionedTransaction[],
    tipLamports?: number
  ): Promise<BundleResult> {
    if (this.config.dryRun) {
      logger.info('[DRY RUN] Would send Jito bundle', {
        txCount: transactions.length,
        tip: `${((tipLamports ?? this.config.jitoTipLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      });
      return { bundleId: 'dry-run-' + Date.now(), status: 'landed' };
    }

    // Serialize all transactions to base64
    const encodedTxs = transactions.map((tx) =>
      Buffer.from(tx.serialize()).toString('base64')
    );

    const bundleRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encodedTxs],
    };

    try {
      const response = await axios.post(
        `${this.blockEngineUrl}/api/v1/bundles`,
        bundleRequest,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        }
      );

      const bundleId: string = response.data.result;
      logger.info('Bundle submitted to Jito', { bundleId });

      // Poll for confirmation
      const result = await this.waitForBundle(bundleId);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send Jito bundle', { error: msg });
      return { bundleId: '', status: 'failed' };
    }
  }

  /**
   * Poll Jito's bundle status endpoint until landed or failed.
   */
  async waitForBundle(
    bundleId: string,
    timeoutMs = 30_000
  ): Promise<BundleResult> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await sleep(2000);

      try {
        const res = await axios.post(
          `${this.blockEngineUrl}/api/v1/bundles`,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
        );

        const statuses: Array<{
          bundle_id: string;
          transactions: string[];
          slot: number;
          confirmation_status: string;
          err: unknown;
        }> = res.data.result?.value ?? [];

        const status = statuses.find((s) => s.bundle_id === bundleId);
        if (!status) continue;

        if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
          logger.info('Bundle landed!', {
            bundleId,
            slot: status.slot,
            txs: status.transactions,
          });
          return { bundleId, status: 'landed', slot: status.slot };
        }

        if (status.err) {
          logger.warn('Bundle failed on-chain', { bundleId, err: status.err });
          return { bundleId, status: 'failed' };
        }
      } catch (err) {
        logger.debug('Bundle status poll error (retrying)', { bundleId, err });
      }
    }

    logger.warn('Bundle confirmation timeout', { bundleId });
    return { bundleId, status: 'pending' };
  }

  /**
   * Build a VersionedTransaction from instructions, with the tip instruction
   * appended. Signs with the agent wallet.
   */
  async buildSignedTransaction(
    instructions: TransactionInstruction[],
    includeTip = true,
    tipLamports?: number
  ): Promise<VersionedTransaction> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const allInstructions = includeTip
      ? [...instructions, this.buildTipInstruction(tipLamports ?? this.config.jitoTipLamports)]
      : instructions;

    const msg = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);
    return tx;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
