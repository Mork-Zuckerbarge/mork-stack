import { Keypair } from "@solana/web3.js";

export type WalletConfigSource =
  | "MORK_WALLET"
  | "MORK_WALLET_SECRET_KEY"
  | "unconfigured";

export type ResolvedWalletConfig = {
  address: string | null;
  source: WalletConfigSource;
};

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

export function resolveWalletConfigFromEnv(): ResolvedWalletConfig {
  const configuredWallet = process.env.MORK_WALLET?.trim();
  if (configuredWallet) {
    return {
      address: configuredWallet,
      source: "MORK_WALLET",
    };
  }

  const secretRaw = process.env.MORK_WALLET_SECRET_KEY?.trim();
  if (!secretRaw) {
    return {
      address: null,
      source: "unconfigured",
    };
  }

  const secretKey = parseSecretKey(secretRaw);
  if (!secretKey) {
    throw new Error("MORK_WALLET_SECRET_KEY must be a JSON array of bytes");
  }

  return {
    address: Keypair.fromSecretKey(secretKey).publicKey.toBase58(),
    source: "MORK_WALLET_SECRET_KEY",
  };
}

export function resolveWalletAddressFromEnv(): string | null {
  return resolveWalletConfigFromEnv().address;
}
