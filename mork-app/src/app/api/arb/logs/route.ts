import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 30), 1), 100);

    const items = await prisma.memory.findMany({
      where: {
        OR: [{ source: "arb" }, { source: "arb-bot" }],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        source: true,
        content: true,
      },
    });

    return NextResponse.json({
      ok: true,
      items,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "arb logs unavailable" },
      { status: 500 }
    );
  }
}
