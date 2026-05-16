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
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "number")) {
      throw new Error("not-json-byte-array");
    }
    return Uint8Array.from(parsed);
  } catch {
    // Continue with non-JSON fallback parsers.
  }

  const commaSeparated = trimmed.split(",").map((part) => Number(part.trim()));
  if (
    commaSeparated.length > 1 &&
    commaSeparated.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    return Uint8Array.from(commaSeparated);
  }

  try {
    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length >= 32) return Uint8Array.from(base64);
  } catch {
    // ignore
  }

  try {
    const base64url = Buffer.from(trimmed, "base64url");
    if (base64url.length >= 32) return Uint8Array.from(base64url);
  } catch {
    // ignore
  }

  return null;
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
    throw new Error("MORK_WALLET_SECRET_KEY must be a byte array (JSON), comma-separated bytes, or base64/base64url");
  }

  return {
    address: Keypair.fromSecretKey(secretKey).publicKey.toBase58(),
    source: "MORK_WALLET_SECRET_KEY",
  };
}

export function resolveWalletAddressFromEnv(): string | null {
  return resolveWalletConfigFromEnv().address;
}
