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
const POLLINATIONS_VIDEO_MODELS = new Set([
  "kontext",
  "seedream5",
  "seedream",
  "seedream-pro",
  "nanobanana",
  "nanobanana-2",
  "nanobanana-pro",
  "gptimage",
  "gptimage-large",
  "gpt-image-2",
  "veo",
  "seedance",
  "seedance-pro",
  "wan",
  "wan-fast",
  "wan-image",
  "wan-image-pro",
  "qwen-image",
  "grok-imagine",
  "grok-imagine-pro",
  "grok-video-pro",
  "zimage",
  "flux",
  "klein",
  "ltx-2",
  "p-image",
  "p-image-edit",
  "p-video",
  "nova-canvas",
  "nova-reel",
]);

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
  const configuredEndpoint = (process.env.MEDIA_VIDEO_ENDPOINT || "").trim();
  const pollinationsBaseRx = /^https?:\/\/gen\.pollinations\.ai\/video\/?$/i;
  const usePollinationsDefault = !configuredEndpoint || pollinationsBaseRx.test(configuredEndpoint);
  const method = usePollinationsDefault ? "GET" : (process.env.MEDIA_VIDEO_METHOD || "POST").toUpperCase();
  const model = (process.env.MEDIA_VIDEO_MODEL || "").trim();
  const hasInvalidPollinationsModel = usePollinationsDefault && Boolean(model) && !POLLINATIONS_VIDEO_MODELS.has(model);
  const seed = Number(process.env.MEDIA_VIDEO_SEED || "");

  const endpoint = usePollinationsDefault
    ? `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}`
    : configuredEndpoint;
  const url = new URL(endpoint);
  if (usePollinationsDefault) {
    if (model && POLLINATIONS_VIDEO_MODELS.has(model)) {
      url.searchParams.set("model", model);
    }
    if (Number.isFinite(seed) && seed > 0) {
      url.searchParams.set("seed", String(Math.floor(seed)));
    }
  }

  const body = !usePollinationsDefault && method !== "GET" ? JSON.stringify({ prompt }) : undefined;
  const headers: HeadersInit = {
    ...(!usePollinationsDefault ? { "Content-Type": "application/json" } : {}),
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
    const hasToken = Boolean(token);
    throw new Error(
      !usePollinationsDefault
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}`
        : hasToken
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. Pollinations rejected the request even though MEDIA_VIDEO_TOKEN is set.${hasInvalidPollinationsModel ? ` MEDIA_VIDEO_MODEL=${model} is not a supported Pollinations video model and was ignored.` : ""}`
        : `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. Set MEDIA_VIDEO_TOKEN for Pollinations, or set MEDIA_VIDEO_ENDPOINT to a custom provider.${hasInvalidPollinationsModel ? ` MEDIA_VIDEO_MODEL=${model} is not a supported Pollinations video model and was ignored.` : ""}`
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
    provider: usePollinationsDefault ? "pollinations" : "custom-free-tier",
    mimeType,
    ...persisted,
  };
}
