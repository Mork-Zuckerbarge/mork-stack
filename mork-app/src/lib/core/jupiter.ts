import { APP_DEFAULTS } from "./defaults";

const DEFAULT_JUPITER_BASES = [APP_DEFAULTS.jupiterBaseUrl, APP_DEFAULTS.jupiterLiteBaseUrl] as const;

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function getJupiterBaseCandidates(): string[] {
  const configuredList = (process.env.JUP_BASE_URLS ?? "")
    .split(",")
    .map((item) => normalizeBaseUrl(item))
    .filter(Boolean);

  const singleBase = normalizeBaseUrl(process.env.JUP_BASE_URL ?? "");
  const combined = [...configuredList, singleBase, ...DEFAULT_JUPITER_BASES];
  return [...new Set(combined.filter(Boolean))];
}

export function getJupiterTimeoutMs(): number {
  return Math.max(2500, Number(process.env.JUP_TIMEOUT_MS || APP_DEFAULTS.jupiterTimeoutMs));
}

