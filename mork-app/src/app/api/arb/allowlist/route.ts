import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

function readWhitelistMints(limit = 500): string[] {
  const whitelistPath = path.resolve(process.cwd(), "../services/arb/whitelist.json");
  if (!fs.existsSync(whitelistPath)) return [];

  try {
    const raw = fs.readFileSync(whitelistPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "inMint" in item && typeof item.inMint === "string") {
          return item.inMint.trim();
        }
        return "";
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 500), 1), 1000);
  const mints = readWhitelistMints(limit);

  return NextResponse.json({
    ok: true,
    count: mints.length,
    mints,
  });
}
