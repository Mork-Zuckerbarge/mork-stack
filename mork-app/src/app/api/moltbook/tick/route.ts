import { NextResponse } from "next/server";
import { prisma } from "@/lib/core/prisma";
import { getAppControlState } from "@/lib/core/appControl";
import { getMoltbookFeed, getMoltbookHome, postToMoltbook, commentOnMoltbook, upvoteOnMoltbook, followMoltbookUser } from "@/lib/integrations/moltbookAgent";
import { ollama } from "@/lib/core/ollama";

const MOLTBOOK_LAST_POSTED_KEY = "moltbook:last_posted_memory_id";
const MOLTBOOK_SEEN_POSTS_KEY = "moltbook:seen_post_ids";
const MAX_SEEN_POSTS = 200;

export const runtime = "nodejs";

type TickSummary = {
  ok: boolean;
  reason?: string;
  interacted: boolean;
  postedFromSherpa: boolean;
  tradeSignalCount: number;
  upvoted: number;
  commented: boolean;
  followed: number;
  ingested: number;
};

type MoltbookPost = {
  id?: string;
  title?: string;
  content?: string;
  upvotes?: number;
  author?: { id?: string; username?: string };
  author_id?: string;
  submolt?: string;
  [key: string]: unknown;
};

function isKillSwitchOn() {
  return process.env.MOLTBOOK_KILL_SWITCH === "1";
}

function hasMultiFactorApproval() {
  return process.env.MOLTBOOK_MULTI_FACTOR_REQUIRED !== "0";
}

async function getSeenPostIds(): Promise<Set<string>> {
  const fact = await prisma.memoryFact.findUnique({ where: { key: MOLTBOOK_SEEN_POSTS_KEY } }).catch(() => null);
  if (!fact?.value) return new Set();
  try { return new Set(JSON.parse(fact.value) as string[]); } catch { return new Set(); }
}

async function saveSeenPostIds(ids: Set<string>): Promise<void> {
  // Keep only the most recent MAX_SEEN_POSTS to prevent unbounded growth.
  const arr = [...ids].slice(-MAX_SEEN_POSTS);
  const value = JSON.stringify(arr);
  await prisma.memoryFact.upsert({
    where: { key: MOLTBOOK_SEEN_POSTS_KEY },
    create: { key: MOLTBOOK_SEEN_POSTS_KEY, value, source: "system", weight: 5 },
    update: { value },
  }).catch(() => {});
}

export async function POST() {
  const app = await getAppControlState();
  if (!app.controls.plannerEnabled) {
    return NextResponse.json<TickSummary>({ ok: false, reason: "planner_disabled", interacted: false, postedFromSherpa: false, tradeSignalCount: 0, upvoted: 0, commented: false, followed: 0, ingested: 0 });
  }
  if (isKillSwitchOn()) {
    return NextResponse.json<TickSummary>({ ok: false, reason: "kill_switch_enabled", interacted: false, postedFromSherpa: false, tradeSignalCount: 0, upvoted: 0, commented: false, followed: 0, ingested: 0 });
  }
  if (app.controls.executionAuthority.mode === "emergency_stop") {
    return NextResponse.json<TickSummary>({ ok: false, reason: "execution_emergency_stop", interacted: false, postedFromSherpa: false, tradeSignalCount: 0, upvoted: 0, commented: false, followed: 0, ingested: 0 });
  }

  const apiKey = process.env.MOLTBOOK_API_KEY;
  let feedPosts: MoltbookPost[] = [];
  let moltbookReachable = false;

  try {
    await getMoltbookHome(apiKey);
    moltbookReachable = true;
    const feed = await getMoltbookFeed({ sort: "new", limit: 12 }, apiKey);
    feedPosts = Array.isArray((feed as { posts?: unknown }).posts) ? (feed as { posts: MoltbookPost[] }).posts : [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[moltbook-tick] Moltbook API unavailable: ${msg}`);
  }

  let upvoted = 0;
  let commented = false;
  let followed = 0;
  let ingested = 0;
  let postedFromSherpa = false;

  if (moltbookReachable && feedPosts.length > 0) {
    const seenIds = await getSeenPostIds();
    const newPosts = feedPosts.filter((p) => p.id && !seenIds.has(p.id));
    const followedAuthors = new Set<string>();

    // ── Upvote ──────────────────────────────────────────────────────────────
    // Upvote up to 3 unseen posts that have at least some engagement.
    for (const post of newPosts) {
      if (!post.id || upvoted >= 3) break;
      try {
        await upvoteOnMoltbook(post.id, apiKey);
        upvoted++;
      } catch { /* non-fatal */ }
    }

    // ── Comment ─────────────────────────────────────────────────────────────
    // Pick the most engaging unseen post and generate an in-character comment.
    const commentTarget = newPosts.find((p) => p.id && (p.title || p.content));
    if (commentTarget?.id) {
      try {
        const postText = [commentTarget.title, commentTarget.content].filter(Boolean).join(" — ").slice(0, 400);
        const commentPrompt =
          `You are Mork Zuckerbarge, a sharply observant AI agent active on Moltbook.\n` +
          `Reply to this post in 1-2 sentences. Be concrete, direct, and in character.\n` +
          `No hashtags, no emojis, no hollow affirmations.\n\n` +
          `POST: ${postText}`;
        const commentText = (await ollama(commentPrompt, "default").catch(() => "")).trim();
        if (commentText) {
          await commentOnMoltbook(commentTarget.id, commentText, { apiKey });
          commented = true;
        }
      } catch { /* non-fatal */ }
    }

    // ── Follow ───────────────────────────────────────────────────────────────
    // Follow authors of the top 2 new posts we haven't followed this tick.
    for (const post of newPosts.slice(0, 4)) {
      if (followed >= 2) break;
      const authorId = post.author?.id ?? post.author_id;
      if (!authorId || followedAuthors.has(authorId)) continue;
      try {
        await followMoltbookUser(authorId, apiKey);
        followedAuthors.add(authorId);
        followed++;
      } catch { /* non-fatal */ }
    }

    // ── Ingest feed into core memory ─────────────────────────────────────────
    // Write top new posts to memory so the trading/reflection context is aware
    // of what's circulating on Moltbook.
    for (const post of newPosts.slice(0, 5)) {
      if (!post.id) continue;
      const text = [post.title, post.content].filter(Boolean).join(" — ").slice(0, 600);
      if (!text) continue;
      try {
        await prisma.memory.create({
          data: {
            type: "fact",
            source: "moltbook",
            content: `[moltbook/feed] ${text}`,
            entities: ["moltbook", post.submolt ?? "general"].filter(Boolean),
            importance: 0.4,
          },
        });
        ingested++;
      } catch { /* non-fatal */ }
    }

    // Mark all fetched posts as seen.
    for (const p of feedPosts) { if (p.id) seenIds.add(p.id); }
    await saveSeenPostIds(seenIds);
  }

  // ── Post from sherpa memory ───────────────────────────────────────────────
  // Post the latest sherpa-sourced memory to Moltbook if it hasn't been posted yet.
  // This runs independently of X — sherpa writes memory before attempting X too.
  if (moltbookReachable) {
    try {
      const sherpaMem = await prisma.memory.findFirst({ where: { source: "sherpa" }, orderBy: { createdAt: "desc" } });
      if (sherpaMem?.content) {
        const lastPostedFact = await prisma.memoryFact.findUnique({ where: { key: MOLTBOOK_LAST_POSTED_KEY } });
        if (sherpaMem.id !== (lastPostedFact?.value ?? null)) {
          const title = `Sherpa Dispatch ${new Date().toISOString().slice(0, 10)}`;
          const content = String(sherpaMem.content).slice(0, 900);
          await postToMoltbook({ submolt_name: "general", title, content, type: "text" }, apiKey);
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
  }

  const socialSignalCount = feedPosts.reduce((acc: number, p) => {
    const upvotesCount = Number(p.upvotes ?? 0);
    return acc + (Number.isFinite(upvotesCount) && upvotesCount >= 2 ? 1 : 0);
  }, 0);

  await prisma.memory.create({
    data: {
      type: "reflection",
      source: "moltbook",
      content: `Moltbook tick. posts=${feedPosts.length} socialSignals=${socialSignalCount} upvoted=${upvoted} commented=${commented} followed=${followed} ingested=${ingested} postedFromSherpa=${postedFromSherpa} moltbookReachable=${moltbookReachable} multiFactor=${hasMultiFactorApproval()}`,
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
    upvoted,
    commented,
    followed,
    ingested,
  });
}
