import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { logger } from './logger';

export interface GeyserTransaction {
  signature: string;
  slot: number;
  accountKeys: string[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  logMessages: string[];
  err: unknown | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
  owner: string;
}

/**
 * HeliusListener subscribes to Solana transactions via Helius Enhanced
 * WebSocket (Geyser) and emits events for any program accounts we care about.
 *
 * Helius docs: https://docs.helius.dev/solana-rpc-nodes/websocket
 */
export class HeliusListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private watchedPrograms: Set<string> = new Set();
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private subscriptionId = 1;

  // Well-known DEX program IDs
  static readonly RAYDIUM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  static readonly ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  static readonly METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLLjTriggAIVovAL6QKN';
  static readonly PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

  constructor(wsUrl: string) {
    super();
    this.wsUrl = wsUrl;
    // Watch all major DEX programs by default
    this.watchedPrograms.add(HeliusListener.RAYDIUM_V4);
    this.watchedPrograms.add(HeliusListener.ORCA_WHIRLPOOL);
    this.watchedPrograms.add(HeliusListener.METEORA_DLMM);
  }

  watchProgram(programId: string | PublicKey): void {
    this.watchedPrograms.add(programId.toString());
  }

  watchPumpFun(): void {
    this.watchedPrograms.add(HeliusListener.PUMP_FUN);
    logger.info('pump.fun monitoring enabled');
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    logger.info('Connecting to Helius Geyser WebSocket...', { url: this.wsUrl.replace(/api-key=.*/, 'api-key=***') });

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.info('Helius WebSocket connected');
      this.reconnectDelay = 1000;
      this.subscribeToPrograms();
      this.startPing();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        logger.warn('Failed to parse WS message', { err });
      }
    });

    this.ws.on('error', (err) => {
      logger.error('Helius WebSocket error', { err: err.message });
    });

    this.ws.on('close', (code, reason) => {
      logger.warn('Helius WebSocket closed — reconnecting', { code, reason: reason.toString() });
      if (this.pingInterval) clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });
  }

  private subscribeToPrograms(): void {
    // Helius enhanced websocket: logsSubscribe for each program
    for (const programId of this.watchedPrograms) {
      const req = {
        jsonrpc: '2.0',
        id: this.subscriptionId++,
        method: 'logsSubscribe',
        params: [
          { mentions: [programId] },
          { commitment: 'processed' },
        ],
      };
      this.ws?.send(JSON.stringify(req));
      logger.debug('Subscribed to program logs', { programId });
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Subscription confirmation
    if (msg.result !== undefined && typeof msg.result === 'number') {
      logger.debug('Subscription confirmed', { subscriptionId: msg.result });
      return;
    }

    // Actual notification
    const params = msg.params as { result?: { value?: { signature?: string; logs?: string[]; err?: unknown } }; subscription?: number } | undefined;
    if (!params?.result?.value) return;

    const { signature, logs, err } = params.result.value;
    if (!signature) return;

    // Emit raw log event — strategies filter from here
    this.emit('transaction', {
      signature,
      logs: logs ?? [],
      err,
      subscription: params.subscription,
    });

    // Parse swap events from logs and emit higher-level signal
    if (logs) {
      this.parseSwapSignals(signature, logs, err);
    }
  }

  private parseSwapSignals(
    signature: string,
    logs: string[],
    err: unknown
  ): void {
    if (err) return; // skip failed txs

    const logsStr = logs.join('\n');

    // Raydium swap detection
    if (logsStr.includes(HeliusListener.RAYDIUM_V4) && logsStr.includes('Instruction: Swap')) {
      this.emit('swap', { dex: 'raydium', signature, logs });
    }

    // Orca Whirlpool swap
    if (logsStr.includes(HeliusListener.ORCA_WHIRLPOOL) && logsStr.includes('Instruction: Swap')) {
      this.emit('swap', { dex: 'orca', signature, logs });
    }

    // Meteora DLMM swap
    if (logsStr.includes(HeliusListener.METEORA_DLMM)) {
      this.emit('swap', { dex: 'meteora', signature, logs });
    }

    // pump.fun token launch / large buy
    if (logsStr.includes(HeliusListener.PUMP_FUN) && logsStr.includes('buy')) {
      this.emit('pumpfun_buy', { signature, logs });
    }
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping', params: [] }));
      }
    }, 20000);
  }
}
