export const APP_DEFAULTS = {
  name: "Mork App",
  agentName: "Custom BBQ Agent",
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

export const BBQ_TOKEN = {
  symbol: "BBQ",
  mint: "B59tYSWnDNTDbTsDXvhmXghJXsyunPsXfYFr7KfXBqYn",
  requiredBalance: 1000,
  maxSellSurplusPct: 0.25,
} as const;
