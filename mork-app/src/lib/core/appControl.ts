export type RuntimeStatus = "running" | "stopped";

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

  return structuredClone(state);
}

export function startArb() {
  state.arb.status = "running";
  state.arb.updatedAt = nowIso();
  return getArbStatus();
}

export function stopArb() {
  state.arb.status = "stopped";
  state.arb.updatedAt = nowIso();
  return getArbStatus();
}

export function getArbStatus() {
  return structuredClone(state.arb);
}

export function startSherpa() {
  state.sherpa.status = "running";
  state.sherpa.updatedAt = nowIso();
  return getSherpaStatus();
}

export function stopSherpa() {
  state.sherpa.status = "stopped";
  state.sherpa.updatedAt = nowIso();
  return getSherpaStatus();
}

export function getSherpaStatus() {
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
