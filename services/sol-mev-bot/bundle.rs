use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::Client;
use serde_json::{json, Value};
use solana_sdk::{
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_instruction,
    transaction::VersionedTransaction,
};
use std::str::FromStr;
use std::time::Duration;
use tracing::{debug, info, warn};

/// Jito tip accounts — randomly selected per bundle
const TIP_ACCOUNTS: &[&str] = &[
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13eDzZQD",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
];

pub struct JitoBundleSender {
    client: Client,
    block_engine_url: String,
}

impl JitoBundleSender {
    pub async fn new(block_engine_url: String) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()?;

        // Verify connectivity
        let ping = client
            .get(format!("{}/api/v1/bundles", block_engine_url))
            .send()
            .await;

        match ping {
            Ok(_) => info!("Jito block engine reachable at {}", block_engine_url),
            Err(e) => warn!("Could not pre-connect to Jito (will retry on send): {}", e),
        }

        Ok(Self { client, block_engine_url })
    }

    /// Send two pre-signed transactions as an atomic Jito bundle.
    /// The tip is appended to the second transaction's instructions.
    pub async fn send_arb_bundle(
        &self,
        leg1_base64: &str,
        leg2_base64: &str,
        tip_lamports: u64,
    ) -> Result<(String, Option<u64>)> {
        let txs = vec![leg1_base64.to_string(), leg2_base64.to_string()];
        self.send_bundle_raw(txs, tip_lamports).await
    }

    /// Send a single transaction as a Jito bundle (still benefits from
    /// priority ordering and atomic execution guarantees).
    pub async fn send_single_tx(
        &self,
        tx_base64: &str,
        tip_lamports: u64,
    ) -> Result<(String, Option<u64>)> {
        self.send_bundle_raw(vec![tx_base64.to_string()], tip_lamports).await
    }

    async fn send_bundle_raw(
        &self,
        encoded_txs: Vec<String>,
        _tip_lamports: u64,
    ) -> Result<(String, Option<u64>)> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendBundle",
            "params": [encoded_txs]
        });

        let url = format!("{}/api/v1/bundles", self.block_engine_url);
        let res = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if let Some(err) = res.get("error") {
            return Err(anyhow!("Jito RPC error: {}", err));
        }

        let bundle_id = res["result"]
            .as_str()
            .ok_or_else(|| anyhow!("No bundle_id in response"))?
            .to_string();

        info!("Bundle submitted: {}", bundle_id);

        // Poll for confirmation
        let slot = self.poll_bundle_status(&bundle_id).await?;
        Ok((bundle_id, slot))
    }

    async fn poll_bundle_status(&self, bundle_id: &str) -> Result<Option<u64>> {
        let url = format!("{}/api/v1/bundles", self.block_engine_url);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);

        loop {
            if tokio::time::Instant::now() >= deadline {
                warn!("Bundle {} confirmation timeout", bundle_id);
                return Ok(None);
            }

            tokio::time::sleep(Duration::from_millis(1500)).await;

            let payload = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getBundleStatuses",
                "params": [[bundle_id]]
            });

            let res = match self.client.post(&url).json(&payload).send().await {
                Ok(r) => match r.json::<Value>().await {
                    Ok(v) => v,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };

            let statuses = match res["result"]["value"].as_array() {
                Some(arr) => arr.clone(),
                None => continue,
            };

            for status in &statuses {
                if status["bundle_id"].as_str() != Some(bundle_id) {
                    continue;
                }

                let confirmation = status["confirmation_status"].as_str().unwrap_or("");
                debug!("Bundle {} status: {}", bundle_id, confirmation);

                if confirmation == "confirmed" || confirmation == "finalized" {
                    let slot = status["slot"].as_u64();
                    info!("Bundle {} landed at slot {:?}", bundle_id, slot);
                    return Ok(slot);
                }

                if status["err"].is_object() {
                    return Err(anyhow!("Bundle failed on-chain: {}", status["err"]));
                }
            }
        }
    }

    /// Build a tip transfer instruction for the given keypair.
    /// Called by tx_builder before signing.
    pub fn tip_account() -> Pubkey {
        let idx = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis() as usize)
            % TIP_ACCOUNTS.len();
        Pubkey::from_str(TIP_ACCOUNTS[idx]).unwrap()
    }
}
