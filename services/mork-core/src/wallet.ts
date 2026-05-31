import { Connection, PublicKey } from "@solana/web3.js";

const BBQ_MINT = "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn";
const REQUIRED_BBQ_BALANCE = 1000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function getSplBalance(connection: Connection, owner: PublicKey, mint: string) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });

  return accounts.value.reduce((total, account) => {
    const amount = Number(
      (account.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed?.info
        ?.tokenAmount?.uiAmount ?? 0,
    );
    return total + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

export async function getWalletSnapshot(input: { rpcUrl: string; wallet: string }) {
  const connection = new Connection(input.rpcUrl, "confirmed");
  const owner = new PublicKey(input.wallet);

  const [solLamports, bbq, usdc] = await Promise.all([
    connection.getBalance(owner),
    getSplBalance(connection, owner, BBQ_MINT),
    getSplBalance(connection, owner, USDC_MINT),
  ]);

  const sol = solLamports / 1e9;

  return {
    address: owner.toBase58(),
    sol,
    bbq,
    usdc,
    requirementMet: bbq >= REQUIRED_BBQ_BALANCE,
  };
}
