import type {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

export interface AgentConfig {
  walletPrivateKey: string;
  heliusApiKey: string;
  heliusRpcUrl: string;
  heliusWsUrl: string;
  jitoBlockEngineUrl: string;
  jitoTipLamports: number;
  dryRun: boolean;
  minProfitLamports: number;
  maxPositionSol: number;
  priorityFeeMicrolamports: number;
  enableArb: boolean;
  enableAmmImbalance: boolean;
  enableMomentum: boolean;
  ammMinImbalancePct: number;
  arbTokenMints: string[];
  momentumVolSpikeMultiplier: number;
  momentumTrailingStopPct: number;
  watchPumpFun: boolean;
}

export enum StrategyType {
  ARBITRAGE = 'arbitrage',
  AMM_IMBALANCE = 'amm_imbalance',
  MOMENTUM = 'momentum',
}

export interface Opportunity {
  id: string;
  strategy: StrategyType;
  tokenIn: PublicKey;
  tokenOut: PublicKey;
  amountIn: bigint;
  expectedAmountOut: bigint;
  grossProfitLamports: number;
  estimatedProfitLamports: number;
  feeLamports: number;
  confidence: number;
  expiresAt: number;
  meta: Record<string, unknown>;
}

export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  dryRun: boolean;
  signature?: string;
  netProfitLamports?: number;
  errorMessage?: string;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  routePlan?: Array<{
    swapInfo?: {
      feeAmount?: string;
      feeMint?: string;
    };
  }>;
}

export type AnyTransaction = Transaction | VersionedTransaction;

export interface BundleResult {
  bundleId: string;
  status: 'landed' | 'failed' | 'pending';
  slot?: number;
}
