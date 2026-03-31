import { Connection, PublicKey } from "@solana/web3.js";

const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
    const parsed: any = acc.account.data.parsed;
    const amount = parsed?.info?.tokenAmount?.uiAmount;
    total += Number(amount || 0);
  }

  return total;
}

export async function getWalletState() {
  const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const WALLET = process.env.MORK_WALLET;

  if (!WALLET) {
    throw new Error("MORK_WALLET not configured");
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
