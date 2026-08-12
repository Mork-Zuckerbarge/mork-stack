import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { prisma } from "./prisma";
import { createSolanaConnection } from "./solanaRpc";
import { APP_DEFAULTS, BBQ_TOKEN } from "./defaults";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL || APP_DEFAULTS.solanaRpcUrl;

function signerFromEnv() {
  const raw = process.env.MORK_WALLET_SECRET_KEY?.trim();
  if (!raw) throw new Error("MORK_WALLET_SECRET_KEY is required to send tokens");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "number")) {
    throw new Error("MORK_WALLET_SECRET_KEY must be a JSON array of bytes");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgramId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

type SourceTokenAccount = { address: PublicKey; units: bigint; tokenProgramId: PublicKey };

async function getSourceTokenAccounts(owner: PublicKey, mint: PublicKey) {
  const connection = createSolanaConnection(RPC, "confirmed");
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  return accounts.value
    .map((account): SourceTokenAccount => {
      const amount = String(
        (account.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? "0",
      );
      return { address: account.pubkey, units: BigInt(amount), tokenProgramId: account.account.owner };
    })
    .filter((account) => account.units > BigInt(0));
}

async function getMintDecimals(mint: PublicKey) {
  const connection = createSolanaConnection(RPC, "confirmed");
  const mintInfo = await connection.getParsedAccountInfo(mint, "confirmed");
  const decimals = Number((mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error("Could not resolve token decimals");
  return decimals;
}

export async function getTransferableWalletTokenAmount(mintAddress: string) {
  const signer = signerFromEnv();
  const connection = createSolanaConnection(RPC, "confirmed");
  if (mintAddress === SOL_MINT) {
    const balance = await connection.getBalance(signer.publicKey, "confirmed");
    return Math.max(0, (balance - 10_000_000) / 1_000_000_000);
  }

  const mint = new PublicKey(mintAddress);
  const decimals = await getMintDecimals(mint);
  const sourceAccounts = await getSourceTokenAccounts(signer.publicKey, mint);
  const sourceUnits = sourceAccounts.reduce((total, account) => total + account.units, BigInt(0));
  const reservedUnits =
    BBQ_TOKEN.mint && mintAddress === BBQ_TOKEN.mint
      ? BigInt(Math.ceil(BBQ_TOKEN.requiredBalance * 10 ** decimals))
      : BigInt(0);
  const transferableUnits = sourceUnits > reservedUnits ? sourceUnits - reservedUnits : BigInt(0);
  return Number(transferableUnits) / 10 ** decimals;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  ata: PublicKey,
  tokenProgramId: PublicKey,
) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
  });
}

function transferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  tokenProgramId: PublicKey,
) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function sendWalletToken(input: { recipient: string; mint: string; amount: number; sendAll?: boolean }) {
  if (process.env.MORK_AGENT_TRANSFER_ENABLED !== "1") {
    throw new Error("Wallet transfers are disabled (set MORK_AGENT_TRANSFER_ENABLED=1 to enable explicit send commands)");
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("No transferable token balance is available");

  const signer = signerFromEnv();
  const recipient = new PublicKey(input.recipient);
  if (recipient.equals(signer.publicKey)) throw new Error("Recipient is the configured wallet; refusing a self-transfer");
  const connection = createSolanaConnection(RPC, "confirmed");
  const transaction = new Transaction();

  if (input.mint === SOL_MINT) {
    const maxSol = Math.max(0, Number(process.env.MORK_AGENT_TRANSFER_MAX_SOL || 0.25));
    const balance = await connection.getBalance(signer.publicKey, "confirmed");
    const lamports = input.sendAll ? Math.max(0, balance - 10_000_000) : Math.floor(input.amount * 1_000_000_000);
    if (lamports > Math.floor(maxSol * 1_000_000_000)) {
      throw new Error(`SOL transfer exceeds configured maximum of ${maxSol} SOL`);
    }
    if (balance - lamports < 10_000_000) throw new Error("SOL transfer blocked: wallet must retain at least 0.01 SOL for fees");
    transaction.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports }));
  } else {
    const mint = new PublicKey(input.mint);
    const decimals = await getMintDecimals(mint);
    const sourceAccounts = await getSourceTokenAccounts(signer.publicKey, mint);
    const sourceUnits = sourceAccounts.reduce((total, account) => total + account.units, BigInt(0));
    const tokenProgramId = sourceAccounts[0]?.tokenProgramId;
    if (!tokenProgramId || (!tokenProgramId.equals(TOKEN_PROGRAM_ID) && !tokenProgramId.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new Error("No supported token account for this mint was found in the configured wallet");
    }
    if (sourceAccounts.some((account) => !account.tokenProgramId.equals(tokenProgramId))) {
      throw new Error("Token balance is split across incompatible token programs");
    }
    const destination = associatedTokenAddress(recipient, mint, tokenProgramId);
    const requiredUnits =
      BBQ_TOKEN.mint && input.mint === BBQ_TOKEN.mint
        ? BigInt(Math.ceil(BBQ_TOKEN.requiredBalance * 10 ** decimals))
        : BigInt(0);
    const amountUnits = input.sendAll
      ? sourceUnits > requiredUnits ? sourceUnits - requiredUnits : BigInt(0)
      : BigInt(Math.floor(input.amount * 10 ** decimals));
    if (amountUnits <= BigInt(0) || amountUnits > sourceUnits) throw new Error("Transfer amount exceeds the wallet token balance");
    if (BBQ_TOKEN.mint && input.mint === BBQ_TOKEN.mint) {
      if (sourceUnits - amountUnits < requiredUnits) {
        throw new Error(
          `${BBQ_TOKEN.symbol} transfer blocked: wallet must retain at least ${BBQ_TOKEN.requiredBalance} ${BBQ_TOKEN.symbol}`,
        );
      }
    }
    if (!(await connection.getAccountInfo(destination, "confirmed"))) {
      transaction.add(createAssociatedTokenAccountInstruction(signer.publicKey, recipient, mint, destination, tokenProgramId));
    }
    let remainingUnits = amountUnits;
    for (const source of sourceAccounts) {
      if (remainingUnits <= BigInt(0)) break;
      const sourceAmount = source.units < remainingUnits ? source.units : remainingUnits;
      transaction.add(
        transferCheckedInstruction(source.address, mint, destination, signer.publicKey, sourceAmount, decimals, tokenProgramId),
      );
      remainingUnits -= sourceAmount;
    }
  }

  const signature = await sendAndConfirmTransaction(connection, transaction, [signer], {
    commitment: "confirmed",
    maxRetries: 3,
    skipPreflight: false,
  });
  await prisma.memory.create({
    data: {
      type: "event",
      content: `wallet_transfer mint=${input.mint} amount=${input.amount} recipient=${recipient.toBase58()} sig=${signature}`,
      entities: ["wallet:transfer", `wallet:${signer.publicKey.toBase58()}`],
      importance: 0.8,
      source: "wallet",
    },
  });
  return { signature, sender: signer.publicKey.toBase58(), recipient: recipient.toBase58() };
}

export { SOL_MINT };
