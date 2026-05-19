import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getMoltbookFeed, getMoltbookHome, postToMoltbook } from "@/lib/integrations/moltbookAgent";

const MOLTBOOK_LAST_POSTED_KEY = "moltbook:last_posted_memory_id";

export const runtime = "nodejs";

type TickSummary = {
  ok: boolean;
  reason?: string;
  interacted: boolean;
  postedFromSherpa: boolean;
  tradeSignalCount: number;
};

function isKillSwitchOn() {
  return process.env.MOLTBOOK_KILL_SWITCH === "1";
}

function hasMultiFactorApproval() {
  return process.env.MOLTBOOK_MULTI_FACTOR_REQUIRED !== "0";
}

export async function POST() {
  const app = await getAppControlState();
  if (!app.controls.plannerEnabled) {
    return NextResponse.json<TickSummary>({ ok: false, reason: "planner_disabled", interacted: false, postedFromSherpa: false, tradeSignalCount: 0 });
  }

  if (isKillSwitchOn()) {
    return NextResponse.json<TickSummary>({ ok: false, reason: "kill_switch_enabled", interacted: false, postedFromSherpa: false, tradeSignalCount: 0 });
  }

  if (app.controls.executionAuthority.mode === "emergency_stop") {
    return NextResponse.json<TickSummary>({ ok: false, reason: "execution_emergency_stop", interacted: false, postedFromSherpa: false, tradeSignalCount: 0 });
  }

  let feedPosts: unknown[] = [];
  let moltbookReachable = false;

  try {
    await getMoltbookHome(process.env.MOLTBOOK_API_KEY);
    moltbookReachable = true;
    const feed = await getMoltbookFeed({ sort: "new", limit: 8 }, process.env.MOLTBOOK_API_KEY);
    feedPosts = Array.isArray(feed.posts) ? feed.posts : [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[moltbook-tick] Moltbook API unavailable: ${msg}`);
  }

  let postedFromSherpa = false;

  try {
    const sherpaMem = await prisma.memory.findFirst({ where: { source: "sherpa" }, orderBy: { createdAt: "desc" } });

    if (sherpaMem?.content) {
      const lastPostedFact = await prisma.memoryFact.findUnique({ where: { key: MOLTBOOK_LAST_POSTED_KEY } });
      const lastPostedId = lastPostedFact?.value ?? null;

      if (sherpaMem.id !== lastPostedId && moltbookReachable) {
        const title = `Sherpa Dispatch ${new Date().toISOString().slice(0, 10)}`;
        const content = String(sherpaMem.content).slice(0, 900);
        await postToMoltbook({ submolt_name: "general", title, content, type: "text" }, process.env.MOLTBOOK_API_KEY);
        await prisma.memoryFact.upsert({
          where: { key: MOLTBOOK_LAST_POSTED_KEY },
          create: { key: MOLTBOOK_LAST_POSTED_KEY, value: sherpaMem.id, source: "system", weight: 8 },
          update: { value: sherpaMem.id },
        });
        postedFromSherpa = true;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[moltbook-tick] Post failed: ${msg}`);
  }

  const socialSignalCount = feedPosts.reduce((acc: number, p) => {
    const upvotes = Number((p as { upvotes?: unknown }).upvotes ?? 0);
    return acc + (Number.isFinite(upvotes) && upvotes >= 2 ? 1 : 0);
  }, 0);

  await prisma.memory.create({
    data: {
      type: "reflection",
      source: "moltbook",
      content: `Moltbook tick. posts=${feedPosts.length} socialSignals=${socialSignalCount} postedFromSherpa=${postedFromSherpa} moltbookReachable=${moltbookReachable} multiFactor=${hasMultiFactorApproval()}`,
      entities: ["moltbook", "heartbeat", "trade-intel"],
      importance: 0.45,
    },
  }).catch(() => {});

  return NextResponse.json<TickSummary>({
    ok: true,
    reason: moltbookReachable ? undefined : "moltbook_api_unavailable",
    interacted: moltbookReachable,
    postedFromSherpa,
    tradeSignalCount: socialSignalCount,
  });
}
