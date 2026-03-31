import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    await prisma.memory.create({
      data: {
        type: "fact",
        content: String(body.content || ""),
        entities: ["relationship", body.handle ? `handle:${body.handle}` : ""].filter(Boolean),
        importance: 0.7,
        source: "relationship",
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "relationship save failed" },
      { status: 500 }
    );
  }
}
