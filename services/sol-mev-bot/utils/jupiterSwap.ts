import axios from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { JitoClient } from './jitoClient';
import { logger } from './logger';
import { BundleResult, JupiterQuote } from '../types';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

interface SerializedInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

interface SwapInstructionsResponse {
  setupInstructions?: SerializedInstruction[];
  swapInstruction: SerializedInstruction;
  cleanupInstruction?: SerializedInstruction;
}

export interface TokenBalanceRaw {
  amount: bigint;
  decimals: number;
  uiAmount: number;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number | bigint,
  slippageBps = 100
): Promise<JupiterQuote | null> {
  try {
    const res = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
      },
      timeout: 3000,
    });
    return res.data as JupiterQuote;
  } catch (err) {
    logger.debug('Jupiter quote failed', { inputMint, outputMint, err });
    return null;
  }
}

export async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  wallet: PublicKey
): Promise<TransactionInstruction[] | null> {
  try {
    const res = await axios.post(
      `${JUPITER_API}/swap-instructions`,
      {
        quoteResponse: quote,
        userPublicKey: wallet.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 0,
      },
      { timeout: 5000 }
    );

    const data = res.data as SwapInstructionsResponse;
    const instructions: TransactionInstruction[] = [];
    if (data.setupInstructions) instructions.push(...data.setupInstructions.map(deserializeInstruction));
    instructions.push(deserializeInstruction(data.swapInstruction));
    if (data.cleanupInstruction) instructions.push(deserializeInstruction(data.cleanupInstruction));
    return instructions;
  } catch (err) {
    logger.debug('Jupiter swap-instructions failed', { err });
    return null;
  }
}

export async function sendJupiterSwapViaJito(params: {
  quote: JupiterQuote;
  connection: Connection;
  wallet: Keypair;
  jitoClient: JitoClient;
  urgency?: 'low' | 'medium' | 'high';
}): Promise<BundleResult> {
  const instructions = await getJupiterSwapInstructions(params.quote, params.wallet.publicKey);
  if (!instructions) return { bundleId: '', status: 'failed' };

  const tip = await params.jitoClient.computeDynamicTip(params.urgency ?? 'medium');
  const tx = await params.jitoClient.buildSignedTransaction(instructions, true, tip);
  return params.jitoClient.sendBundle([tx], tip);
}

export async function getTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mint: string
): Promise<TokenBalanceRaw | null> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let best: TokenBalanceRaw | null = null;

  for (const account of accounts.value) {
    const tokenAmount = account.account.data.parsed?.info?.tokenAmount;
    if (!tokenAmount?.amount) continue;

    const balance = {
      amount: BigInt(tokenAmount.amount),
      decimals: Number(tokenAmount.decimals ?? 0),
      uiAmount: Number(tokenAmount.uiAmount ?? 0),
    };

    if (!best || balance.amount > best.amount) best = balance;
  }

  return best;
}

function deserializeInstruction(ix: SerializedInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}
