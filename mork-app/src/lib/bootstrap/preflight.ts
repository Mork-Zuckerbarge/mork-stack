import { getAppControlState } from "@/lib/core/appControl";
import { resolveWalletAddressFromEnv } from "@/lib/core/walletConfig";

export type PreflightCheck = {
  key: "ollama_reachable" | "model_available" | "wallet_configured";
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

export async function getPreflightStatus(): Promise<PreflightStatus> {
  const checks: PreflightCheck[] = [];
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

  const appState = await getAppControlState();
  const selectedModel = appState.controls.selectedOllamaModel.trim() || process.env.OLLAMA_MODEL || "llama3.2:3b";

  let models: string[] = [];
  try {
    models = await fetchOllamaModels(ollamaHost);
    checks.push({
      key: "ollama_reachable",
      ok: true,
      message: `Ollama reachable at ${ollamaHost}`,
    });
  } catch {
    checks.push({
      key: "ollama_reachable",
      ok: false,
      message: `Ollama not reachable at ${ollamaHost}`,
      action: "Start Ollama and verify OLLAMA_HOST in mork-app/.env.local.",
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

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
