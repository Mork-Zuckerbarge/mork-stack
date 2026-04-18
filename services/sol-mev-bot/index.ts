import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import { logger } from './utils/logger';
import { HeliusListener } from './utils/heliusListener';
import { FeeSimulator } from './utils/feeSimulator';
import { JitoClient } from './utils/jitoClient';
import { RustEngineClient } from './utils/rustEngineClient';
import { StatsTracker } from './utils/statsTracker';
import { CircuitBreaker } from './utils/circuitBreaker';
import { ArbScanner } from './strategies/arbScanner';
import { PoolImbalanceDetector } from './strategies/poolImbalance';
import { MomentumRunner } from './strategies/momentumRunner';
import { AgentConfig } from './types';

function loadConfig(): AgentConfig {
  const required = ['WALLET_PRIVATE_KEY', 'HELIUS_API_KEY', 'HELIUS_RPC_URL', 'HELIUS_WS_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error('Missing required env vars', { missing });
    logger.error('Copy config/.env.example → .env and fill in your values.');
    process.exit(1);
  }

  return {
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY!,
    heliusApiKey: process.env.HELIUS_API_KEY!,
    heliusRpcUrl: process.env.HELIUS_RPC_URL!,
    heliusWsUrl: process.env.HELIUS_WS_URL!,
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL ?? 'https://mainnet.block-engine.jito.wtf',
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS ?? '10000'),
    dryRun: process.env.DRY_RUN !== 'false',
    minProfitLamports: parseInt(process.env.MIN_PROFIT_LAMPORTS ?? '5000'),
    maxPositionSol: parseFloat(process.env.MAX_POSITION_SOL ?? '0.5'),
    priorityFeeMicrolamports: parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS ?? '50000'),
    enableAmmImbalance: process.env.ENABLE_AMM_IMBALANCE !== 'false',
    enableArb: process.env.ENABLE_ARB !== 'false',
    enableMomentum: process.env.ENABLE_MOMENTUM === 'true',
    ammMinImbalancePct: parseFloat(process.env.AMM_MIN_IMBALANCE_PCT ?? '5'),
    arbTokenMints: (process.env.ARB_TOKEN_MINTS ?? [
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ].join(',')).split(',').filter(Boolean),
    momentumVolSpikeMultiplier: parseFloat(process.env.MOMENTUM_VOL_SPIKE_MULTIPLIER ?? '5'),
    momentumTrailingStopPct: parseFloat(process.env.MOMENTUM_TRAILING_STOP_PCT ?? '15'),
    watchPumpFun: process.env.WATCH_PUMP_FUN === 'true',
  };
}

async function main(): Promise<void> {
  for (const dir of ['logs']) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const config = loadConfig();

  logger.info('═'.repeat(60));
  logger.info('  Solana MEV Agent');
  logger.info('═'.repeat(60));
  logger.info('Mode', { dryRun: config.dryRun });
  logger.info('Strategies', {
    arb: config.enableArb,
    ammImbalance: config.enableAmmImbalance,
    momentum: config.enableMomentum,
  });

  if (config.dryRun) {
    logger.warn('*** DRY RUN MODE — no real txs sent. Set DRY_RUN=false to go live. ***');
  }

  // Wallet
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
  } catch {
    logger.error('Invalid WALLET_PRIVATE_KEY — must be base58 encoded');
    process.exit(1);
  }
  logger.info('Wallet', { pubkey: wallet.publicKey.toString() });

  // Connection
  const connection = new Connection(config.heliusRpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 15_000,
  });

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  logger.info('Balance', { sol: balanceSol.toFixed(4) });

  if (balance < 0.05 * LAMPORTS_PER_SOL && !config.dryRun) {
    logger.error('Wallet balance too low — fund with at least 0.05 SOL');
    process.exit(1);
  }

  // Core services
  const circuitBreaker = new CircuitBreaker({
    maxLossPerHourSol: parseFloat(process.env.CB_MAX_LOSS_HOUR_SOL ?? '0.5'),
    maxLossPerSessionSol: parseFloat(process.env.CB_MAX_LOSS_SESSION_SOL ?? '1.0'),
    maxConsecutiveLosses: parseInt(process.env.CB_MAX_CONSECUTIVE_LOSSES ?? '5'),
    maxTradesPerMinute: parseInt(process.env.CB_MAX_TRADES_PER_MIN ?? '30'),
  });

  const stats = new StatsTracker(balanceSol);
  const helius = new HeliusListener(config.heliusWsUrl);
  const feeSimulator = new FeeSimulator(config);
  const jitoClient = new JitoClient(config, connection, wallet);

  const recentFees = await feeSimulator.fetchRecentPriorityFees(connection);
  logger.info('Network priority fees (microlamports/CU)', recentFees);

  // Optional Rust engine
  const rustEngine = new RustEngineClient();
  if (process.env.USE_RUST_ENGINE === 'true') {
    try {
      await rustEngine.connect();
      const alive = await rustEngine.ping();
      logger.info('Rust engine', { status: alive ? 'connected' : 'ping failed' });
    } catch {
      logger.warn('Rust engine unavailable — using Node.js tx builder');
    }
  }

  helius.start();

  // Strategies
  const stoppables: Array<{ stop(): void; name: string }> = [];

  if (config.enableArb) {
    const arb = new ArbScanner(config, connection, wallet, feeSimulator, jitoClient);
    arb.start();
    stoppables.push({ name: 'ArbScanner', stop: () => arb.stop() });
  }

  if (config.enableAmmImbalance) {
    const imbalance = new PoolImbalanceDetector(
      config, connection, wallet, feeSimulator, jitoClient, helius
    );
    imbalance.start();
    stoppables.push({ name: 'PoolImbalanceDetector', stop: () => imbalance.stop() });
  }

  if (config.enableMomentum) {
    const momentum = new MomentumRunner(
      config, connection, wallet, feeSimulator, jitoClient, helius
    );
    await momentum.start();
    stoppables.push({ name: 'MomentumRunner', stop: () => momentum.stop() });
  }

  logger.info('═'.repeat(60));
  logger.info(`  ${stoppables.map((s) => s.name).join(' · ')} running`);
  logger.info('  Press Ctrl+C to stop gracefully.');
  logger.info('═'.repeat(60));

  // Heartbeat every 60s
  const heartbeatInterval = setInterval(async () => {
    if (circuitBreaker.isTripped()) {
      logger.error('Circuit breaker is TRIPPED — trading halted. Review logs.');
      return;
    }
    const bal = await connection.getBalance(wallet.publicKey).catch(() => 0);
    stats.updateBalance(bal / LAMPORTS_PER_SOL);
    logger.info('Heartbeat', {
      balance: (bal / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
      uptime: Math.floor(process.uptime() / 60) + 'm',
    });
  }, 60_000);

  // Stats every 15min
  const statsInterval = setInterval(() => {
    stats.printSummary();
    logger.info('Circuit breaker', circuitBreaker.status());
  }, 15 * 60_000);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('Shutdown signal — stopping agent...');
    clearInterval(heartbeatInterval);
    clearInterval(statsInterval);
    for (const s of stoppables) { s.stop(); logger.info(`${s.name} stopped`); }
    helius.stop();
    circuitBreaker.destroy();
    rustEngine.disconnect();
    const finalBalance = await connection.getBalance(wallet.publicKey).catch(() => 0);
    stats.updateBalance(finalBalance / LAMPORTS_PER_SOL);
    stats.printSummary();
    logger.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message });
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
  });
}

main().catch((err: Error) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
