export interface AgentConfig {
  rpcUrl: string;
  walletPrivateKey: string;
  dryRun: boolean;
  heliusApiKey: string;
  enableArb: boolean;
  enableAmmImbalance: boolean;
  // add other config
}

export interface Opportunity {
  id: string;
  profit: number;
  // add other properties
}