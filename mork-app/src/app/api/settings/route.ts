import { NextRequest, NextResponse } from "next/server";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type SettingsPayload = {
  walletAddress: string;
  solanaRpc: string;
  telegramBotToken: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  ollamaHost: string;
  ollamaModel: string;
};

const DEFAULT_SETTINGS: SettingsPayload = {
  walletAddress: "",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  telegramBotToken: "",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
  ollamaHost: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2:3b",
};

const SETTINGS_TO_ENV: Array<[keyof SettingsPayload, string]> = [
  ["walletAddress", "MORK_WALLET"],
  ["solanaRpc", "SOLANA_RPC"],
  ["telegramBotToken", "TELEGRAM_BOT_TOKEN"],
  ["elevenLabsApiKey", "ELEVENLABS_API_KEY"],
  ["elevenLabsVoiceId", "ELEVENLABS_VOICE_ID"],
  ["ollamaHost", "OLLAMA_HOST"],
  ["ollamaModel", "OLLAMA_MODEL"],
];

function envFilePath(): string {
  return path.join(process.cwd(), ".env.local");
}

async function envFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value ?? "");
}

async function loadSettingsFromEnv(): Promise<SettingsPayload> {
  const filePath = envFilePath();
  const settings: SettingsPayload = { ...DEFAULT_SETTINGS };

  if (!(await envFileExists(filePath))) {
    return settings;
  }

  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  const envMap = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1);
    envMap.set(key, parseEnvValue(rawValue));
  }

  for (const [settingKey, envKey] of SETTINGS_TO_ENV) {
    if (envMap.has(envKey)) {
      settings[settingKey] = envMap.get(envKey) ?? "";
    }
  }

  return settings;
}

async function writeSettingsToEnv(payload: SettingsPayload): Promise<void> {
  const filePath = envFilePath();
  const existing = (await envFileExists(filePath)) ? await readFile(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const output = [...lines];

  for (const [settingKey, envKey] of SETTINGS_TO_ENV) {
    const nextLine = `${envKey}=${quoteEnvValue(payload[settingKey])}`;
    const existingIdx = output.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith(`${envKey}=`);
    });

    if (existingIdx >= 0) {
      output[existingIdx] = nextLine;
    } else {
      output.push(nextLine);
    }
  }

  const finalContent = `${output.join("\n").replace(/\n+$/g, "")}\n`;
  await writeFile(filePath, finalContent, "utf8");
}

function sanitizePayload(input: unknown): SettingsPayload {
  const raw = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};

  const normalized = { ...DEFAULT_SETTINGS };
  for (const [settingKey] of SETTINGS_TO_ENV) {
    const value = raw[settingKey];
    normalized[settingKey] = typeof value === "string" ? value.trim() : DEFAULT_SETTINGS[settingKey];
  }

  return normalized;
}

export async function GET() {
  try {
    const settings = await loadSettingsFromEnv();
    return NextResponse.json(settings);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to load settings" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = sanitizePayload(body);
    await writeSettingsToEnv(settings);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to save settings" },
      { status: 500 },
    );
  }
}
