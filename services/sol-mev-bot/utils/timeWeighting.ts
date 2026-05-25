// UTC-hour multipliers applied to minProfitLamports in the fee simulator.
// Peak competition hours (US/EU opens) raise the threshold — we only take
// high-quality opportunities when other bots are also most active.
// Overnight APAC hours lower the threshold — fewer competitors, accept smaller edge.
const HOUR_MULTIPLIERS: Record<number, number> = {
  14: 1.5, 15: 1.5, 16: 1.3,             // US market open — peak MEV competition
  8: 1.2,  9: 1.2,  10: 1.1,             // EU market open
  17: 1.1, 18: 1.0, 19: 1.0,             // US mid-session
  20: 0.9, 21: 0.85, 22: 0.8, 23: 0.75, // post-US-close
  0: 0.7,  1: 0.65, 2: 0.65, 3: 0.65,   // overnight APAC
  4: 0.7,  5: 0.75, 6: 0.8,  7: 0.9,    // pre-EU ramp-up
};

export function getTimeMultiplier(): number {
  const hour = new Date().getUTCHours();
  return HOUR_MULTIPLIERS[hour] ?? 1.0;
}

export function adjustedMinProfit(baseMinProfitLamports: number): number {
  return Math.round(baseMinProfitLamports * getTimeMultiplier());
}
