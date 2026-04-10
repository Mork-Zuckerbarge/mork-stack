import { prisma } from "./prisma";
import { resolveWalletConfigFromEnv } from "./walletConfig";
import fs from "node:fs";
import path from "node:path";

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
    telegramEnabled: boolean;
    xEnabled: boolean;
    walletAutoRefreshEnabled: boolean;
    appPersonaMode: string;
    telegramPersonaMode: string;
    xPersonaMode: string;
    appPersonaGuidelines: string;
    telegramPersonaGuidelines: string;
    xPersonaGuidelines: string;
    selectedOllamaModel: string;
    startupCompleted: boolean;
    executionAuthority: {
      mode: "user_only" | "agent_assisted" | "emergency_stop";
      maxTradeUsd: number;
      mintAllowlist: string[];
      cooldownMinutes: number;
    };
    responsePolicy: {
      maxResponseChars: number;
      allowUrls: boolean;
      allowUserMessageQuotes: boolean;
      behaviorGuidelines: string;
    };
    activePanel: "arb" | "trade";
  };
  walletProvisioning: {
    status: "provisioned_existing" | "needs_setup";
    address: string | null;
    source: "MORK_WALLET" | "MORK_WALLET_SECRET_KEY" | "unconfigured";
  };
};

type BooleanControlKey = "memoryEnabled" | "plannerEnabled" | "telegramEnabled" | "xEnabled" | "walletAutoRefreshEnabled";

const nowIso = () => new Date().toISOString();
const APP_CONTROL_FACT_KEY = "__app_control_state_v1__";
const AUTO_START_ON_BOOT = process.env.MORK_AUTO_START_ON_BOOT !== "0";
const STARTUP_ALLOWLIST_LIMIT = 500;
const FALLBACK_TOKEN_CSV =
  "https://raw.githubusercontent.com/igneous-labs/jup-token-list/main/validated-tokens.csv";

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
    telegramEnabled: true,
    xEnabled: true,
    walletAutoRefreshEnabled: true,
    appPersonaMode: "code-first",
    telegramPersonaMode: "ceo-helpful",
    xPersonaMode: "cynical-banter",
    appPersonaGuidelines: "",
    telegramPersonaGuidelines: "",
    xPersonaGuidelines: "",
    selectedOllamaModel: process.env.OLLAMA_MODEL || "llama3.2:3b",
    startupCompleted: false,
    executionAuthority: {
      mode: "user_only",
      maxTradeUsd: 50,
      mintAllowlist: [],
      cooldownMinutes: 15,
    },
    responsePolicy: {
      maxResponseChars: 12000,
      allowUrls: false,
      allowUserMessageQuotes: false,
      behaviorGuidelines:
        "Do NOT act like the TV character from Mork & Mindy.\nNever say: nanu nanu, na-nu, shazbot, gleeb, gleek, ork.\nDo not create false information.\nIf you do not know something, say so plainly.",
    },
    activePanel: "trade",
  },
  walletProvisioning: {
    status: "needs_setup",
    address: null,
    source: "unconfigured",
  },
};

let hasLoadedPersistedState = false;

function normalizeMintList(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const mint = (value || "").trim();
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
    if (out.length >= limit) break;
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "\"" && next === "\"") {
      cur += "\"";
      i += 1;
      continue;
    }
    if (ch === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function pickHeaderIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map((item) => item.toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

function readWhitelistMints(limit: number): string[] {
  const whitelistPath = path.resolve(process.cwd(), "../services/arb/whitelist.json");
  if (!fs.existsSync(whitelistPath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const mints = parsed.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") return item.inMint;
      return "";
    });
    return normalizeMintList(mints, limit);
  } catch {
    return [];
  }
}

async function fetchFallbackMints(limit: number): Promise<string[]> {
  try {
    const response = await fetch(FALLBACK_TOKEN_CSV, {
      headers: { accept: "text/plain" },
      cache: "no-store",
    });
    if (!response.ok) return [];
    const csv = await response.text();
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    const mintIdx = pickHeaderIndex(headers, ["address", "mint", "mintaddress", "token_address"]);
    if (mintIdx < 0) return [];
    return normalizeMintList(lines.slice(1).map((line) => parseCsvLine(line)[mintIdx] || ""), limit);
  } catch {
    return [];
  }
}

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
    if (typeof controls.telegramEnabled === "boolean") {
      state.controls.telegramEnabled = controls.telegramEnabled;
    }
    if (typeof controls.xEnabled === "boolean") {
      state.controls.xEnabled = controls.xEnabled;
    }
    if (typeof controls.walletAutoRefreshEnabled === "boolean") {
      state.controls.walletAutoRefreshEnabled = controls.walletAutoRefreshEnabled;
    }
    if (typeof controls.appPersonaMode === "string") {
      state.controls.appPersonaMode = controls.appPersonaMode;
    }
    if (typeof controls.telegramPersonaMode === "string") {
      state.controls.telegramPersonaMode = controls.telegramPersonaMode;
    }
    if (typeof controls.xPersonaMode === "string") {
      state.controls.xPersonaMode = controls.xPersonaMode;
    }
    if (typeof controls.appPersonaGuidelines === "string") {
      state.controls.appPersonaGuidelines = controls.appPersonaGuidelines;
    }
    if (typeof controls.telegramPersonaGuidelines === "string") {
      state.controls.telegramPersonaGuidelines = controls.telegramPersonaGuidelines;
    }
    if (typeof controls.xPersonaGuidelines === "string") {
      state.controls.xPersonaGuidelines = controls.xPersonaGuidelines;
    }
    if (typeof controls.selectedOllamaModel === "string") {
      state.controls.selectedOllamaModel = controls.selectedOllamaModel;
    }
    if (typeof controls.startupCompleted === "boolean") {
      state.controls.startupCompleted = controls.startupCompleted;
    }
    const executionAuthority = controls.executionAuthority;
    if (isObjectRecord(executionAuthority)) {
      if (
        executionAuthority.mode === "user_only" ||
        executionAuthority.mode === "agent_assisted" ||
        executionAuthority.mode === "emergency_stop"
      ) {
        state.controls.executionAuthority.mode = executionAuthority.mode;
      }
      if (typeof executionAuthority.maxTradeUsd === "number") {
        state.controls.executionAuthority.maxTradeUsd = executionAuthority.maxTradeUsd;
      }
      if (
        Array.isArray(executionAuthority.mintAllowlist) &&
        executionAuthority.mintAllowlist.every((value) => typeof value === "string")
      ) {
        state.controls.executionAuthority.mintAllowlist = executionAuthority.mintAllowlist;
      }
      if (typeof executionAuthority.cooldownMinutes === "number") {
        state.controls.executionAuthority.cooldownMinutes = executionAuthority.cooldownMinutes;
      }
    }
    const responsePolicy = controls.responsePolicy;
    if (isObjectRecord(responsePolicy)) {
      if (typeof responsePolicy.maxResponseChars === "number") {
        state.controls.responsePolicy.maxResponseChars = responsePolicy.maxResponseChars;
      }
      if (typeof responsePolicy.allowUrls === "boolean") {
        state.controls.responsePolicy.allowUrls = responsePolicy.allowUrls;
      }
      if (typeof responsePolicy.allowUserMessageQuotes === "boolean") {
        state.controls.responsePolicy.allowUserMessageQuotes = responsePolicy.allowUserMessageQuotes;
      }
      if (typeof responsePolicy.behaviorGuidelines === "string") {
        state.controls.responsePolicy.behaviorGuidelines = responsePolicy.behaviorGuidelines;
      }
    }
    if (controls.activePanel === "arb" || controls.activePanel === "trade") {
      state.controls.activePanel = controls.activePanel;
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

  if (AUTO_START_ON_BOOT) {
    let shouldPersist = false;
    if (state.arb.status !== "running") {
      state.arb.status = "running";
      state.arb.updatedAt = nowIso();
      shouldPersist = true;
    }
    if (state.sherpa.status !== "running") {
      state.sherpa.status = "running";
      state.sherpa.updatedAt = nowIso();
      shouldPersist = true;
    }
    if (!state.controls.startupCompleted) {
      state.controls.startupCompleted = true;
      shouldPersist = true;
    }

    if (shouldPersist) {
      await persistState();
    }
  }

  if (state.controls.executionAuthority.mintAllowlist.length === 0) {
    const startupMints = readWhitelistMints(STARTUP_ALLOWLIST_LIMIT);
    const fallbackMints = startupMints.length > 0 ? startupMints : await fetchFallbackMints(STARTUP_ALLOWLIST_LIMIT);
    if (fallbackMints.length > 0) {
      state.controls.executionAuthority.mintAllowlist = fallbackMints;
      await persistState();
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

  const walletConfig = resolveWalletConfigFromEnv();
  state.walletProvisioning = walletConfig.address
    ? {
        status: "provisioned_existing",
        address: walletConfig.address,
        source: walletConfig.source,
      }
    : {
        status: "needs_setup",
        address: null,
        source: walletConfig.source,
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
  key: BooleanControlKey,
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
  return state.controls.telegramEnabled || state.controls.xEnabled;
}

export async function isWalletAutoRefreshEnabled() {
  await ensureStateLoaded();
  return state.controls.walletAutoRefreshEnabled;
}

export async function isChannelEnabled(channel: string) {
  await ensureStateLoaded();
  if (channel === "telegram") return state.controls.telegramEnabled;
  if (channel === "x") return state.controls.xEnabled;
  return true;
}

export async function setPersonaMode(
  channel: "app" | "telegram" | "x",
  mode: string
) {
  await ensureStateLoaded();
  if (channel === "app") state.controls.appPersonaMode = mode;
  if (channel === "telegram") state.controls.telegramPersonaMode = mode;
  if (channel === "x") state.controls.xPersonaMode = mode;
  await persistState();
  return structuredClone(state.controls);
}

export async function setPersonaGuidelines(
  channel: "app" | "telegram" | "x",
  guidelines: string
) {
  await ensureStateLoaded();
  if (channel === "app") state.controls.appPersonaGuidelines = guidelines;
  if (channel === "telegram") state.controls.telegramPersonaGuidelines = guidelines;
  if (channel === "x") state.controls.xPersonaGuidelines = guidelines;
  await persistState();
  return structuredClone(state.controls);
}

export async function setSelectedOllamaModel(model: string) {
  await ensureStateLoaded();
  state.controls.selectedOllamaModel = model;
  await persistState();
  return state.controls.selectedOllamaModel;
}

export async function setStartupCompleted(value: boolean) {
  await ensureStateLoaded();
  state.controls.startupCompleted = value;
  await persistState();
  return state.controls.startupCompleted;
}

export async function setExecutionAuthority(input: {
  mode: "user_only" | "agent_assisted" | "emergency_stop";
  maxTradeUsd: number;
  mintAllowlist: string[];
  cooldownMinutes: number;
}) {
  await ensureStateLoaded();
  state.controls.executionAuthority = {
    mode: input.mode,
    maxTradeUsd: input.maxTradeUsd,
    mintAllowlist: input.mintAllowlist,
    cooldownMinutes: input.cooldownMinutes,
  };
  await persistState();
  return structuredClone(state.controls.executionAuthority);
}

export async function setResponsePolicy(input: {
  maxResponseChars: number;
  allowUrls: boolean;
  allowUserMessageQuotes: boolean;
  behaviorGuidelines: string;
}) {
  await ensureStateLoaded();
  state.controls.responsePolicy = {
    maxResponseChars: Math.min(20000, Math.max(120, Math.round(input.maxResponseChars))),
    allowUrls: input.allowUrls,
    allowUserMessageQuotes: input.allowUserMessageQuotes,
    behaviorGuidelines: input.behaviorGuidelines,
  };
  await persistState();
  return structuredClone(state.controls.responsePolicy);
}

export async function setActivePanel(panel: "arb" | "trade") {
  await ensureStateLoaded();
  state.controls.activePanel = panel;
  await persistState();
  return state.controls.activePanel;
}
