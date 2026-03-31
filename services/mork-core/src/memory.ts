import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();

export async function addEvent(args: {
  channel: string;
  handle?: string;
  kind: string;
  content: string;
  tags?: string[];
}) {
  return prisma.memoryEvent.create({
    data: {
      channel: args.channel,
      handle: args.handle,
      kind: args.kind,
      content: args.content,
      tags: args.tags?.join(",") || null,
    },
  });
}

export async function addFact(args: {
  source: string;
  key: string;
  value: string;
  weight?: number;
  expiresAt?: Date | null;
}) {
  return prisma.memoryFact.upsert({
    where: { key: args.key },
    update: {
      value: args.value,
      weight: args.weight ?? 5,
      expiresAt: args.expiresAt ?? null,
      ts: new Date(),
      source: args.source,
    },
    create: {
      source: args.source,
      key: args.key,
      value: args.value,
      weight: args.weight ?? 5,
      expiresAt: args.expiresAt ?? null,
    },
  });
}

export async function getRecallContext(opts: {
  channel: string;
  handle?: string;
  limitEvents?: number;
}) {
  const [facts, working, events] = await Promise.all([
    prisma.memoryFact.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: [{ weight: "desc" }, { ts: "desc" }],
      take: 40,
    }),
    prisma.memorySummary.findFirst({
      where: { scope: "working" },
      orderBy: { ts: "desc" },
    }),
    prisma.memoryEvent.findMany({
      where: {
        channel: opts.channel,
        ...(opts.handle ? { handle: opts.handle } : {}),
      },
      orderBy: { ts: "desc" },
      take: opts.limitEvents ?? 20,
    }),
  ]);

  return {
    facts,
    working: working?.content || "",
    events,
  };
}

