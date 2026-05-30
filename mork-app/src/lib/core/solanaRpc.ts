import { Connection, type Commitment } from "@solana/web3.js";

/**
 * Create Solana RPC connections without @solana/web3.js's built-in 429 retry loop.
 *
 * The app has its own targeted retry/backoff in wallet flows; disabling the SDK
 * retry avoids multiplying each app retry into another noisy 500/1000/2000/4000ms
 * SDK retry sequence when public RPC endpoints are rate-limited.
 */
export function createSolanaConnection(endpoint: string, commitment: Commitment = "processed") {
  return new Connection(endpoint, {
    commitment,
    disableRetryOnRateLimit: true,
  });
}
