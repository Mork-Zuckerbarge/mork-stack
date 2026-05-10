import { getAppControlState } from "@/lib/core/appControl";
import { resolveOllamaHost } from "@/lib/core/ollamaHost";
import { resolveWalletAddressFromEnv } from "@/lib/core/walletConfig";
import { access } from "node:fs/promises";
import path from "node:path";

export type PreflightCheck = {
  key:
    | "ollama_reachable"
    | "model_available"
    | "wallet_configured"
    | "sherpa_bootstrap"
    | "mork_core_health"
    | "mork_core_chat_v2"
    | "mork_core_compose"
    | "mork_core_prisma_query";
  ok: boolean;
  message: string;
  action?: string;
};

export type PreflightStatus = {
  ok: boolean;
  checks: PreflightCheck[];
};

type OllamaTagResponse = {
  models?: Array<{ name?: string }>;
};

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

async function fetchOllamaModels(host: string): Promise<string[]> {
  const { signal, clear } = withTimeout(4000);

  try {
    const res = await fetch(`${host}/api/tags`, { signal, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`);
    }

    const data = (await res.json()) as OllamaTagResponse;
    return (data.models || []).map((model) => String(model.name || "").trim()).filter(Boolean);
  } finally {
    clear();
  }
}

async function hasSherpaVenv() {
  const venvPython = path.resolve(process.cwd(), "../services/sherpa/.venv/bin/python");
  try {
    await access(venvPython);
    return true;
  } catch {
    return false;
  }
}

async function probeCore(baseUrl: string) {
  const core = baseUrl.replace(/\/+$/, "");
  const deepProbe = process.env.MORK_PREFLIGHT_DEEP_CORE_PROBES === "1";
  const requestWithTimeout = async (url: string, init: RequestInit, timeoutMs = 4000) => {
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      return await fetch(url, { ...init, signal, cache: "no-store" });
    } catch {
      return null;
    } finally {
      clear();
    }
  };

  const postJson = async (paths: string[], payload: Record<string, unknown>) => {
    for (const path of paths) {
      const res = await requestWithTimeout(`${core}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res?.ok) return { ok: true, path };
    }
    return { ok: false, path: paths[0] };
  };

  const routeExists = async (paths: string[]) => {
    for (const path of paths) {
      const res = await requestWithTimeout(`${core}${path}`, { method: "OPTIONS" }, 2000);
      if (res && res.status !== 404) return { ok: true, path };
    }
    return { ok: false, path: paths[0] };
  };

  const getPath = async (paths: string[]) => {
    for (const path of paths) {
      const res = await requestWithTimeout(`${core}${path}`, {});
      if (res?.ok) return { ok: true, path };
    }
    return { ok: false, path: paths[0] };
  };

    const healthRes = await requestWithTimeout(`${core}/health`, {});
    const healthOk = Boolean(healthRes?.ok);
    if (!healthRes) {
      throw new Error("health_unreachable");
    }

  const chatProbe = deepProbe
    ? await postJson(
        ["/chat/respond_v2", "/chat/respond", "/api/chat/respond"],
        {
          channel: "system",
          handle: "preflight",
          message: "Reply with one short sentence.",
          maxChars: 120,
        }
      )
    : await routeExists(["/chat/respond_v2", "/chat/respond", "/api/chat/respond"]);

  const composeProbe = deepProbe
    ? await postJson(
        ["/x/compose"],
        { kind: "observation", maxChars: 140 }
      )
    : await routeExists(["/x/compose"]);

    const prismaProbe = await getPath(["/memory/query?limit=1", "/api/channel/activity"]);

  return {
    healthOk,
    chatOk: chatProbe.ok,
    composeOk: composeProbe.ok,
    prismaOk: prismaProbe.ok,
    chatPath: chatProbe.path,
    composePath: composeProbe.path,
    prismaPath: prismaProbe.path,
  };
}

function getCoreCandidates(configuredUrl: string): string[] {
  const cleaned = (configuredUrl || "").trim().replace(/\/+$/, "");
  const candidates = [
    cleaned,
    process.env.MORK_CORE_SERVICE_FALLBACK_URL || "http://mork-core:8790",
    "http://127.0.0.1:8790",
    "http://localhost:8790",
    "http://host.docker.internal:8790",
  ]
    .map((v) => (v || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(candidates)];
}

export async function getPreflightStatus(): Promise<PreflightStatus> {
  const checks: PreflightCheck[] = [];
  const requestedOllamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const hostResolution = await resolveOllamaHost(requestedOllamaHost);
  const ollamaHost = hostResolution.host;

  const appState = await getAppControlState();
  const selectedModel = appState.controls.selectedOllamaModel.trim() || process.env.OLLAMA_MODEL || "llama3.2:3b";

  let models: string[] = [];
  try {
    models = await fetchOllamaModels(ollamaHost);
    checks.push({
      key: "ollama_reachable",
      ok: true,
      message: hostResolution.usedFallback
        ? `Ollama reachable at ${ollamaHost} (fallback from ${requestedOllamaHost})`
        : `Ollama reachable at ${ollamaHost}`,
      action: hostResolution.usedFallback
        ? `Optional: set OLLAMA_HOST=${ollamaHost} in mork-app/.env.local to make this explicit.`
        : undefined,
    });
  } catch {
    checks.push({
      key: "ollama_reachable",
      ok: false,

      message: `Ollama not reachable (tried: ${hostResolution.triedHosts.join(", ") || requestedOllamaHost})`,
      action:
        "Start Ollama, then verify OLLAMA_HOST in mork-app/.env.local. If running app in WSL with Ollama on Windows, use the Windows host IP or host.docker.internal.",
    });
  }

  if (models.length > 0) {
    const hasModel = models.includes(selectedModel);
    checks.push({
      key: "model_available",
      ok: hasModel,
      message: hasModel
        ? `Model available: ${selectedModel}`
        : `Model missing: ${selectedModel}`,
      action: hasModel ? undefined : `Run: ollama pull ${selectedModel}`,
    });
  } else {
    checks.push({
      key: "model_available",
      ok: false,
      message: `Model check skipped because Ollama is unavailable`,
      action: "Fix Ollama reachability first, then pull your model.",
    });
  }

  try {
    const wallet = resolveWalletAddressFromEnv();
    checks.push({
      key: "wallet_configured",
      ok: Boolean(wallet),
      message: wallet ? `Wallet configured: ${wallet}` : "Wallet not configured",
      action: wallet
        ? undefined
        : "Run ./setup.sh to create a development wallet or set MORK_WALLET in mork-app/.env.local.",
    });
  } catch (error) {
    checks.push({
      key: "wallet_configured",
      ok: false,
      message: `Wallet not configured correctly: ${error instanceof Error ? error.message : "invalid secret key"}`,
      action: "Fix MORK_WALLET_SECRET_KEY in mork-app/.env.local.",
    });
  }

  const sherpaReady = await hasSherpaVenv();
  checks.push({
    key: "sherpa_bootstrap",
    ok: sherpaReady,
    message: sherpaReady
      ? "Sherpa (X bot) bootstrap ready (.venv detected)"
      : "Sherpa (X bot) bootstrap missing (.venv not found)",
    action: sherpaReady
      ? undefined
      : "Install python3-venv, then re-run ./setup.sh from repo root. Sherpa powers X posting/replies and uses RSS + memories/reflections. If you do not need Sherpa locally, set MORK_SETUP_SKIP_SHERPA=1.",
  });

  const configuredCoreUrl = process.env.MORK_CORE_URL || "http://127.0.0.1:8790";
  const coreCandidates = getCoreCandidates(configuredCoreUrl);
  let coreUrl = configuredCoreUrl;
  let core: Awaited<ReturnType<typeof probeCore>> | null = null;
  let lastError = "fetch failed";
  for (const candidate of coreCandidates) {
    try {
      const next = await probeCore(candidate);
      coreUrl = candidate;
      core = next;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
  }
  if (core) {
    const appSurfaceCore = coreUrl.replace(/\/+$/, "").endsWith(":3000");
    checks.push({
      key: "mork_core_health",
      ok: core.healthOk,
      message: core.healthOk ? `Mork Core health reachable at ${coreUrl}` : `Mork Core health failed at ${coreUrl}`,
      action: core.healthOk ? undefined : "Start mork-core and verify MORK_CORE_URL in mork-app/.env.local.",
    });
    checks.push({
      key: "mork_core_chat_v2",
      ok: core.chatOk,
      message: core.chatOk ? `Mork chat responding via ${core.chatPath}` : `Mork chat failed (${core.chatPath})`,
      action: core.chatOk ? undefined : "Verify Ollama/model availability in mork-core and check logs for chat endpoint errors.",
    });
    checks.push({
      key: "mork_core_compose",
      ok: appSurfaceCore ? true : core.composeOk,
      message: appSurfaceCore
        ? "Mork compose probe skipped on app-surface core URL (:3000)."
        : core.composeOk
          ? `Mork compose responding via ${core.composePath}`
          : `Mork compose failed (${core.composePath})`,
      action: appSurfaceCore
        ? "If you want compose validation, set MORK_CORE_URL to direct mork-core (e.g. http://127.0.0.1:8790)."
        : core.composeOk
          ? undefined
          : "Check mork-core compose path and model settings.",
    });
    checks.push({
      key: "mork_core_prisma_query",
      ok: core.prismaOk,
      message: core.prismaOk ? `Prisma-backed query responding via ${core.prismaPath}` : `Prisma-backed query failed (${core.prismaPath})`,
      action: core.prismaOk ? undefined : "Check mork-core DATABASE_URL / Prisma migration status.",
    });
  } else {
    checks.push({
      key: "mork_core_health",
      ok: false,
      message: `Mork Core checks unreachable. Tried: ${coreCandidates.join(", ")} (${lastError})`,
      action: "Start mork-core and verify networking/DNS (127.0.0.1, localhost, mork-core, or host.docker.internal).",
    });
    checks.push({
      key: "mork_core_chat_v2",
      ok: false,
      message: "Mork Core /chat/respond_v2 check skipped (core unreachable)",
    });
    checks.push({
      key: "mork_core_compose",
      ok: false,
      message: "Mork Core /x/compose check skipped (core unreachable)",
    });
    checks.push({
      key: "mork_core_prisma_query",
      ok: false,
      message: "Mork Core Prisma query check skipped (core unreachable)",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
