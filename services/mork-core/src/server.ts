import { getWalletState } from "./wallet";
import "dotenv/config";
import express from "express";
import { z } from "zod";
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
const BANNED_PHRASES = [
  "I noticed something and it noticed me back.",
  "Today’s market felt like a sad play performed in a smokehouse.",
  "I stared into the liquidity pool. It stared into me.",
  "Anyway. Tell me what you see.",
  "Anyway. Onward, reluctantly.",
];

async function ollamaGenerate(prompt: string): Promise<string> {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: Number(process.env.OLLAMA_TEMP ?? 0.8),
        num_ctx: Number(process.env.OLLAMA_CTX ?? 2048),
      },
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`ollama ${r.status}: ${text.slice(0, 300)}`);
  }

  const j: unknown = await r.json();
  const response =
    typeof j === "object" && j !== null && "response" in j
      ? (j as { response?: unknown }).response
      : "";
  return String(response ?? "").trim();
}

async function ollama(prompt: string) {
  return ollamaGenerate(prompt);
}

const prisma = new PrismaClient();
const app = express();
app.use(express.json({ limit: "1mb" }));
const PORT = Number(process.env.PORT ?? process.env.MORK_CORE_PORT ?? 8790);
const HOST = process.env.HOST ?? "0.0.0.0";
app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    name: process.env.MORK_NAME ?? "Mork Zuckerbarge",
    ts: new Date().toISOString(),
  });
});

const MemoryIngestSchema = z.object({
  type: z.string(),
  content: z.string().min(1),
  entities: z.array(z.string()).optional().default([]),
  importance: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
});

app.post("/memory/ingest", async (req, res) => {
  const parsed = MemoryIngestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const m = await prisma.memory.create({ data: parsed.data });
  res.json({ ok: true, memory: m });
});
// --- Arb policy + market-sense organ (Step 3)
function nowMs() { return Date.now(); }

function clamp(n: number, a: number, b: number) { return Math.max(a, Math.min(b, n)); }

function mintKey(mint: unknown) {
  return String(mint || "").trim();
}

function parseJsonSafe(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

type ArbPolicy = Record<string, unknown>;

async function getPolicy(prisma: PrismaClient, mint: unknown): Promise<ArbPolicy | null> {
  const m = mintKey(mint);
  if (!m) return null;
  const row = await prisma.arbPolicy.findUnique({ where: { mint: m } });
  return (row?.policy as ArbPolicy | null) || null;
}

async function setPolicy(prisma: PrismaClient, mint: unknown, patch: ArbPolicy) {
  const m = mintKey(mint);
  if (!m) return null;

  const existing = (await getPolicy(prisma, m)) || {};
  const next = { ...existing, ...patch, mint: m, updatedAtMs: nowMs() };

  return prisma.arbPolicy.upsert({
    where: { mint: m },
    create: { mint: m, policy: next },
    update: { policy: next },
  });
}

function scoreRouteResearch(evt: ArbPolicy) {
  const q1Impact = Number(evt?.q1?.priceImpactPct ?? 0);
  const q2Impact = Number(evt?.q2?.priceImpactPct ?? 0);
  const hops = Number((evt?.q1?.hops ?? 0) + (evt?.q2?.hops ?? 0));
  const net = Number(evt?.net ?? 0);
  const edgePct = Number(evt?.edgePct ?? 0);

  const impactPenalty = (isFinite(q1Impact) ? q1Impact : 0) + (isFinite(q2Impact) ? q2Impact : 0);
  const hopsPenalty = isFinite(hops) ? (hops * 0.15) : 0;

  const reward = (isFinite(net) ? net : 0) + (isFinite(edgePct) ? edgePct * 0.01 : 0);

  const score = reward - impactPenalty - hopsPenalty; // rough but useful
  return score;
}

async function applyMarketSense(prisma: PrismaClient, evt: ArbPolicy) {
  const mint = mintKey(evt?.mint);
  if (!mint) return;

  const kind = evt?.kind;

  const cur = (await getPolicy(prisma, mint)) || {};
  const next = { ...cur };

  next.stats = next.stats || { ok: 0, fail: 0, lastErr: null, score: 0, lastTs: 0 };
  next.stats.lastTs = nowMs();

  if (kind === "route_research") {
    const s = scoreRouteResearch(evt);
    next.stats.score = (next.stats.score * 0.8) + (s * 0.2);

    if (next.stats.score < -0.15) {
      next.tempBlacklistUntilMs = Math.max(next.tempBlacklistUntilMs || 0, nowMs() + 15 * 60_000);
      next.reason = "route_score_low";
    } else if (next.stats.score > 0.10) {
      next.reason = "route_score_good";
    }
  }

  if (kind === "trade_result") {
    const ok = !!evt?.ok;
    const err = String(evt?.error || "");

    if (ok) {
      next.stats.ok += 1;
      next.stats.fail = Math.max(0, next.stats.fail - 1);
      next.stats.lastErr = null;

      if (next.tempBlacklistUntilMs && next.tempBlacklistUntilMs < nowMs()) {
        delete next.tempBlacklistUntilMs;
      }
    } else {
      next.stats.fail += 1;
      next.stats.lastErr = err.slice(0, 200);

      const lower = err.toLowerCase();

      const dead =
        lower.includes("custom") && (lower.includes("6024") || lower.includes("0x1788")) ||
        lower.includes("encoding overruns uint8array") ||
        lower.includes("failed to serialize");

      const slippagey =
        lower.includes("slippage") ||
        (lower.includes("custom") && lower.includes("6001"));

      if (dead) {
        next.tempBlacklistUntilMs = Math.max(next.tempBlacklistUntilMs || 0, nowMs() + 60 * 60_000);
        next.reason = "dead_or_oversize_route";
      } else if (slippagey) {
        const curSlip = Number(next.slippageBpsOverride ?? 0);
        const bumped = clamp((curSlip || 0) + 10, 0, 200);
        next.slippageBpsOverride = bumped;
        next.reason = "slippage_bump";
      }

      if (next.stats.fail >= 3) {
        next.tempBlacklistUntilMs = Math.max(next.tempBlacklistUntilMs || 0, nowMs() + 30 * 60_000);
        next.reason = "too_many_fails";
      }
    }
  }

  await setPolicy(prisma, mint, next);
}

// 1) Arb event ingest endpoint (bot posts structured stuff here)
app.post("/arb/event", async (req, res) => {
  try {
    const evt = req.body || {};
    const kind = String(evt.kind || "");
    const mint = String(evt.mint || "");

    await prisma.memory.create({
      data: {
        type: "fact",
        content: JSON.stringify(evt).slice(0, 1800),
        entities: [`arb:event`, kind ? `kind:${kind}` : "", mint ? `mint:${mint}` : ""].filter(Boolean),
        importance: 0.85,
        source: "arb",
      },
    });

    await applyMarketSense(prisma, evt);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 2) Policy query endpoint (bot calls before execution)
app.get("/arb/policy", async (req, res) => {
  try {
    const mint = String(req.query.mint || "");
    const p = (await getPolicy(prisma, mint)) || {};

    const now = nowMs();
    const blacklisted = p.tempBlacklistUntilMs && Number(p.tempBlacklistUntilMs) > now;

    const out = {
      mint,
      blacklisted,
      tempBlacklistUntilMs: p.tempBlacklistUntilMs || null,
      slippageBpsOverride: p.slippageBpsOverride ?? null,
      maxSpendUsdOverride: p.maxSpendUsdOverride ?? null,
      minNetUsdOverride: p.minNetUsdOverride ?? null,
      reason: p.reason || null,
      stats: p.stats || null,
    };

    return res.json({ ok: true, policy: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 3) Optional manual policy patch (so YOU can steer it)
app.post("/arb/policy", async (req, res) => {
  try {
    const { mint, patch } = req.body || {};
    if (!mint || typeof patch !== "object") return res.status(400).json({ ok: false, error: "mint+patch required" });

    await setPolicy(prisma, mint, patch);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/memory/query", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 20), 50);

  const where: Prisma.MemoryWhereInput = {};
  if (q) where.content = { contains: q };

  const items = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json({ ok: true, items });
});

app.get("/wallet/state", async (_req, res) => {
  try {
    const wallet = await getWalletState();

    if (!wallet) {
      return res.json({ ok: true, wallet: null });
    }

    return res.json({
      ok: true,
      wallet: {
        address: wallet.address,
        sol: wallet.sol ?? 0,
        bbq: wallet.bbq ?? 0,
        usdc: wallet.usdc ?? 0,
        requirementMet: wallet.requirementMet ?? false,
      },
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

const RespondSchema = z.object({
  channel: z.enum(["x", "telegram", "nifty", "phone", "system", "arb"]).default("system"),
  userId: z.string().optional(),
  handle: z.string().optional(),
  message: z.string().min(1),
  maxChars: z.number().min(120).max(2000).optional().default(700),
});
async function getLatestWalletMemory() {
  return prisma.memory.findFirst({
    where: { source: "wallet" },
    orderBy: { createdAt: "desc" },
  });
}
app.post("/chat/respond", async (req, res) => {
  try {
    const parsed = RespondSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { channel, handle, message, maxChars } = parsed.data;

    // Store inbound message
    await prisma.memory.create({
      data: {
        type: "fact",
        content: `[IN/${channel}${handle ? `:${handle}` : ""}] ${message}`,
        entities: [
          `channel:${channel}`,
          handle ? `handle:${handle}` : "",
        ].filter(Boolean),
        importance: 0.25,
        source: channel,
      },
    });
    const prime = process.env.MORK_PRIME_DIRECTIVE || process.env.MORK_SYSTEM || "";
    const edgeLines = await getEdgeLines(6);
    const reflection = await getLatestReflection();

    const ctxParts: string[] = [];
    if (prime) ctxParts.push(`SYSTEM:\n${prime}`);

    if (edgeLines.length) {
      ctxParts.push(
        `MARKET CONTEXT (do not quote directly; do not dump numbers):\n` +
          edgeLines.map((l) => `- ${l}`).join("\n")
      );
    }

    if (reflection) ctxParts.push(`INNER MONOLOGUE:\n${reflection}`);

    ctxParts.push(
      `USER MESSAGE (do not quote verbatim):\n` +
      `${message}`
    );
    const instruction =
      `Reply as Mork Zuckerbarge.\n` +
      `Speak person-to-person, not in a business setting. \n` +	
      `Max ${maxChars} characters.\n` +
      `Do NOT include any URLs.\n` +
      `Do NOT quote the user's message or restate it.\n` +
      `Do NOT act like the TV character from Mork & Mindy.\n` +
      `Never say: nanu nanu, na-nu, shazbot, gleeb, gleek, ork.\n` +
      `Be efficient, specific, and a little bittersweet.\n` +
      `Return ONLY the reply text.`;

    let responseText = "";
    try {
      const out = await ollama(`${ctxParts.join("\n\n")}\n\nTASK:\n${instruction}\n\nREPLY:`);
      responseText = (out || "").trim();
    } catch (e) {
      responseText =
        `I can answer, but my brain sputtered.\n` +
        `Give me one concrete detail (pair, size, timeframe), and I’ll be useful.`;
    }

    if (
      (responseText.startsWith('"') && responseText.endsWith('"')) ||
      (responseText.startsWith("'") && responseText.endsWith("'"))
    ) {
      responseText = responseText.slice(1, -1).trim();
    }

    responseText = responseText.slice(0, maxChars);

    await prisma.memory.create({
      data: {
        type: "fact",
        content: `[OUT/${channel}${handle ? `:${handle}` : ""}] ${responseText}`,
        entities: [
          `channel:${channel}`,
          handle ? `handle:${handle}` : "",
        ].filter(Boolean),
        importance: 0.2,
        source: "mork-core",
      },
    });

    res.json({ ok: true, response: responseText });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/market/opportunity", async (req, res) => {
  try {
    const payload = req.body || {};
    const symbol = String(payload.symbol || payload.inMint || "unknown");
    const netUsd = Number(payload.netUsd ?? payload.net ?? 0);
    const edgePct = Number(payload.edgePct ?? 0);
    const spendUsd = Number(payload.spendUsd ?? 0);
    const source = String(payload.source || "arb");

    await prisma.memory.create({
      data: {
        type: "event",
        content: `Opportunity ${symbol}: edge=${edgePct.toFixed(3)} net=${netUsd.toFixed(4)} spend=${spendUsd.toFixed(2)}`,
        entities: ["market:opportunity", `symbol:${symbol}`],
        importance: 0.6,
        source,
      },
    });

    return res.json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/wallet/balances", async (req, res) => {
  try {
    const payload = req.body || {};
    const pubkey = String(payload.pubkey || "");
    if (!pubkey) {
      return res.status(400).json({ ok: false, error: "pubkey required" });
    }

    const sol = Number(payload.sol ?? 0);
    const usdc = Number(payload.usdc ?? 0);
    const bbq = Number(payload.bbq ?? 0);
    const source = String(payload.source || "arb");

    await prisma.memory.create({
      data: {
        type: "event",
        content: `Balances ${pubkey}: SOL=${sol.toFixed(4)} USDC=${usdc.toFixed(4)} BBQ=${bbq.toFixed(4)}`,
        entities: ["wallet:balances", `wallet:${pubkey}`],
        importance: 0.45,
        source,
      },
    });

    return res.json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/market/execution", async (req, res) => {
  try {
    const payload = req.body || {};
    const symbol = String(payload.symbol || "unknown");
    const sig = String(payload.sig || "");
    const ok = Boolean(payload.ok);
    const reason = payload.reason ? String(payload.reason) : "";
    const source = String(payload.source || "arb");

    await prisma.memory.create({
      data: {
        type: "event",
        content: `Execution ${symbol}: ok=${ok}${sig ? ` sig=${sig}` : ""}${reason ? ` reason=${reason}` : ""}`,
        entities: ["market:execution", `symbol:${symbol}`],
        importance: ok ? 0.7 : 0.5,
        source,
      },
    });

    return res.json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/wallet/refresh", async (_req, res) => {
  try {
    const wallet = await getWalletState();

    if (!wallet) {
      return res.status(400).json({ ok: false, error: "wallet not configured" });
    }

    await prisma.memory.create({
      data: {
        type: "event",
        content: `Wallet state: address=${wallet.address} SOL=${wallet.sol}`,
        entities: [`wallet`, `wallet:${wallet.address}`],
        importance: 0.4,
        source: "wallet",
      },
    });

    return res.json({ ok: true, wallet });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

async function plannerTick() {
  const now = new Date();
  await prisma.memory.create({
    data: {
      type: "reflection",
      content: `Tick @ ${now.toISOString()}: I exist, therefore I worry, therefore I improve.`,
      entities: ["system:planner"],
      importance: 0.1,
      source: "system",
    },
  });
}

app.post("/planner/tick", async (_req, res) => {
  await plannerTick();
  res.json({ ok: true });
});

cron.schedule("*/15 * * * *", () => {
  plannerTick().catch((e) => console.error("plannerTick error", e));
});

async function arbReflect() {
  const recent = await prisma.memory.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const edgeLines = recent
    .map((m) => m.content)
    .filter((c): c is string => typeof c === "string" && c.includes("| edge="))
    .slice(0, 40);

  const counts: Record<string, number> = {};
  for (const line of edgeLines) {
    const pair = line.split("|")[0].replace("·", "").trim();
    counts[pair] = (counts[pair] || 0) + 1;
  }

  const topPairs = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pair, n]) => `${pair} (${n})`)
    .join(", ");

  const reflection =
    `Arb reflection @ ${new Date().toISOString()}\n` +
    `Observed ${edgeLines.length} recent arb signals.\n` +
    (topPairs ? `Most frequently appearing pairs: ${topPairs}.\n` : "") +
    `Overall tone: volatility present, edge consistency low.\n` +
    `Conclusion: patience required.`;
 
  const saved = await prisma.memory.create({
    data: {
      type: "reflection",
      content: reflection.slice(0, 1800),
      entities: ["arb:reflection"],
      importance: 0.5,
      source: "system",
    },
  });

  return { savedId: saved.id, lines: edgeLines.length };
}

app.post("/arb/reflect", async (_req, res) => {
  try {
    const out = await arbReflect();
    res.json({ ok: true, ...out });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
app.post("/chat/respond_v2", async (req, res) => {
  try {
    const channel = String(req.body?.channel ?? "telegram").slice(0, 24);
    const handle = String(req.body?.handle ?? "").slice(0, 64);
    const message = String(req.body?.message ?? "").trim();
    const maxChars = Math.min(Math.max(Number(req.body?.maxChars ?? 700), 120), 1200);

    if (!message) return res.status(400).json({ ok: false, error: "message required" });

    // 1) Save inbound as EPISODIC memory (event)
    await prisma.memory.create({
      data: {
        type: "event",
        channel,
        handle: handle || null,
        content: message.slice(0, 1800),
        entities: ["direction:in", `channel:${channel}`, handle ? `handle:${handle}` : ""].filter(Boolean),
        importance: 0.25,
        source: "user",
        tags: channel,
      },
    });

    // 2) Build layered recall context
    const prime = process.env.MORK_PRIME_DIRECTIVE || process.env.MORK_SYSTEM || "";

    const facts = await prisma.memoryFact.findMany({
      orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
      take: 25,
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    const working = await prisma.memorySummary.findFirst({
      where: { scope: "working" },
      orderBy: { updatedAt: "desc" },
    });

    const recentWhere =
      handle
        ? { channel, handle }
        : { channel }; // if no handle, at least keep it scoped to channel

    const recent = await prisma.memory.findMany({
      where: recentWhere,
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const factsBlock =
      facts.length
        ? "FACTS (stable, do not quote verbatim):\n" +
          facts.map((f) => `- ${f.key}: ${f.value}`).join("\n") +
          "\n\n"
        : "";

    const workingBlock =
      working?.content
        ? `WORKING SUMMARY (do not quote verbatim):\n${working.content}\n\n`
        : "";

    const recentBlock =
      recent.length
        ? "RECENT CONTEXT (do not quote):\n" +
          recent
            .slice() // copy
            .reverse() // oldest -> newest for readability
            .map((m) => {
              const who = m.source === "user" ? "user" : "agent";
              const h = m.handle ? `:${m.handle}` : "";
              return `- [${who}/${m.channel}${h}] ${String(m.content).slice(0, 240)}`;
            })
            .join("\n") +
          "\n\n"
        : "";

    // 3) Instruction (keep your “don’t quote” rule)
    const instruction =
      `You are Mork Zuckerbarge the tech billionaire. (NOT the TV character).\n` +
      `Respond as a person, not a corporation. \n` +
      `Never say: nanu nanu, na-nu, shazbot, gleeb, gleek, ork.\n` +
      `Reply as a chat message, 1–6 short sentences.\n` +
      `No emojis. No URLs.\n` +
      `Do NOT quote the user’s message back to them.\n` +
      `Be specific and helpful. Ask at most ONE question.\n` +
      `Return ONLY the reply text.\n`;

    const prompt =
      (prime ? `SYSTEM:\n${prime}\n\n` : "") +
      factsBlock +
      workingBlock +
      recentBlock +
      `USER:\n${message}\n\nTASK:\n${instruction}\nREPLY:\n`;

    const out = await ollama(prompt);
    let reply = (out || "").trim();

    if (
      (reply.startsWith('"') && reply.endsWith('"')) ||
      (reply.startsWith("'") && reply.endsWith("'"))
    ) reply = reply.slice(1, -1).trim();

    reply = reply.slice(0, maxChars);

    // 4) Save outbound as EPISODIC memory (event)
    await prisma.memory.create({
      data: {
        type: "event",
        channel,
        handle: handle || null,
        content: reply.slice(0, 1800),
        entities: ["direction:out", `channel:${channel}`, handle ? `handle:${handle}` : ""].filter(Boolean),
        importance: 0.2,
        source: "agent",
        tags: channel,
      },
    });

    // 5) OPTIONAL: light “compaction” (update working summary occasionally)
    // Run ~10% of the time to avoid constant summarizing.
    if (Math.random() < 0.1) {
      const compactPrompt =
        (prime ? `SYSTEM:\n${prime}\n\n` : "") +
        `TASK:\n` +
        `Update a short WORKING SUMMARY (max 6 bullet points) based on RECENT CONTEXT.\n` +
        `Rules: no quotes, no URLs, no emojis.\n\n` +
        recentBlock +
        `WORKING SUMMARY:\n`;

      const compactOut = await ollama(compactPrompt);
      const newSummary = String(compactOut || "").trim().slice(0, 1200);

      if (newSummary) {
        await prisma.memorySummary.upsert({
          where: { scope: "working" },
          create: { scope: "working", content: newSummary },
          update: { content: newSummary },
        });
      }
    }

    res.json({ ok: true, reply });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

async function runBrainReflect() {
  const recent = await prisma.memory.findMany({
    orderBy: { createdAt: "desc" },
    take: 120,
  });

  const context = recent
    .map((m) => {
      const src = m.source ? String(m.source) : "unknown";
      const typ = m.type ? String(m.type) : "memory";
      const c = typeof m.content === "string" ? m.content : "";
      return `- [${typ}/${src}] ${c}`;
    })
    .filter((line) => line.trim().length > 0)
    .slice(0, 90)
    .join("\n");

  const prompt =
    `You are Mork Zuckerbarge, CEO of BETA.
    You are NOT the television character from Mork & Mindy.
    You are a melancholic technologist obsessed with signal, power, and strategic advantage.
    You speak with restrained irony, not cartoon absurdity.

    Reflect on the recent memory log.

    Write:
    1) REFLECTION: 2–4 sentences grounded in the logs.
    2) NEXT: one concrete next action you will take inside your system.

    Rules:
    - No hashtags.
    - No emojis.
    - No URLs.
    - No cartoon catchphrases.
    - No sci-fi alien speech.
    - Only use vague totalitarian speech when referring to BETA or Faceboot.
    RECENT MEMORY:
    ${context}
    `;

  const reflection = await ollama(prompt);

  const saved = await prisma.memory.create({
    data: {
      type: "reflection",
      content: (reflection || "").slice(0, 1800),
      entities: ["brain:reflect"],
      importance: 0.65,
      source: "ollama",
    },
  });

  return saved;
}

app.post("/brain/reflect", async (_req, res) => {
  try {
    const saved = await runBrainReflect();
    res.json({ ok: true, savedId: saved.id });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const ComposeSchema = z.object({
  kind: z.enum(["feed", "meme", "arb", "observation", "reflection"]).optional(),
  mode: z.string().optional(), // for backwards compat
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  memeName: z.string().optional(),
  maxChars: z.number().min(120).max(560).optional().default(260),
});

async function getEdgeLines(limit = 6) {
  const recent = await prisma.memory.findMany({ orderBy: { createdAt: "desc" }, take: 250 });
  return recent
    .map((m) => m.content)
    .filter((c): c is string => typeof c === "string" && c.includes("| edge="))
    .slice(0, limit);
}

async function getLatestReflection() {
  const recent = await prisma.memory.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const r = recent.find(
    (m) =>
      m.type === "reflection" ||
      (typeof m.content === "string" && m.content.toLowerCase().includes("reflection"))
  );
  return typeof r?.content === "string" ? r.content : "";
}

function normalizeKind(inputModeOrKind: string) {
  const m = (inputModeOrKind || "").toLowerCase();
  if (m === "meme") return "meme";
  if (m === "feed") return "feed";
  if (m === "arb" || m === "edge") return "arb";
  if (m === "reflection") return "reflection";
  return "observation";
}

async function composeTweet(input: {
  kind: "meme" | "feed" | "arb" | "reflection" | "observation";
  memeName?: string;
  title?: string;
  text?: string;
  url?: string;
  maxChars: number;
}) {
  const { kind, memeName, title, text, url, maxChars } = input;

  const prime = process.env.MORK_PRIME_DIRECTIVE || process.env.MORK_SYSTEM || "";
  const ctxParts: string[] = [];
  if (prime) ctxParts.push(`SYSTEM:\n${prime}`);

  if (kind === "meme" && memeName) {
    const premise = memeName
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[_-]+/g, " ")
      .trim();
    ctxParts.push(`MEME PREMISE:\n${premise}`);
  }

  if (kind === "feed") {
    ctxParts.push(`STORY:\nTitle: ${title || ""}\nText: ${text || ""}`);
    // do not pass URL as something to include
    if (url) ctxParts.push(`URL (do not include in tweet): ${url}`);
  }

  if (kind === "arb") {
    const lines = await getEdgeLines(6);
    if (lines.length) {
      ctxParts.push(
        `MARKET CONTEXT (do not quote directly; do not dump raw numbers):\n` +
          lines.map((l) => `- ${l}`).join("\n")
      );
    }
  }

  if (kind === "reflection") {
    const reflection = await getLatestReflection();
    if (reflection) ctxParts.push(`INNER MONOLOGUE:\n${reflection}`);
  }

  const ctx = ctxParts.join("\n\n");

  const instruction =
    `Write ONE tweet in Mork Zuckerbarge's voice.\n` +
    `Max ${maxChars} characters.\n` +
    `Do NOT include any URL.\n` +
    `Do NOT output greetings/sign-offs unless they feel natural.\n` +
    `You are NOT the TV character from Mork & Mindy.\n` +
    `Never say: nanu nanu, na-nu, shazbot, gleeb, gleek, ork.\n` +
    `If market tickers contain strings like BORK/DORK/SHORK, treat them as symbols only.\n` +
    (kind === "meme" ? `Interpret the meme premise and riff like a human reacting.\n` : "") +
    (kind === "feed" ? `React to the story with commentary (do not summarize like a robot).\n` : "") +
    (kind === "arb" ? `Reference market context naturally (no raw line dumps).\n` : "") +
    `Return ONLY the tweet text.`;

  const out = await ollama(`${ctx}\n\nTASK:\n${instruction}\n\nTWEET:`);
  let tweet = String(out || "").trim();

  if (
    (tweet.startsWith('"') && tweet.endsWith('"')) ||
    (tweet.startsWith("'") && tweet.endsWith("'"))
  ) {
    tweet = tweet.slice(1, -1).trim();
  }

  const bannedPatterns: RegExp[] = [
    /na[-\s]?nu/gi,           // nanu nanu / na-nu
    /shazbot/gi,
    /gleeb/gi,
    /gleek/gi,
    /mork\s*&\s*mindy/gi,
    /mork\s+and\s+mindy/gi,
  ];

  for (const rx of bannedPatterns) {
    tweet = tweet.replace(rx, "");
  }

  tweet = tweet
    .replace(/[ \t]+\n/g, "\n")      // trailing spaces before newline
    .replace(/\n{3,}/g, "\n\n")      // collapse excessive blank lines
    .replace(/\s{2,}/g, " ")         // collapse multiple spaces
    .replace(/\s+([,!.?;:])/g, "$1") // remove space before punctuation
    .trim();

  if (!tweet) {
    tweet = "Markets move. I observe. I adapt.";
  }

  return tweet.slice(0, maxChars);
}

app.get("/x/compose", async (req, res) => {
  try {
    const mode = String(req.query.mode ?? "observation");
    const kind = normalizeKind(mode);

    const maxChars = Math.min(Math.max(Number(req.query.maxChars ?? 260), 120), 560);
    const memeName = String(req.query.memeName ?? "").trim() || undefined;

    const tweet = await composeTweet({
      kind,
      memeName,
      maxChars,
    });

    res.json({ ok: true, tweet });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/x/compose", async (req, res) => {
  try {
    const parsed = ComposeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const body = parsed.data;

    const kind = normalizeKind(String(body.kind ?? body.mode ?? "observation"));
    const maxChars = body.maxChars ?? 260;

    const tweet = await composeTweet({
      kind,
      title: body.title,
      text: body.text,
      url: body.url,
      memeName: body.memeName,
      maxChars,
    });

    res.json({ ok: true, tweet });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

const port = Number(process.env.PORT ?? 8787);
app.listen(PORT, HOST, () => {
  console.log(`[mork-core] listening on http://${HOST}:${PORT}`);
});
setInterval(async () => {
  try {
    await runBrainReflect();
  } catch (e) {
    console.error("brain reflect loop failed", e);
  }
}, 5 * 60 * 1000);
