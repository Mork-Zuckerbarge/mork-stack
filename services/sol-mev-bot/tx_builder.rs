use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::Client;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_instruction,
    transaction::VersionedTransaction,
};
use std::str::FromStr;
use std::sync::Arc;
use tracing::{debug, info};

use crate::bundle::JitoBundleSender;

const JUPITER_API: &str = "https://quote-api.jup.ag/v6";

pub struct TransactionBuilder {
    rpc: Arc<RpcClient>,
    http: Client,
}

impl TransactionBuilder {
    pub fn new(rpc_url: String) -> Self {
        let rpc = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("Failed to build HTTP client");

        Self { rpc: Arc::new(rpc), http }
    }

    /// Fetch a Jupiter quote for the given swap parameters.
    pub async fn get_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<Value> {
        let res = self
            .http
            .get(format!("{}/quote", JUPITER_API))
            .query(&[
                ("inputMint", input_mint),
                ("outputMint", output_mint),
                ("amount", &amount.to_string()),
                ("slippageBps", &slippage_bps.to_string()),
                ("onlyDirectRoutes", "false"),
                ("asLegacyTransaction", "false"),
            ])
            .send()
            .await?
            .json::<Value>()
            .await?;

        if res.get("error").is_some() {
            return Err(anyhow!("Jupiter quote error: {}", res["error"]));
        }

        Ok(res)
    }

    /// Build, sign, and base64-encode a versioned swap transaction using
    /// Jupiter's swap-instructions endpoint. Includes compute budget and tip.
    pub async fn build_swap_tx(
        &self,
        wallet_secret_b58: &str,
        input_mint: &str,
        output_mint: &str,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<String> {
        let keypair = keypair_from_b58(wallet_secret_b58)?;

        // Get quote
        let quote = self
            .get_jupiter_quote(input_mint, output_mint, amount_in, 50)
            .await?;

        // Get swap instructions from Jupiter
        let swap_res = self
            .http
            .post(format!("{}/swap-instructions", JUPITER_API))
            .json(&json!({
                "quoteResponse": quote,
                "userPublicKey": keypair.pubkey().to_string(),
                "wrapAndUnwrapSol": true,
                "prioritizationFeeLamports": 0,
                "dynamicComputeUnitLimit": true,
            }))
            .send()
            .await?
            .json::<Value>()
            .await?;

        if swap_res.get("error").is_some() {
            return Err(anyhow!("Jupiter swap-instructions error: {}", swap_res["error"]));
        }

        let mut instructions: Vec<Instruction> = Vec::new();

        // 1. Compute budget — set units and priority fee
        instructions.push(ComputeBudgetInstruction::set_compute_unit_limit(400_000));
        instructions.push(ComputeBudgetInstruction::set_compute_unit_price(50_000));

        // 2. Setup instructions (e.g. open ATAs)
        if let Some(setup) = swap_res["setupInstructions"].as_array() {
            for ix in setup {
                instructions.push(decode_jupiter_instruction(ix)?);
            }
        }

        // 3. The swap instruction itself
        instructions.push(decode_jupiter_instruction(&swap_res["swapInstruction"])?);

        // 4. Cleanup (e.g. close wrapped SOL account)
        if let Some(cleanup) = swap_res.get("cleanupInstruction") {
            if !cleanup.is_null() {
                instructions.push(decode_jupiter_instruction(cleanup)?);
            }
        }

        // 5. Jito tip
        let tip_account = JitoBundleSender::tip_account();
        let tip_ix = system_instruction::transfer(
            &keypair.pubkey(),
            &tip_account,
            10_000, // tip lamports — caller adjusts this
        );
        instructions.push(tip_ix);

        // Build versioned transaction
        let blockhash = self.rpc.get_latest_blockhash().await?;
        let msg = v0::Message::try_compile(
            &keypair.pubkey(),
            &instructions,
            &[], // address lookup tables — Jupiter returns these, add if needed
            blockhash,
        )?;

        let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&keypair])?;
        let encoded = B64.encode(bincode::serialize(&tx)?);

        debug!("Built swap tx: {} → {} amount={}", input_mint, output_mint, amount_in);
        Ok(encoded)
    }

    /// Deserialize a pre-built versioned transaction from base64 and re-sign it
    /// with a fresh blockhash (in case the original one expired).
    pub async fn refresh_and_sign_tx(
        &self,
        tx_base64: &str,
        wallet_secret_b58: &str,
    ) -> Result<String> {
        let keypair = keypair_from_b58(wallet_secret_b58)?;
        let tx_bytes = B64.decode(tx_base64)?;
        let mut tx: VersionedTransaction = bincode::deserialize(&tx_bytes)?;

        let blockhash = self.rpc.get_latest_blockhash().await?;
        match &mut tx.message {
            VersionedMessage::V0(msg) => msg.recent_blockhash = blockhash,
            VersionedMessage::Legacy(msg) => msg.recent_blockhash = blockhash,
        }

        let tx = VersionedTransaction::try_new(tx.message, &[&keypair])?;
        Ok(B64.encode(bincode::serialize(&tx)?))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn keypair_from_b58(secret_b58: &str) -> Result<Keypair> {
    let bytes = bs58::decode(secret_b58)
        .into_vec()
        .map_err(|e| anyhow!("Invalid base58 private key: {}", e))?;
    Keypair::from_bytes(&bytes).map_err(|e| anyhow!("Invalid keypair bytes: {}", e))
}

fn decode_jupiter_instruction(ix: &Value) -> Result<Instruction> {
    let program_id = Pubkey::from_str(
        ix["programId"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing programId"))?,
    )?;

    let accounts = ix["accounts"]
        .as_array()
        .ok_or_else(|| anyhow!("Missing accounts"))?
        .iter()
        .map(|a| {
            Ok(AccountMeta {
                pubkey: Pubkey::from_str(a["pubkey"].as_str().unwrap_or(""))?,
                is_signer: a["isSigner"].as_bool().unwrap_or(false),
                is_writable: a["isWritable"].as_bool().unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let data = B64
        .decode(ix["data"].as_str().ok_or_else(|| anyhow!("Missing data"))?)
        .map_err(|e| anyhow!("Failed to decode instruction data: {}", e))?;

    Ok(Instruction { program_id, accounts, data })
}
