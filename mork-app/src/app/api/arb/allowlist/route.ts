import { NextResponse } from "next/server";
import { BBQ_TOKEN } from "@/lib/core/defaults";
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

function readWhitelistMints(limit = 1000): string[] {
  for (const filename of ["whitelist.json", "whitelist.example.json"]) {
    const whitelistPath = path.resolve(process.cwd(), "../services/arb", filename);
    if (!fs.existsSync(whitelistPath)) continue;

    try {
      const raw = fs.readFileSync(whitelistPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        if (parsed && typeof parsed === "object" && "markets" in parsed && Array.isArray(parsed.markets)) {
          const mints = normalizeMintList(
            parsed.markets.map((item) => {
              if (typeof item === "string") return item;
              if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") return item.inMint;
              return "";
            }),
            limit,
          );
          if (mints.length > 0) return mints;
        }
        continue;
      }

      const mints = normalizeMintList(
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
      if (mints.length > 0) return mints;
    } catch {
      // Try the next whitelist source.
    }
  }

  return [];
}

async function fetchTopTokenMints(limit = 1000): Promise<string[]> {
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
  const mode = (searchParams.get("mode") ?? "top1000").toLowerCase();

  if (mode === "all") {
    const mints = normalizeMintList(["ALL", BBQ_TOKEN.mint], 2);
    return NextResponse.json({ ok: true, count: mints.length, mints });
  }

  const limit = 1000;
  const whitelistMints = readWhitelistMints(limit);
  const mints = normalizeMintList([...(whitelistMints.length > 0 ? whitelistMints : await fetchTopTokenMints(limit)), BBQ_TOKEN.mint], limit + 1);

  return NextResponse.json({
    ok: true,
    count: mints.length,
    mints,
  });
}
