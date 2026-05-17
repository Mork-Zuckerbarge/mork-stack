import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getMoltbookFeed, getMoltbookHome, postToMoltbook } from "@/lib/integrations/moltbookAgent";

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

  try {
    await getMoltbookHome(process.env.MOLTBOOK_API_KEY);
    const feed = await getMoltbookFeed({ sort: "new", limit: 8 }, process.env.MOLTBOOK_API_KEY);

    const sherpaMem = await prisma.memory.findFirst({ where: { source: "sherpa" }, orderBy: { createdAt: "desc" } });
    let postedFromSherpa = false;

    if (sherpaMem?.content) {
      const title = `Sherpa Dispatch ${new Date().toISOString().slice(0, 10)}`;
      const content = String(sherpaMem.content).slice(0, 900);
      await postToMoltbook({ submolt_name: "general", title, content, type: "text" }, process.env.MOLTBOOK_API_KEY);
      postedFromSherpa = true;
    }

    const posts = Array.isArray(feed.posts) ? feed.posts : [];
    const socialSignalCount = posts.reduce((acc, p) => {
      const upvotes = Number((p as { upvotes?: unknown }).upvotes ?? 0);
      return acc + (Number.isFinite(upvotes) && upvotes >= 2 ? 1 : 0);
    }, 0);

    await prisma.memory.create({
      data: {
        type: "reflection",
        source: "moltbook",
        content: `Moltbook tick ok. posts=${posts.length} socialSignals=${socialSignalCount} postedFromSherpa=${postedFromSherpa} multiFactor=${hasMultiFactorApproval()}`,
        entities: ["moltbook", "heartbeat", "trade-intel"],
        importance: 0.45,
      },
    });

    return NextResponse.json<TickSummary>({ ok: true, interacted: true, postedFromSherpa, tradeSignalCount: socialSignalCount });
  } catch (error) {
    return NextResponse.json<TickSummary>({ ok: false, reason: error instanceof Error ? error.message : "tick_failed", interacted: false, postedFromSherpa: false, tradeSignalCount: 0 }, { status: 500 });
  }
}
