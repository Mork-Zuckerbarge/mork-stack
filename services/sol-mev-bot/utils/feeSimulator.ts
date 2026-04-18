import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { AgentConfig, Opportunity } from '../types';

const LAMPORTS_PER_SOL = 1_000_000_000;
const COMPUTE_UNITS_SWAP = 200_000; // conservative estimate for a swap tx

export interface FeeEstimate {
  baseFee: number;           // lamports — standard 5000 per sig
  priorityFee: number;       // lamports — microlamports * CUs / 1e6
  jitoTip: number;           // lamports
  totalFeeLamports: number;
  netProfitLamports: number;
  isProfitable: boolean;
}

/**
 * FeeSimulator calculates the true cost of executing a trade on Solana,
 * accounting for base fee, priority fee, and Jito tip.
 * Always run this before sending any bundle — abort if net is negative.
 */
export class FeeSimulator {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  simulate(opportunity: Opportunity): FeeEstimate {
    const baseFee = 5000; // lamports per signature (standard Solana fee)

    // Priority fee: microlamports per CU * estimated CUs / 1,000,000
    const priorityFee = Math.ceil(
      (this.config.priorityFeeMicrolamports * COMPUTE_UNITS_SWAP) / 1_000_000
    );

    const jitoTip = this.config.jitoTipLamports;

    const totalFeeLamports = baseFee + priorityFee + jitoTip;
    const netProfitLamports = opportunity.grossProfitLamports - totalFeeLamports;
    const isProfitable = netProfitLamports >= this.config.minProfitLamports;

    const estimate: FeeEstimate = {
      baseFee,
      priorityFee,
      jitoTip,
      totalFeeLamports,
      netProfitLamports,
      isProfitable,
    };

    if (!isProfitable) {
      logger.debug('Fee simulation: trade NOT profitable', {
        opportunityId: opportunity.id,
        strategy: opportunity.strategy,
        grossProfit: opportunity.grossProfitLamports,
        fees: totalFeeLamports,
        net: netProfitLamports,
        minRequired: this.config.minProfitLamports,
      });
    } else {
      logger.debug('Fee simulation: trade PROFITABLE', {
        opportunityId: opportunity.id,
        strategy: opportunity.strategy,
        grossProfit: `${(opportunity.grossProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        fees: `${(totalFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        net: `${(netProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      });
    }

    return estimate;
  }

  /**
   * Fetch current priority fee recommendations from the network.
   * Use this to dynamically set priority fees during high congestion.
   */
  async fetchRecentPriorityFees(connection: Connection): Promise<{
    low: number;
    medium: number;
    high: number;
  }> {
    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (!fees.length) return { low: 1000, medium: 10000, high: 100000 };

      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const low = sorted[Math.floor(sorted.length * 0.25)] ?? 1000;
      const medium = sorted[Math.floor(sorted.length * 0.5)] ?? 10000;
      const high = sorted[Math.floor(sorted.length * 0.9)] ?? 100000;

      logger.debug('Recent priority fees (microlamports/CU)', { low, medium, high });
      return { low, medium, high };
    } catch (err) {
      logger.warn('Failed to fetch priority fees, using defaults', { err });
      return { low: 1000, medium: 10000, high: 100000 };
    }
  }
}
