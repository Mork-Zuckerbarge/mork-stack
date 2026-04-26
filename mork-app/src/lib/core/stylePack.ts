import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STYLE_PACK_FILE = path.join(process.cwd(), "data", "style-pack.json");

type StylePackState = {
  updatedAt: string;
  urls: string[];
};

export async function readStylePackUrls(): Promise<string[]> {
  try {
    const raw = await readFile(STYLE_PACK_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StylePackState>;
    if (!Array.isArray(parsed.urls)) return [];
    return parsed.urls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}

export async function writeStylePackUrls(urls: string[]): Promise<void> {
  const cleaned = urls.map((entry) => entry.trim()).filter(Boolean);
  await mkdir(path.dirname(STYLE_PACK_FILE), { recursive: true });
  const payload: StylePackState = {
    updatedAt: new Date().toISOString(),
    urls: cleaned,
  };
  await writeFile(STYLE_PACK_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function parseEnvStyleUrls(raw: string): string[] {
  return raw
    .split(/[,\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
