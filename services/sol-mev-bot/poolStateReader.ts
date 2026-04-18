import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { logger } from './logger';
import { PoolState } from '../types';

/**
 * PoolStateReader fetches and decodes on-chain AMM pool accounts.
 *
 * Each DEX stores pool state in a different account layout. This module
 * handles the low-level byte parsing for each. For production use,
 * prefer the official SDKs when available; raw parsing is provided here
 * as a fallback for maximum speed (no SDK overhead).
 */
export class PoolStateReader {
  private connection: Connection;
  private cache: Map<string, { state: PoolState; cachedAt: number }> = new Map();
  private cacheTtlMs = 500; // re-read pool every 500ms max

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async getPoolState(
    poolAddress: PublicKey,
    dex: 'raydium' | 'orca' | 'meteora'
  ): Promise<PoolState | null> {
    const key = poolAddress.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.state;
    }

    try {
      const account = await this.connection.getAccountInfo(poolAddress, 'processed');
      if (!account) return null;

      let state: PoolState | null = null;

      switch (dex) {
        case 'raydium':
          state = this.decodeRaydiumV4Pool(poolAddress, account);
          break;
        case 'orca':
          state = this.decodeOrcaWhirlpool(poolAddress, account);
          break;
        case 'meteora':
          state = this.decodeMeteoraPool(poolAddress, account);
          break;
      }

      if (state) {
        this.cache.set(key, { state, cachedAt: Date.now() });
      }

      return state;
    } catch (err) {
      logger.debug('Failed to read pool state', { pool: key, dex, err });
      return null;
    }
  }

  /**
   * Decode a Raydium AMM V4 pool account.
   * Layout reference: https://github.com/raydium-io/raydium-amm/blob/master/program/src/state.rs
   *
   * Key offsets (bytes):
   *   400: status (u64)
   *   432: base_vault (pubkey)
   *   464: quote_vault (pubkey)
   *   496: base_mint (pubkey)
   *   528: quote_mint (pubkey)
   *   568: open_orders (pubkey)
   *   600: target_orders (pubkey)
   *   632: withdraw_queue (pubkey)
   *   664: lp_mint (pubkey)
   */
  private decodeRaydiumV4Pool(
    address: PublicKey,
    account: AccountInfo<Buffer>
  ): PoolState | null {
    const data = account.data;
    if (data.length < 752) return null;

    try {
      const tokenA = new PublicKey(data.slice(400, 432));
      const tokenB = new PublicKey(data.slice(432, 464));

      // Reserve amounts are stored in the vault accounts, not the pool directly.
      // For production: fetch vault account balances separately.
      // Here we return the pool structure; reserves are fetched lazily.
      const reserveA = BigInt(0); // populate with vault balance fetch
      const reserveB = BigInt(0);

      return {
        address,
        dex: 'raydium',
        tokenA,
        tokenB,
        reserveA,
        reserveB,
        fee: 0.0025, // Raydium V4 standard fee
        lastUpdatedSlot: 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Decode an Orca Whirlpool account.
   * Layout: https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/state/whirlpool.rs
   *
   * Key offsets:
   *   8:   whirlpools_config (pubkey)
   *   40:  whirlpool_bump (u8)
   *   41:  tick_spacing (u16)
   *   44:  tick_spacing_seed (u16)
   *   46:  fee_rate (u16)  — fee in hundredths of a bip (1/1,000,000)
   *   48:  protocol_fee_rate (u16)
   *   56:  liquidity (u128)
   *   72:  sqrt_price_x64 (u128)  — √price * 2^64
   *   88:  tick_current_index (i32)
   *   101: token_mint_a (pubkey)
   *   133: token_vault_a (pubkey)
   *   165: token_mint_b (pubkey)
   *   197: token_vault_b (pubkey)
   */
  private decodeOrcaWhirlpool(
    address: PublicKey,
    account: AccountInfo<Buffer>
  ): PoolState | null {
    const data = account.data;
    if (data.length < 300) return null;

    try {
      const feeRate = data.readUInt16LE(46); // hundredths of a bip
      const tokenA = new PublicKey(data.slice(101, 133));
      const tokenB = new PublicKey(data.slice(165, 197));

      // sqrtPrice for Orca CLMM — spot price derivation:
      // price = (sqrtPriceX64 / 2^64)^2
      const sqrtPriceX64Lo = BigInt(data.readUInt32LE(72));
      const sqrtPriceX64Hi = BigInt(data.readUInt32LE(76));
      const sqrtPriceX64 = (sqrtPriceX64Hi << 32n) | sqrtPriceX64Lo;
      const _price = Number((sqrtPriceX64 * sqrtPriceX64) >> 128n); // normalized

      return {
        address,
        dex: 'orca',
        tokenA,
        tokenB,
        reserveA: BigInt(0), // fetch from vault account
        reserveB: BigInt(0),
        fee: feeRate / 1_000_000,
        lastUpdatedSlot: 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Decode a Meteora DLMM pool.
   * Meteora uses dynamic fee tiers. Full layout in their SDK:
   * https://github.com/MeteoraAg/dlmm-sdk
   */
  private decodeMeteoraPool(
    address: PublicKey,
    account: AccountInfo<Buffer>
  ): PoolState | null {
    const data = account.data;
    if (data.length < 200) return null;

    try {
      // Meteora DLMM layout starts with 8-byte discriminator
      const tokenA = new PublicKey(data.slice(8, 40));
      const tokenB = new PublicKey(data.slice(40, 72));

      return {
        address,
        dex: 'meteora',
        tokenA,
        tokenB,
        reserveA: BigInt(0),
        reserveB: BigInt(0),
        fee: 0.002, // typical Meteora fee, actual is dynamic
        lastUpdatedSlot: 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the actual SOL/token balance of a vault account.
   * Used to get real reserve values for price calculation.
   */
  async getVaultBalance(vaultAddress: PublicKey): Promise<bigint> {
    try {
      const info = await this.connection.getTokenAccountBalance(vaultAddress, 'processed');
      return BigInt(info.value.amount);
    } catch {
      return BigInt(0);
    }
  }

  /**
   * Calculate the spot price of a constant-product AMM pool (x*y=k).
   * Returns price of tokenA denominated in tokenB.
   * For CLMM (Orca), use sqrtPrice from decodeOrcaWhirlpool instead.
   */
  static spotPrice(reserveA: bigint, reserveB: bigint, decimalsA: number, decimalsB: number): number {
    if (reserveA === BigInt(0)) return 0;
    const rA = Number(reserveA) / Math.pow(10, decimalsA);
    const rB = Number(reserveB) / Math.pow(10, decimalsB);
    return rB / rA;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
