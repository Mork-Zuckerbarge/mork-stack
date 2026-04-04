import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOSTS = [
  "http://127.0.0.1:11434",
  "http://localhost:11434",
  "http://host.docker.internal:11434",
  "http://10.255.255.254:11434",
];

const REQUEST_TIMEOUT_MS = 4000;
const MODEL_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const STARTUP_WAIT_MS = 90000;
const RETRY_INTERVAL_MS = 2000;
const STRICT_MODE = process.env.MORK_OLLAMA_STRICT === "1";

function normalizeHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

async function readWslWindowsHost() {
  if (!process.env.WSL_DISTRO_NAME) return "";

  try {
    const resolvConf = await readFile("/etc/resolv.conf", "utf8");
    for (const rawLine of resolvConf.split("\n")) {
      const line = rawLine.trim();
      if (!line.toLowerCase().startsWith("nameserver ")) continue;
      const ip = line.split(/\s+/)[1];
      if (ip) return `http://${ip}:11434`;
    }
  } catch {
    // Ignore and fall back to defaults.
  }

  return "";
}

async function candidateHosts() {
  const seen = new Set();
  const hosts = [];

  const add = (value) => {
    const normalized = normalizeHost(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    hosts.push(normalized);
  };

  add(process.env.OLLAMA_HOST);
  for (const host of DEFAULT_HOSTS) {
    add(host);
  }
  add(await readWslWindowsHost());

  return hosts;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      throw new Error(`Request failed with ${res.status}`);
    }

    return await res.json();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveReachableHost(hosts) {
  for (const host of hosts) {
    try {
      await fetchJsonWithTimeout(`${host}/api/tags`);
      return host;
    } catch {
      // Try next host.
    }
  }

  return "";
}

function hasCommand(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function installOllamaIfMissing() {
  if (hasCommand("ollama")) return true;
  if (process.env.MORK_SKIP_OLLAMA_INSTALL === "1") return false;
  if (!hasCommand("curl")) return false;

  console.log("[dev:ollama] `ollama` CLI not found. Attempting install via https://ollama.com/install.sh");
  const result = spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    return false;
  }

  return hasCommand("ollama");
}

function resolveComposeCommand() {
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0) {
    return { cmd: "docker", args: ["compose"] };
  }
  if (spawnSync("docker-compose", ["version"], { stdio: "ignore" }).status === 0) {
    return { cmd: "docker-compose", args: [] };
  }
  return null;
}

function startDockerOllama() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const compose = resolveComposeCommand();
  if (!compose) return false;

  const result = spawnSync(compose.cmd, [...compose.args, "up", "-d", "ollama"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  return result.status === 0;
}

function startLocalOllamaServe() {
  if (!hasCommand("ollama")) return false;

  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReachableHost(hosts) {
  const deadline = Date.now() + STARTUP_WAIT_MS;

  while (Date.now() < deadline) {
    const reachable = await resolveReachableHost(hosts);
    if (reachable) return reachable;
    await sleep(RETRY_INTERVAL_MS);
  }

  return "";
}

async function getModelNames(host) {
  const data = await fetchJsonWithTimeout(`${host}/api/tags`);
  return Array.isArray(data.models)
    ? data.models.map((model) => String(model?.name || "").trim()).filter(Boolean)
    : [];
}

async function pullModel(host, model) {
  if (hasCommand("ollama")) {
    const result = spawnSync("ollama", ["pull", model], {
      stdio: "inherit",
      env: { ...process.env, OLLAMA_HOST: host },
    });
    if (result.status === 0) return;
  }

  await fetchJsonWithTimeout(
    `${host}/api/pull`,
    {
      method: "POST",
      body: JSON.stringify({ name: model, stream: false }),
    },
    MODEL_PULL_TIMEOUT_MS,
  );
}

async function main() {
  const hosts = await candidateHosts();
  const selectedModel = String(process.env.OLLAMA_MODEL || "llama3.2:3b").trim();

  let reachableHost = await resolveReachableHost(hosts);

  if (!reachableHost) {
    installOllamaIfMissing();
    console.log("[dev:ollama] Ollama is not reachable. Attempting local `ollama serve`.");
    if (startLocalOllamaServe()) {
      reachableHost = await waitForReachableHost(hosts);
    }
  }

  if (!reachableHost) {
    console.log("[dev:ollama] Local Ollama did not come up. Attempting docker compose service: ollama");
    if (startDockerOllama()) {
      reachableHost = await waitForReachableHost(hosts);
    }
  }

  if (!reachableHost) {
    console.error(`[dev:ollama] Ollama not reachable (tried: ${hosts.join(", ")}).`);
    console.error("[dev:ollama] Start Ollama manually (`ollama serve`) or run `docker compose up -d ollama`.");
    if (STRICT_MODE) {
      console.error("[dev:ollama] Strict mode enabled (MORK_OLLAMA_STRICT=1); failing startup.");
      process.exit(1);
    }

    console.warn(
      "[dev:ollama] Continuing without Ollama so the app can boot and surface remediation steps in the Preflight panel.",
    );
    return;
  }

  console.log(`[dev:ollama] Ollama reachable at ${reachableHost}`);

  const models = await getModelNames(reachableHost);
  if (models.includes(selectedModel)) {
    console.log(`[dev:ollama] Model ready: ${selectedModel}`);
    return;
  }

  console.log(`[dev:ollama] Pulling model: ${selectedModel}`);
  await pullModel(reachableHost, selectedModel);
  console.log(`[dev:ollama] Model pull complete: ${selectedModel}`);
}

await main();
