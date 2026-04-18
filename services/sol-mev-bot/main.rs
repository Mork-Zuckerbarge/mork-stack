use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

mod bundle;
mod tx_builder;

use bundle::JitoBundleSender;
use tx_builder::TransactionBuilder;

/// Command sent from Node.js orchestrator over TCP IPC
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeCommand {
    /// Execute a Jupiter swap via Jito bundle
    ExecuteSwap {
        id: String,
        wallet_secret: String,   // base58 private key
        input_mint: String,
        output_mint: String,
        amount_in: u64,
        min_amount_out: u64,
        jito_tip_lamports: u64,
        dry_run: bool,
    },
    /// Execute two swap legs atomically (for arbitrage)
    ExecuteArbBundle {
        id: String,
        wallet_secret: String,
        leg1_tx_base64: String,
        leg2_tx_base64: String,
        jito_tip_lamports: u64,
        dry_run: bool,
    },
    /// Health check
    Ping,
}

/// Result sent back to Node.js
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineResult {
    SwapResult {
        id: String,
        success: bool,
        bundle_id: Option<String>,
        slot: Option<u64>,
        error: Option<String>,
    },
    Pong {
        version: &'static str,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()),
        )
        .init();

    let port = std::env::var("MEV_ENGINE_PORT").unwrap_or_else(|_| "9000".to_string());
    let rpc_url = std::env::var("HELIUS_RPC_URL")
        .expect("HELIUS_RPC_URL must be set");
    let jito_url = std::env::var("JITO_BLOCK_ENGINE_URL")
        .unwrap_or_else(|_| "https://mainnet.block-engine.jito.wtf".to_string());

    let bundle_sender = Arc::new(Mutex::new(
        JitoBundleSender::new(jito_url.clone()).await?,
    ));
    let tx_builder = Arc::new(TransactionBuilder::new(rpc_url));

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await?;
    info!("MEV Rust engine listening on {} (Jito: {})", addr, jito_url);

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                info!("Node.js connected from {}", peer);
                let sender = Arc::clone(&bundle_sender);
                let builder = Arc::clone(&tx_builder);
                tokio::spawn(handle_connection(stream, sender, builder));
            }
            Err(e) => error!("Accept error: {}", e),
        }
    }
}

async fn handle_connection(
    stream: TcpStream,
    bundle_sender: Arc<Mutex<JitoBundleSender>>,
    tx_builder: Arc<TransactionBuilder>,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let result = match serde_json::from_str::<NodeCommand>(&line) {
            Ok(cmd) => process_command(cmd, &bundle_sender, &tx_builder).await,
            Err(e) => {
                warn!("Failed to parse command: {} — input: {}", e, &line[..line.len().min(100)]);
                continue;
            }
        };

        let response = serde_json::to_string(&result).unwrap_or_default();
        if let Err(e) = writer.write_all(format!("{}\n", response).as_bytes()).await {
            error!("Failed to write response: {}", e);
            break;
        }
    }

    info!("Node.js connection closed");
}

async fn process_command(
    cmd: NodeCommand,
    bundle_sender: &Arc<Mutex<JitoBundleSender>>,
    tx_builder: &Arc<TransactionBuilder>,
) -> EngineResult {
    match cmd {
        NodeCommand::Ping => EngineResult::Pong { version: env!("CARGO_PKG_VERSION") },

        NodeCommand::ExecuteArbBundle {
            id,
            leg1_tx_base64,
            leg2_tx_base64,
            jito_tip_lamports,
            dry_run,
            ..
        } => {
            if dry_run {
                info!("[DRY RUN] Would send arb bundle id={}", id);
                return EngineResult::SwapResult {
                    id,
                    success: true,
                    bundle_id: Some("dry-run".to_string()),
                    slot: None,
                    error: None,
                };
            }

            let sender = bundle_sender.lock().await;
            match sender
                .send_arb_bundle(&leg1_tx_base64, &leg2_tx_base64, jito_tip_lamports)
                .await
            {
                Ok((bundle_id, slot)) => {
                    info!("Bundle landed id={} slot={:?}", id, slot);
                    EngineResult::SwapResult {
                        id,
                        success: true,
                        bundle_id: Some(bundle_id),
                        slot,
                        error: None,
                    }
                }
                Err(e) => {
                    error!("Bundle failed id={}: {}", id, e);
                    EngineResult::SwapResult {
                        id,
                        success: false,
                        bundle_id: None,
                        slot: None,
                        error: Some(e.to_string()),
                    }
                }
            }
        }

        NodeCommand::ExecuteSwap {
            id,
            wallet_secret,
            input_mint,
            output_mint,
            amount_in,
            min_amount_out,
            jito_tip_lamports,
            dry_run,
        } => {
            if dry_run {
                info!("[DRY RUN] Would swap {} {} → {}", amount_in, input_mint, output_mint);
                return EngineResult::SwapResult {
                    id,
                    success: true,
                    bundle_id: Some("dry-run".to_string()),
                    slot: None,
                    error: None,
                };
            }

            match tx_builder
                .build_swap_tx(
                    &wallet_secret,
                    &input_mint,
                    &output_mint,
                    amount_in,
                    min_amount_out,
                )
                .await
            {
                Ok(tx_base64) => {
                    let sender = bundle_sender.lock().await;
                    match sender.send_single_tx(&tx_base64, jito_tip_lamports).await {
                        Ok((bundle_id, slot)) => EngineResult::SwapResult {
                            id,
                            success: true,
                            bundle_id: Some(bundle_id),
                            slot,
                            error: None,
                        },
                        Err(e) => EngineResult::SwapResult {
                            id,
                            success: false,
                            bundle_id: None,
                            slot: None,
                            error: Some(e.to_string()),
                        },
                    }
                }
                Err(e) => EngineResult::SwapResult {
                    id,
                    success: false,
                    bundle_id: None,
                    slot: None,
                    error: Some(e.to_string()),
                },
            }
        }
    }
}
