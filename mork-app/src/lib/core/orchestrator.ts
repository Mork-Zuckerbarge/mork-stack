import {
  getAppControlState,
  setControlFlag,
  setExecutionAuthority,
  setResponsePolicy,
  setPersonaGuidelines,
  setPersonaMode,
  setSelectedOllamaModel,
  setStartupCompleted,
  startArb,
  startSherpa,
  stopArb,
  stopSherpa,
} from "./appControl";

type HealthStatus = "healthy" | "degraded" | "stopped" | "unknown";
type HealthComponent = "app" | "wallet" | "chat" | "arb" | "sherpa";
type RuntimeFlagKey =
  | "memoryEnabled"
  | "plannerEnabled"
  | "telegramEnabled"
  | "xEnabled"
  | "walletAutoRefreshEnabled";

type HealthRecord = {
  status: HealthStatus;
  message: string;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();

const healthRegistry: Record<HealthComponent, HealthRecord> = {
  app: { status: "unknown", message: "not checked yet", updatedAt: nowIso() },
  wallet: { status: "unknown", message: "not checked yet", updatedAt: nowIso() },
  chat: { status: "unknown", message: "not checked yet", updatedAt: nowIso() },
  arb: { status: "unknown", message: "not checked yet", updatedAt: nowIso() },
  sherpa: { status: "unknown", message: "not checked yet", updatedAt: nowIso() },
};

export async function startOrchestrator() {
  await setStartupCompleted(true);
  updateHealth("app", "healthy", "orchestrator started");
  return getOrchestratorState();
}

export async function stopOrchestrator() {
  await Promise.all([stopArb(), stopSherpa()]);
  await setStartupCompleted(false);
  updateHealth("arb", "stopped", "stopped by orchestrator");
  updateHealth("sherpa", "stopped", "stopped by orchestrator");
  updateHealth("app", "stopped", "orchestrator stopped");
  return getOrchestratorState();
}

export async function startRuntime(module: "arb" | "sherpa") {
  if (module === "arb") {
    await startArb();
    updateHealth("arb", "healthy", "running");
  } else {
    await startSherpa();
    updateHealth("sherpa", "healthy", "running");
  }
  return getOrchestratorState();
}

export async function stopRuntime(module: "arb" | "sherpa") {
  if (module === "arb") {
    await stopArb();
    updateHealth("arb", "stopped", "stopped");
  } else {
    await stopSherpa();
    updateHealth("sherpa", "stopped", "stopped");
  }
  return getOrchestratorState();
}

export async function setRuntimeFlag(key: RuntimeFlagKey, value: boolean) {
  await setControlFlag(key, value);
  return getOrchestratorState();
}

export async function setRuntimePersonaMode(
  channel: "app" | "telegram" | "x",
  mode: string
) {
  await setPersonaMode(channel, mode);
  return getOrchestratorState();
}

export async function setRuntimePersonaGuidelines(
  channel: "app" | "telegram" | "x",
  guidelines: string
) {
  await setPersonaGuidelines(channel, guidelines);
  return getOrchestratorState();
}

export async function setRuntimeModel(model: string) {
  await setSelectedOllamaModel(model);
  return getOrchestratorState();
}

export async function setRuntimeExecutionAuthority(input: {
  mode: "user_only" | "agent_assisted" | "emergency_stop";
  maxTradeUsd: number;
  mintAllowlist: string[];
  cooldownMinutes: number;
}) {
  await setExecutionAuthority(input);
  return getOrchestratorState();
}

export async function setRuntimeStartupCompleted(value: boolean) {
  await setStartupCompleted(value);
  updateHealth("app", value ? "healthy" : "stopped", value ? "startup complete" : "startup pending");
  return getOrchestratorState();
}

export async function setRuntimeResponsePolicy(input: {
  maxResponseChars: number;
  allowUrls: boolean;
  allowUserMessageQuotes: boolean;
  behaviorGuidelines: string;
}) {
  await setResponsePolicy(input);
  return getOrchestratorState();
}

export function updateHealth(
  component: HealthComponent,
  status: HealthStatus,
  message: string
) {
  healthRegistry[component] = {
    status,
    message,
    updatedAt: nowIso(),
  };
}

export function getHealthRegistry() {
  return structuredClone(healthRegistry);
}

export async function isMemoryEnabled() {
  const state = await getAppControlState();
  return state.controls.memoryEnabled;
}

export async function isPlannerEnabled() {
  const state = await getAppControlState();
  return state.controls.plannerEnabled;
}

export async function isWalletAutoRefreshEnabled() {
  const state = await getAppControlState();
  return state.controls.walletAutoRefreshEnabled;
}

export async function isChannelEnabled(channel: string) {
  const state = await getAppControlState();
  if (channel === "telegram") return state.controls.telegramEnabled;
  if (channel === "x") return state.controls.xEnabled;
  return true;
}

export async function getOrchestratorState() {
  const app = await getAppControlState();

  updateHealth("app", app.controls.startupCompleted ? "healthy" : "degraded", app.controls.startupCompleted ? "startup complete" : "startup pending");
  updateHealth("arb", app.arb.status === "running" ? "healthy" : "stopped", app.arb.status);
  updateHealth("sherpa", app.sherpa.status === "running" ? "healthy" : "stopped", app.sherpa.status);

  return {
    app,
    health: getHealthRegistry(),
    runtimeFlagOwner: "orchestrator",
  };
}
