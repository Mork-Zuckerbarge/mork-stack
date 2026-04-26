import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeStylePackUrls, readStylePackUrls } from "@/lib/core/stylePack";

export const runtime = "nodejs";

function resolveOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const urls = await readStylePackUrls();
  return NextResponse.json({ ok: true, urls, count: urls.length, origin: resolveOrigin(req) });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { urls?: unknown };
      const urls = Array.isArray(body?.urls)
        ? body.urls.filter((entry): entry is string => typeof entry === "string" && /^https?:\/\//i.test(entry.trim()))
        : [];
      if (urls.length < 1) {
        return NextResponse.json({ ok: false, error: "Provide at least one public http(s) style image URL." }, { status: 400 });
      }
      if (urls.length > 20) {
        return NextResponse.json({ ok: false, error: "URL style pack limit is 20 images." }, { status: 400 });
      }
      await writeStylePackUrls(urls);
      return NextResponse.json({ ok: true, urls, count: urls.length });
    }

    const form = await req.formData();
    const files = form
      .getAll("files")
      .filter((entry): entry is File => typeof File !== "undefined" && entry instanceof File);
    if (!files.length) {
      return NextResponse.json({ ok: false, error: "Upload at least 1 image file under form field 'files'." }, { status: 400 });
    }
    if (files.length > 20) {
      return NextResponse.json({ ok: false, error: "Upload limit is 20 style images." }, { status: 400 });
    }

    const outDir = path.join(process.cwd(), "public", "style-pack");
    await mkdir(outDir, { recursive: true });

    const savedUrls: string[] = [];
    const origin = resolveOrigin(req);

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const base = (file.name || `style-${i + 1}`).replace(/[^a-zA-Z0-9._-]/g, "-");
      const stamped = `${Date.now()}-${i + 1}-${base}`;
      const full = path.join(outDir, stamped);
      const buf = Buffer.from(await file.arrayBuffer());
      await writeFile(full, buf);
      savedUrls.push(`${origin}/style-pack/${encodeURIComponent(stamped)}`);
    }

    await writeStylePackUrls(savedUrls);
    return NextResponse.json({ ok: true, urls: savedUrls, count: savedUrls.length });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to persist style pack images." },
      { status: 500 }
    );
  }
}
