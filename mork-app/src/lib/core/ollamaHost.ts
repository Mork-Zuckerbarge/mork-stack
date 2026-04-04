import { readFile } from "node:fs/promises";

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const OLLAMA_TAGS_PATH = "/api/tags";

type HostCache = {
  host: string;
  expiresAt: number;
};

let reachableHostCache: HostCache | null = null;

function normalizeHost(host: string) {
  return host.replace(/\/+$/, "");
}

function parseWindowsHostFromResolvConf(contents: string) {
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("nameserver ")) continue;
    const ip = line.split(/\s+/)[1];
    if (!ip) continue;
    return `http://${ip}:11434`;
  }
  return null;
}

async function wslWindowsHostCandidate() {
  if (!process.env.WSL_DISTRO_NAME) return null;
  try {
    const resolvConf = await readFile("/etc/resolv.conf", "utf8");
    return parseWindowsHostFromResolvConf(resolvConf);
  } catch {
    return null;
  }
}

async function getHostCandidates(preferredHost?: string) {
  const candidates: string[] = [];
  const add = (value?: string) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    const normalized = normalizeHost(trimmed);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  add(preferredHost);
  add(process.env.OLLAMA_HOST);
  add(DEFAULT_OLLAMA_HOST);
  add("http://localhost:11434");
  add("http://host.docker.internal:11434");

  const wslHost = await wslWindowsHostCandidate();
  add(wslHost || undefined);

  return candidates;
}

async function canReachOllama(host: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${host}${OLLAMA_TAGS_PATH}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveOllamaHost(preferredHost?: string) {
  const requestedHost = normalizeHost(preferredHost || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST);

  if (reachableHostCache && reachableHostCache.expiresAt > Date.now()) {
    return {
      host: reachableHostCache.host,
      requestedHost,
      usedFallback: reachableHostCache.host !== requestedHost,
      triedHosts: [reachableHostCache.host],
    };
  }

  const triedHosts: string[] = [];
  const candidates = await getHostCandidates(requestedHost);
  for (const host of candidates) {
    triedHosts.push(host);
    if (await canReachOllama(host)) {
      reachableHostCache = {
        host,
        expiresAt: Date.now() + 30_000,
      };
      return {
        host,
        requestedHost,
        usedFallback: host !== requestedHost,
        triedHosts,
      };
    }
  }

  return {
    host: requestedHost,
    requestedHost,
    usedFallback: false,
    triedHosts,
  };
}
