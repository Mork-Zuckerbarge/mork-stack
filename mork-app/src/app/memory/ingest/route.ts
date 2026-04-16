import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";

export const runtime = "nodejs";

function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 64);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const type = typeof body?.type === "string" && body.type.trim() ? body.type.trim() : "fact";
    const content = typeof body?.content === "string" ? body.content.trim() : "";

    if (!content) {
      return NextResponse.json({ ok: false, error: "content is required" }, { status: 400 });
    }

    const source = typeof body?.source === "string" && body.source.trim() ? body.source.trim() : "external";
    const channel = typeof body?.channel === "string" && body.channel.trim() ? body.channel.trim() : null;
    const handle = typeof body?.handle === "string" && body.handle.trim() ? body.handle.trim() : null;

    const importanceRaw = Number(body?.importance);
    const importance = Number.isFinite(importanceRaw)
      ? Math.min(Math.max(importanceRaw, 0), 1)
      : 0.3;

    const created = await prisma.memory.create({
      data: {
        type,
        content,
        entities: normalizeEntities(body?.entities),
        importance,
        source,
        channel,
        handle,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ ok: true, id: created.id, createdAt: created.createdAt.toISOString() });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "memory ingest failed" },
      { status: 500 }
    );
  }
}
