import { prisma } from "./prisma";

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
const APP_CONTROL_FACT_KEY = "__app_control_state_v1__";

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

let hasLoadedPersistedState = false;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function applyPersistedState(raw: unknown) {
  if (!isObjectRecord(raw)) return;

  const arb = raw.arb;
  if (isObjectRecord(arb) && (arb.status === "running" || arb.status === "stopped")) {
    state.arb.status = arb.status;
    if (typeof arb.updatedAt === "string") state.arb.updatedAt = arb.updatedAt;
  }

  const sherpa = raw.sherpa;
  if (isObjectRecord(sherpa) && (sherpa.status === "running" || sherpa.status === "stopped")) {
    state.sherpa.status = sherpa.status;
    if (typeof sherpa.updatedAt === "string") state.sherpa.updatedAt = sherpa.updatedAt;
  }

  const controls = raw.controls;
  if (isObjectRecord(controls)) {
    if (typeof controls.memoryEnabled === "boolean") {
      state.controls.memoryEnabled = controls.memoryEnabled;
    }
    if (typeof controls.plannerEnabled === "boolean") {
      state.controls.plannerEnabled = controls.plannerEnabled;
    }
    if (typeof controls.messagingEnabled === "boolean") {
      state.controls.messagingEnabled = controls.messagingEnabled;
    }
    if (typeof controls.walletAutoRefreshEnabled === "boolean") {
      state.controls.walletAutoRefreshEnabled = controls.walletAutoRefreshEnabled;
    }
  }
}

async function ensureStateLoaded() {
  if (hasLoadedPersistedState) return;

  const row = await prisma.memoryFact.findUnique({
    where: { key: APP_CONTROL_FACT_KEY },
  });

  if (row?.value) {
    try {
      const parsed: unknown = JSON.parse(row.value);
      applyPersistedState(parsed);
    } catch {
      // Ignore invalid persisted state and keep defaults.
    }
  }

  hasLoadedPersistedState = true;
}

async function persistState() {
  await prisma.memoryFact.upsert({
    where: { key: APP_CONTROL_FACT_KEY },
    create: {
      key: APP_CONTROL_FACT_KEY,
      value: JSON.stringify({
        arb: state.arb,
        sherpa: state.sherpa,
        controls: state.controls,
      }),
      source: "system",
      weight: 9,
    },
    update: {
      value: JSON.stringify({
        arb: state.arb,
        sherpa: state.sherpa,
        controls: state.controls,
      }),
      source: "system",
      weight: 9,
    },
  });
}

export async function getAppControlState(): Promise<AppControlState> {
  await ensureStateLoaded();

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

export async function startArb() {
  await ensureStateLoaded();
  state.arb.status = "running";
  state.arb.updatedAt = nowIso();
  await persistState();
  return getArbStatus();
}

export async function stopArb() {
  await ensureStateLoaded();
  state.arb.status = "stopped";
  state.arb.updatedAt = nowIso();
  await persistState();
  return getArbStatus();
}

export function getArbStatus() {
  return structuredClone(state.arb);
}

export async function startSherpa() {
  await ensureStateLoaded();
  state.sherpa.status = "running";
  state.sherpa.updatedAt = nowIso();
  await persistState();
  return getSherpaStatus();
}

export async function stopSherpa() {
  await ensureStateLoaded();
  state.sherpa.status = "stopped";
  state.sherpa.updatedAt = nowIso();
  await persistState();
  return getSherpaStatus();
}

export function getSherpaStatus() {
  return structuredClone(state.sherpa);
}

export async function setControlFlag(
  key: keyof AppControlState["controls"],
  value: boolean
) {
  await ensureStateLoaded();
  state.controls[key] = value;
  await persistState();
  return structuredClone(state.controls);
}

export async function isMemoryEnabled() {
  await ensureStateLoaded();
  return state.controls.memoryEnabled;
}

export async function isPlannerEnabled() {
  await ensureStateLoaded();
  return state.controls.plannerEnabled;
}

export async function isMessagingEnabled() {
  await ensureStateLoaded();
  return state.controls.messagingEnabled;
}

export async function isWalletAutoRefreshEnabled() {
  await ensureStateLoaded();
  return state.controls.walletAutoRefreshEnabled;
}
