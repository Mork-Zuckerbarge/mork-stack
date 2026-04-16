const { PublicKey } = require("@solana/web3.js");
const BBQ_MINT = new PublicKey(
  "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn"
);

function uiAmountFromParsedTokenAccount(parsed) {
  try {
    return Number(parsed?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
  } catch {
    return 0;
  }
}

async function getSplBalanceUi(connection, owner, mint) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  return uiAmountFromParsedTokenAccount(accounts.value?.[0]);
}

async function listTokenAccounts(connection, owner) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
  const out = [];
  for (const a of res.value || []) {
    const info = a.account?.data?.parsed?.info;
    const mint = info?.mint;
    const amt = info?.tokenAmount?.uiAmount;
    if (!mint) continue;
    if (!amt || Number(amt) === 0) continue;
    out.push({
      mint,
      amount: Number(amt),
      decimals: Number(info?.tokenAmount?.decimals ?? 0),
    });
  }
  return out;
}

async function enforceBbqGateOrExit(
  connection,
  ownerPubkey,
  { minBbq = 1000, knownBbqBalance = null } = {}
) {
  const bbqBal =
    typeof knownBbqBalance === "number" && Number.isFinite(knownBbqBalance)
      ? knownBbqBalance
      : await getSplBalanceUi(connection, ownerPubkey, BBQ_MINT);

  if (bbqBal < minBbq) {
    console.error(
      `⛔ BBQ GATE: wallet has ${bbqBal.toFixed(6)} BBQ, needs >= ${minBbq}. Exiting.`
    );
    process.exit(2);
  }
  return bbqBal;
}

async function getWalletSnapshot(connection, ownerPubkey, { includeTokens = true, topN = 20 } = {}) {
  const solLamports = await connection.getBalance(ownerPubkey);
  const sol = solLamports / 1e9;
  const bbq = await getSplBalanceUi(connection, ownerPubkey, BBQ_MINT);

  let tokens = [];
  if (includeTokens) {
    tokens = await listTokenAccounts(connection, ownerPubkey);
    tokens.sort((a, b) => b.amount - a.amount);
    tokens = tokens.slice(0, topN);
  }

  return {
    pubkey: ownerPubkey.toBase58(),
    sol,
    bbq,
    tokens,
    ts: new Date().toISOString(),
  };
}

module.exports = {
  BBQ_MINT,
  enforceBbqGateOrExit,
  getWalletSnapshot,
  getSplBalanceUi,
};
