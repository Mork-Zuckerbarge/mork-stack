import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type GeneratedMedia = {
  kind: "image" | "video";
  url: string;
  filename: string;
  mimeType: string;
  prompt: string;
  provider: string;
};

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

function safeBaseName(input: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 40) || "media";
}

function fileExtForMime(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  return "bin";
}

async function persistBytes(bytes: Uint8Array, prompt: string, mimeType: string): Promise<{ filename: string; url: string }> {
  await mkdir(GENERATED_DIR, { recursive: true });
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  const digest = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 10);
  const ext = fileExtForMime(mimeType);
  const filename = `${stamp}-${safeBaseName(prompt)}-${digest}.${ext}`;
  const fullPath = path.join(GENERATED_DIR, filename);
  await writeFile(fullPath, bytes);
  return { filename, url: `/generated/${filename}` };
}

async function fetchBinary(url: string, context: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`${context} failed (${res.status})`);
  }
  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) {
    throw new Error(`${context} returned empty bytes`);
  }
  return { bytes, mimeType };
}

export async function generateImage(prompt: string): Promise<GeneratedMedia> {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const imageUrl = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  imageUrl.searchParams.set("nologo", "true");
  imageUrl.searchParams.set("enhance", "true");
  imageUrl.searchParams.set("seed", String(seed));
  imageUrl.searchParams.set("width", process.env.MEDIA_IMAGE_WIDTH || "1024");
  imageUrl.searchParams.set("height", process.env.MEDIA_IMAGE_HEIGHT || "1024");
  const model = (process.env.MEDIA_IMAGE_MODEL || "flux").trim();
  if (model) {
    imageUrl.searchParams.set("model", model);
  }

  const { bytes, mimeType } = await fetchBinary(imageUrl.toString(), "Image generation");
  const persisted = await persistBytes(bytes, prompt, mimeType);
  return {
    kind: "image",
    prompt,
    provider: "pollinations",
    mimeType,
    ...persisted,
  };
}

export async function generateVideo(prompt: string): Promise<GeneratedMedia> {
  const customEndpoint = (process.env.MEDIA_VIDEO_ENDPOINT || "").trim();
  const method = customEndpoint ? (process.env.MEDIA_VIDEO_METHOD || "POST").toUpperCase() : "GET";
  const model = (process.env.MEDIA_VIDEO_MODEL || "").trim();
  const seed = Number(process.env.MEDIA_VIDEO_SEED || "");

  const endpoint = customEndpoint || `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}`;
  const url = new URL(endpoint);
  if (!customEndpoint) {
    if (model) {
      url.searchParams.set("model", model);
    }
    if (Number.isFinite(seed) && seed > 0) {
      url.searchParams.set("seed", String(Math.floor(seed)));
    }
  }

  const body = customEndpoint && method !== "GET" ? JSON.stringify({ prompt }) : undefined;
  const headers: HeadersInit = {
    ...(customEndpoint ? { "Content-Type": "application/json" } : {}),
  };
  const token = (process.env.MEDIA_VIDEO_TOKEN || "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      customEndpoint
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}`
        : `Video generation failed (${res.status}). Set MEDIA_VIDEO_TOKEN for Pollinations, or set MEDIA_VIDEO_ENDPOINT to a custom provider.`
    );
  }

  const mimeType = res.headers.get("content-type") || "video/mp4";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) {
    throw new Error("Video generation returned empty bytes");
  }
  const persisted = await persistBytes(bytes, prompt, mimeType);
  return {
    kind: "video",
    prompt,
    provider: customEndpoint ? "custom-free-tier" : "pollinations",
    mimeType,
    ...persisted,
  };
}
