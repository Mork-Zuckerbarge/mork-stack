export const APP_DEFAULTS = {
  name: "Mork App",
  agentName: "Custom Agent",
  primeDirective: "Prime directives: accuracy, honesty, safety, and clear user control.",
  ollamaModel: "llama3.2:3b",
  ollamaHost: "http://127.0.0.1:11434",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  jupiterBaseUrl: "https://api.jup.ag",
  jupiterLiteBaseUrl: "https://lite-api.jup.ag",
  jupiterTimeoutMs: 10_000,
  morkCoreUrl: "http://127.0.0.1:8790",
  morkCoreServiceFallbackUrl: "http://mork-core:8790",
} as const;

export const RESERVE_TOKEN = {
  symbol: process.env.MORK_RESERVE_TOKEN_SYMBOL?.trim() || "RESERVE",
  mint: process.env.MORK_RESERVE_TOKEN_MINT?.trim() || "",
  requiredBalance: Number(process.env.MORK_RESERVE_TOKEN_REQUIRED_BALANCE || 0),
  maxSellSurplusPct: Number(process.env.MORK_RESERVE_TOKEN_MAX_SELL_SURPLUS_PCT || 0.25),
} as const;

// Compatibility alias for older modules while production defaults stay brand-neutral.
export const BBQ_TOKEN = RESERVE_TOKEN;
