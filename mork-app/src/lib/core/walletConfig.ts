import { Keypair } from "@solana/web3.js";

function parseSecretKey(raw: string): Uint8Array | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "number")) {
      return null;
    }
    return Uint8Array.from(parsed);
  } catch {
    return null;
  }
}

export function resolveWalletAddressFromEnv(): string | null {
  const configuredWallet = process.env.MORK_WALLET?.trim();
  if (configuredWallet) return configuredWallet;

  const secretRaw = process.env.MORK_WALLET_SECRET_KEY?.trim();
  if (!secretRaw) return null;

  const secretKey = parseSecretKey(secretRaw);
  if (!secretKey) {
    throw new Error("MORK_WALLET_SECRET_KEY must be a JSON array of bytes");
  }

  return Keypair.fromSecretKey(secretKey).publicKey.toBase58();
}
