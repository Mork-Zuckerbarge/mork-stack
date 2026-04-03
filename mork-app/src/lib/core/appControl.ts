import { execFileSync } from "node:child_process";

export type RuntimeStatus = "running" | "stopped";

type ServiceName = "arb" | "sherpa";

type ServiceControlConfig = {
  startCommandEnv: "MORK_ARB_START_CMD" | "MORK_SHERPA_START_CMD";
  stopCommandEnv: "MORK_ARB_STOP_CMD" | "MORK_SHERPA_STOP_CMD";
  statusCommandEnv: "MORK_ARB_STATUS_CMD" | "MORK_SHERPA_STATUS_CMD";
};

const SERVICE_CONFIG: Record<ServiceName, ServiceControlConfig> = {
  arb: {
    startCommandEnv: "MORK_ARB_START_CMD",
    stopCommandEnv: "MORK_ARB_STOP_CMD",
    statusCommandEnv: "MORK_ARB_STATUS_CMD",
  },
  sherpa: {
    startCommandEnv: "MORK_SHERPA_START_CMD",
    stopCommandEnv: "MORK_SHERPA_STOP_CMD",
    statusCommandEnv: "MORK_SHERPA_STATUS_CMD",
  },
};

export type AppControlState = {
  arb: {
    status: RuntimeStatus;
    updatedAt: string;
  };
  sherpa: {
    status: RuntimeStatus;
    updatedAt: string;
  };
  controls: {
    memoryEnabled: boolean;
    plannerEnabled: boolean;
    messagingEnabled: boolean;
    walletAutoRefreshEnabled: boolean;
  };
  walletProvisioning: {
    status: "provisioned_existing" | "needs_setup";
    address: string | null;
  };
};

const nowIso = () => new Date().toISOString();

const state: AppControlState = {
  arb: {
    status: "stopped",
    updatedAt: nowIso(),
  },
  sherpa: {
    status: "stopped",
    updatedAt: nowIso(),
  },
  controls: {
    memoryEnabled: true,
    plannerEnabled: true,
    messagingEnabled: true,
    walletAutoRefreshEnabled: true,
  },
  walletProvisioning: {
    status: "needs_setup",
    address: null,
  },
};

function runControlCommand(command: string) {
  return execFileSync("/bin/bash", ["-lc", command], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function getRequiredCommand(envVar: ServiceControlConfig[keyof ServiceControlConfig], actionLabel: string) {
  const command = process.env[envVar]?.trim();
  if (!command) {
    throw new Error(`${actionLabel} is unavailable: missing ${envVar}`);
  }
  return command;
}

function parseRuntimeStatus(raw: string): RuntimeStatus | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;

  const truthy = new Set(["running", "run", "up", "active", "1", "true", "yes"]);
  const falsy = new Set(["stopped", "stop", "down", "inactive", "0", "false", "no"]);

  if (truthy.has(normalized)) return "running";
  if (falsy.has(normalized)) return "stopped";
  return null;
}

function readServiceStatus(service: ServiceName): RuntimeStatus | null {
  const { statusCommandEnv } = SERVICE_CONFIG[service];
  const statusCommand = process.env[statusCommandEnv]?.trim();
  if (!statusCommand) {
    return null;
  }

  const output = runControlCommand(statusCommand);
  const status = parseRuntimeStatus(output);
  if (!status) {
    throw new Error(
      `${service} status command (${statusCommandEnv}) must return one of: running/stopped/up/down/active/inactive/true/false/1/0`
    );
  }

  return status;
}

function refreshServiceStatus(service: ServiceName) {
  const nextStatus = readServiceStatus(service);
  if (!nextStatus) return;

  if (state[service].status !== nextStatus) {
    state[service].status = nextStatus;
    state[service].updatedAt = nowIso();
  }
}

function runServiceTransition(service: ServiceName, action: "start" | "stop") {
  const config = SERVICE_CONFIG[service];
  const commandEnv = action === "start" ? config.startCommandEnv : config.stopCommandEnv;
  const expectedStatus: RuntimeStatus = action === "start" ? "running" : "stopped";

  const controlCommand = getRequiredCommand(commandEnv, `${service}.${action}`);
  runControlCommand(controlCommand);

  const resolvedStatus = readServiceStatus(service);
  if (!resolvedStatus) {
    throw new Error(
      `${service}.${action} cannot be verified: missing ${config.statusCommandEnv}`
    );
  }

  if (resolvedStatus !== expectedStatus) {
    throw new Error(
      `${service}.${action} did not reach ${expectedStatus}; runtime reports ${resolvedStatus}`
    );
  }

  state[service].status = resolvedStatus;
  state[service].updatedAt = nowIso();
}

export function getAppControlState(): AppControlState {
  const configuredWallet = process.env.MORK_WALLET?.trim() || null;
  state.walletProvisioning = configuredWallet
    ? {
        status: "provisioned_existing",
        address: configuredWallet,
      }
    : {
        status: "needs_setup",
        address: null,
      };

  refreshServiceStatus("arb");
  refreshServiceStatus("sherpa");

  return structuredClone(state);
}

export function startArb() {
  runServiceTransition("arb", "start");
  return getArbStatus();
}

export function stopArb() {
  runServiceTransition("arb", "stop");
  return getArbStatus();
}

export function getArbStatus() {
  refreshServiceStatus("arb");
  return structuredClone(state.arb);
}

export function startSherpa() {
  runServiceTransition("sherpa", "start");
  return getSherpaStatus();
}

export function stopSherpa() {
  runServiceTransition("sherpa", "stop");
  return getSherpaStatus();
}

export function getSherpaStatus() {
  refreshServiceStatus("sherpa");
  return structuredClone(state.sherpa);
}

export function setControlFlag(
  key: keyof AppControlState["controls"],
  value: boolean
) {
  state.controls[key] = value;
  return getAppControlState().controls;
}

export function isMemoryEnabled() {
  return state.controls.memoryEnabled;
}

export function isPlannerEnabled() {
  return state.controls.plannerEnabled;
}

export function isMessagingEnabled() {
  return state.controls.messagingEnabled;
}

export function isWalletAutoRefreshEnabled() {
  return state.controls.walletAutoRefreshEnabled;
}
