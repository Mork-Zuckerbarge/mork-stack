import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';

const ENGINE_PORT = parseInt(process.env.MEV_ENGINE_PORT ?? '9000');

interface PendingRequest {
  resolve: (value: RustResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface RustResult {
  type: string;
  id?: string;
  success?: boolean;
  bundle_id?: string;
  slot?: number;
  error?: string;
  version?: string;
}

/**
 * RustEngineClient — thin TCP bridge between Node.js orchestrator and the
 * Rust MEV engine. Sends newline-delimited JSON commands; reads back results.
 *
 * The Rust engine handles the performance-critical path:
 *   - Transaction serialization + signing
 *   - Jito bundle submission + status polling
 *
 * Node.js handles strategy logic and opportunity detection, which don't
 * require microsecond latency.
 */
export class RustEngineClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private connected = false;
  private reconnecting = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.connect(ENGINE_PORT, '127.0.0.1', () => {
        this.connected = true;
        logger.info('Connected to Rust MEV engine', { port: ENGINE_PORT });
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleResponse(line);
        }
      });

      this.socket.on('error', (err) => {
        if (!this.connected) reject(err);
        else logger.error('Rust engine socket error', { err: err.message });
      });

      this.socket.on('close', () => {
        this.connected = false;
        logger.warn('Rust engine disconnected — will reconnect in 2s');
        if (!this.reconnecting) this.scheduleReconnect();
      });

      setTimeout(() => {
        if (!this.connected) reject(new Error('Connection to Rust engine timed out'));
      }, 5000);
    });
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnecting = false;
      } catch {
        this.scheduleReconnect();
      }
    }, 2000);
  }

  private handleResponse(line: string): void {
    try {
      const msg = JSON.parse(line) as RustResult;
      const id = msg.id;
      if (!id) return;

      const pending = this.pending.get(id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.resolve(msg);
    } catch (err) {
      logger.warn('Failed to parse Rust engine response', { line, err });
    }
  }

  private send(cmd: Record<string, unknown>): void {
    if (!this.socket || !this.connected) {
      throw new Error('Rust engine not connected');
    }
    this.socket.write(JSON.stringify(cmd) + '\n');
  }

  private async call(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<RustResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(cmd.id as string);
        reject(new Error(`Rust engine call timed out: ${cmd.type}`));
      }, timeoutMs);

      this.pending.set(cmd.id as string, { resolve, reject, timeout });

      try {
        this.send(cmd);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(cmd.id as string);
        reject(err);
      }
    });
  }

  async ping(): Promise<boolean> {
    try {
      const id = uuidv4();
      const res = await this.call({ type: 'ping', id }, 5000);
      return res.type === 'pong';
    } catch {
      return false;
    }
  }

  async executeArbBundle(params: {
    walletSecret: string;
    leg1TxBase64: string;
    leg2TxBase64: string;
    jitoTipLamports: number;
    dryRun: boolean;
  }): Promise<RustResult> {
    const id = uuidv4();
    return this.call({
      type: 'execute_arb_bundle',
      id,
      wallet_secret: params.walletSecret,
      leg1_tx_base64: params.leg1TxBase64,
      leg2_tx_base64: params.leg2TxBase64,
      jito_tip_lamports: params.jitoTipLamports,
      dry_run: params.dryRun,
    });
  }

  async executeSwap(params: {
    walletSecret: string;
    inputMint: string;
    outputMint: string;
    amountIn: number;
    minAmountOut: number;
    jitoTipLamports: number;
    dryRun: boolean;
  }): Promise<RustResult> {
    const id = uuidv4();
    return this.call({
      type: 'execute_swap',
      id,
      wallet_secret: params.walletSecret,
      input_mint: params.inputMint,
      output_mint: params.outputMint,
      amount_in: params.amountIn,
      min_amount_out: params.minAmountOut,
      jito_tip_lamports: params.jitoTipLamports,
      dry_run: params.dryRun,
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
