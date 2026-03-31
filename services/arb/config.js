module.exports = {
  RPC_URL: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  BASE_QUOTE: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },

  MAX_TOKENS: 500,

  LOOP_DELAY_MS: 8000,

  MIN_EDGE_PCT: 0.10,
  MIN_ABS_PROFIT_USD: 0.01,

  // Safety filters
  EXCLUDE_TAGS: [
    "lp-token",
    "leveraged",
    "derivative",
    "wrapped",
  ],
};

