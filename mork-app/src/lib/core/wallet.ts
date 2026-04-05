import { Connection, PublicKey } from "@solana/web3.js";
import type { ParsedAccountData } from "@solana/web3.js";
import { prisma } from "./prisma";
import { resolveWalletAddressFromEnv } from "./walletConfig";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type WalletState = {
  address: string;
  sol: number;
  bbq: number;
  usdc: number;
  requirementMet: boolean;
};

let walletCache: WalletState | null = null;
let walletCacheAt = 0;
const WALLET_CACHE_MS = 15000;

async function getSplBalance(
  connection: Connection,
  owner: PublicKey,
  mint: string
): Promise<number> {
  const mintPk = new PublicKey(mint);

  const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: mintPk,
  });

  let total = 0;

  for (const acc of accounts.value) {
    const parsed = (acc.account.data as ParsedAccountData).parsed;
    const amount = parsed?.info?.tokenAmount?.uiAmount;
    total += Number(amount || 0);
  }

  return total;
}

export async function getWalletBalancesForMints(mints: string[]): Promise<Record<string, number>> {
  const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const WALLET = resolveWalletAddressFromEnv();

  if (!WALLET) {
    throw new Error("Wallet not configured (set MORK_WALLET or MORK_WALLET_SECRET_KEY)");
  }

  const connection = new Connection(RPC);
  const owner = new PublicKey(WALLET);

  const uniqueMints = Array.from(new Set(mints.map((mint) => mint.trim()).filter(Boolean)));
  const balances: Record<string, number> = {};

  await Promise.all(
    uniqueMints.map(async (mint) => {
      if (mint === SOL_MINT) {
        const solLamports = await connection.getBalance(owner);
        balances[mint] = solLamports / 1e9;
        return;
      }

      balances[mint] = await getSplBalance(connection, owner, mint);
    }),
  );

  return balances;
}

async function fetchWalletState(): Promise<WalletState> {
  const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const WALLET = resolveWalletAddressFromEnv();

  if (!WALLET) {
    throw new Error("Wallet not configured (set MORK_WALLET or MORK_WALLET_SECRET_KEY)");
  }

  const connection = new Connection(RPC);
  const owner = new PublicKey(WALLET);

  const solLamports = await connection.getBalance(owner);
  const sol = solLamports / 1e9;

  const [bbq, usdc] = await Promise.all([
    getSplBalance(connection, owner, BBQ_MINT),
    getSplBalance(connection, owner, USDC_MINT),
  ]);

  return {
    address: WALLET,
    sol,
    bbq,
    usdc,
    requirementMet: bbq >= 1000,
  };
}

export async function getWalletState(force = false) {
  const now = Date.now();

  if (!force && walletCache && now - walletCacheAt < WALLET_CACHE_MS) {
    return walletCache;
  }

  const wallet = await fetchWalletState();
  walletCache = wallet;
  walletCacheAt = now;
  return wallet;
}

export async function refreshWalletMemory() {
  const wallet = await getWalletState(true);

  await prisma.memory.create({
    data: {
      type: "event",
      content: `Wallet state: address=${wallet.address} SOL=${wallet.sol} BBQ=${wallet.bbq} USDC=${wallet.usdc} requirementMet=${wallet.requirementMet}`,
      entities: ["wallet", `wallet:${wallet.address}`],
      importance: 0.4,
      source: "wallet",
    },
  });

  return wallet;
}
