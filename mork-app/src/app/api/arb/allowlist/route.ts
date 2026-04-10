import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const FALLBACK_TOKEN_CSV =
  "https://raw.githubusercontent.com/igneous-labs/jup-token-list/main/validated-tokens.csv";

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
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

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

function readWhitelistMints(limit = 500): string[] {
  const whitelistPath = path.resolve(process.cwd(), "../services/arb/whitelist.json");
  if (!fs.existsSync(whitelistPath)) return [];

  try {
    const raw = fs.readFileSync(whitelistPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (parsed && typeof parsed === "object" && "markets" in parsed && Array.isArray(parsed.markets)) {
        return normalizeMintList(
          parsed.markets.map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") return item.inMint;
            return "";
          }),
          limit,
        );
      }
      return [];
    }

    return normalizeMintList(
      parsed
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") {
          return item.inMint.trim();
        }
        return "";
      }),
      limit,
    );
  } catch {
    return [];
  }
}

async function fetchTopTokenMints(limit = 500): Promise<string[]> {
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

    const mints = lines.slice(1).map((line) => parseCsvLine(line)[mintIdx] || "");
    return normalizeMintList(mints, limit);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 500), 1), 1000);
  const whitelistMints = readWhitelistMints(limit);
  const mints = whitelistMints.length > 0 ? whitelistMints : await fetchTopTokenMints(limit);

  return NextResponse.json({
    ok: true,
    count: mints.length,
    mints,
  });
}
