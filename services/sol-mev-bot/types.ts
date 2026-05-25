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
  // New strategies
  enableTriangularArb: boolean;
  enableCrossDexArb: boolean;
  enableLiquidationArb: boolean;
  enableDriftFunding: boolean;
  enableStablecoinDepeg: boolean;
  // Dynamic Jito tip
  dynamicJitoTip: boolean;
  // Cross-DEX arb
  crossDexMinSpreadPct: number;
  // Drift funding arb
  driftMinFundingRatePct: number;
  // Stablecoin depeg
  stablecoinDepegThresholdPct: number;
  // Correlation filter
  correlationThreshold: number;
}

export enum StrategyType {
  ARBITRAGE = 'arbitrage',
  AMM_IMBALANCE = 'amm_imbalance',
  MOMENTUM = 'momentum',
  TRIANGULAR_ARB = 'triangular_arb',
  CROSS_DEX_ARB = 'cross_dex_arb',
  LIQUIDATION_ARB = 'liquidation_arb',
  DRIFT_FUNDING = 'drift_funding',
  STABLECOIN_DEPEG = 'stablecoin_depeg',
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

export interface PoolState {
  address: import('@solana/web3.js').PublicKey;
  dex: 'raydium' | 'orca' | 'meteora';
  tokenA: import('@solana/web3.js').PublicKey;
  tokenB: import('@solana/web3.js').PublicKey;
  reserveA: bigint;
  reserveB: bigint;
  fee: number;
  lastUpdatedSlot: number;
}

export interface BundleResult {
  bundleId: string;
  status: 'landed' | 'failed' | 'pending';
  slot?: number;
}
