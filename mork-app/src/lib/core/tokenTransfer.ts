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

function associatedTokenAddress(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAssociatedTokenAccountInstruction(payer: PublicKey, owner: PublicKey, mint: PublicKey, ata: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function sendWalletToken(input: { recipient: string; mint: string; amount: number }) {
  if (process.env.MORK_AGENT_TRANSFER_ENABLED !== "1") {
    throw new Error("Wallet transfers are disabled (set MORK_AGENT_TRANSFER_ENABLED=1 to enable explicit send commands)");
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Transfer amount must be greater than zero");

  const signer = signerFromEnv();
  const recipient = new PublicKey(input.recipient);
  if (recipient.equals(signer.publicKey)) throw new Error("Recipient is the configured wallet; refusing a self-transfer");
  const connection = createSolanaConnection(RPC, "confirmed");
  const transaction = new Transaction();

  if (input.mint === SOL_MINT) {
    const maxSol = Math.max(0, Number(process.env.MORK_AGENT_TRANSFER_MAX_SOL || 0.25));
    if (input.amount > maxSol) throw new Error(`SOL transfer exceeds configured maximum of ${maxSol} SOL`);
    const lamports = Math.floor(input.amount * 1_000_000_000);
    const balance = await connection.getBalance(signer.publicKey, "confirmed");
    if (balance - lamports < 10_000_000) throw new Error("SOL transfer blocked: wallet must retain at least 0.01 SOL for fees");
    transaction.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports }));
  } else {
    const mint = new PublicKey(input.mint);
    const mintInfo = await connection.getParsedAccountInfo(mint, "confirmed");
    const decimals = Number((mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error("Could not resolve token decimals");
    const source = associatedTokenAddress(signer.publicKey, mint);
    const destination = associatedTokenAddress(recipient, mint);
    const sourceBalance = await connection.getTokenAccountBalance(source, "confirmed").catch(() => null);
    const sourceUnits = BigInt(sourceBalance?.value.amount || "0");
    const amountUnits = BigInt(Math.floor(input.amount * 10 ** decimals));
    if (amountUnits <= BigInt(0) || amountUnits > sourceUnits) throw new Error("Transfer amount exceeds the wallet token balance");
    if (BBQ_TOKEN.mint && input.mint === BBQ_TOKEN.mint) {
      const requiredUnits = BigInt(Math.ceil(BBQ_TOKEN.requiredBalance * 10 ** decimals));
      if (sourceUnits - amountUnits < requiredUnits) {
        throw new Error(
          `${BBQ_TOKEN.symbol} transfer blocked: wallet must retain at least ${BBQ_TOKEN.requiredBalance} ${BBQ_TOKEN.symbol}`,
        );
      }
    }
    if (!(await connection.getAccountInfo(destination, "confirmed"))) {
      transaction.add(createAssociatedTokenAccountInstruction(signer.publicKey, recipient, mint, destination));
    }
    transaction.add(transferCheckedInstruction(source, mint, destination, signer.publicKey, amountUnits, decimals));
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
