import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseEnvStyleUrls, readStylePackUrls } from "@/lib/core/stylePack";

export type GeneratedMedia = {
  kind: "image" | "video" | "audio";
  url: string;
  filename: string;
  mimeType: string;
  prompt: string;
  provider: string;
};

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");
const POLLINATIONS_VIDEO_MODELS = new Set([
  "veo",
  "seedance",
  "seedance-pro",
  "wan",
  "wan-fast",
  "grok-video-pro",
  "ltx-2",
  "p-video",
  "nova-reel",
]);


const POLLINATIONS_AUDIO_FALLBACK_MODELS = ["elevenmusic", "openai-audio", "openai"];
const POLLINATIONS_TRANSCRIPTION_MODELS = new Set(["scribe", "whisper-1", "whisper-large-v3", "universal-2", "universal-3-pro"]);

function isPollinationsModelError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  if (lowered.includes('path":["model"]') || lowered.includes("invalid option")) {
    return true;
  }
  try {
    const parsed = JSON.parse(detail) as {
      error?: { details?: Array<{ path?: string[]; code?: string; message?: string }>; detailsRaw?: unknown };
    };
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      return details.some(
        (entry) =>
          Array.isArray(entry?.path) &&
          entry.path.includes("model") &&
          (entry.code === "invalid_value" || (entry.message || "").toLowerCase().includes("invalid option"))
      );
    }
  } catch {
    return false;
  }
  return false;
}

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
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "bin";
}

async function persistBytes(
  bytes: Uint8Array<ArrayBufferLike>,
  prompt: string,
  mimeType: string
): Promise<{ filename: string; url: string }> {
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

async function fetchBinary(url: string, context: string): Promise<{ bytes: Uint8Array<ArrayBufferLike>; mimeType: string }> {
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

async function getStyleReferenceUrls(): Promise<string[]> {
  const envUrls = parseEnvStyleUrls(process.env.MEDIA_STYLE_IMAGE_URLS || "");
  const persistedUrls = await readStylePackUrls();
  return [...new Set([...envUrls, ...persistedUrls])].slice(0, 7);
}

async function detectRemoteMimeType(url: string): Promise<string | null> {
  const attempt = async (method: "HEAD" | "GET"): Promise<string | null> => {
    const res = await fetch(url, { method, cache: "no-store" });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return contentType.split(";")[0]?.trim() || null;
  };

  try {
    const viaHead = await attempt("HEAD");
    if (viaHead) return viaHead;
  } catch {
    // Some image hosts block HEAD; ignore and retry with GET.
  }

  try {
    return await attempt("GET");
  } catch {
    return null;
  }
}


function buildStyleInfluencedPrompt(prompt: string): string {
  return `${prompt}

Style guidance: use provided reference images for broad visual language only (palette, mood, lighting, texture, composition rhythm). Do NOT recreate specific subjects, scenes, characters, logos, layouts, camera angles, or 1:1 compositions from any reference image. Avoid "turn this image into 3D" behavior; generate a novel scene that matches the user prompt while keeping only high-level stylistic influence.`;
}

async function normalizeVideoStyleReferences(model: string, refs: string[]): Promise<string[]> {
  if (model !== "nova-reel" || !refs.length) return refs;
  const accepted: string[] = [];
  for (const ref of refs) {
    const mimeType = await detectRemoteMimeType(ref);
    if (mimeType === "image/png") {
      accepted.push(ref);
    }
  }
  return accepted;
}

export async function generateImage(prompt: string): Promise<GeneratedMedia> {
  const imageUrl = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  imageUrl.searchParams.set("nologo", "true");
  imageUrl.searchParams.set("enhance", "true");
  const seed = Number(process.env.MEDIA_IMAGE_SEED || "");
  if (Number.isFinite(seed) && seed > 0) {
    imageUrl.searchParams.set("seed", String(Math.floor(seed)));
  }
  imageUrl.searchParams.set("width", process.env.MEDIA_IMAGE_WIDTH || "1024");
  imageUrl.searchParams.set("height", process.env.MEDIA_IMAGE_HEIGHT || "1024");
  const model = (process.env.MEDIA_IMAGE_MODEL || "flux").trim();
  if (model) {
    imageUrl.searchParams.set("model", model);
  }
  const styleRefs = await getStyleReferenceUrls();
  if (styleRefs.length) {
    imageUrl.searchParams.set("image", styleRefs.join(","));
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
  const pollinationsBaseRx = /^https?:\/\/gen\.pollinations\.ai\/(?:video|image)\/?$/i;
  const usePollinationsDefault = !configuredEndpoint || pollinationsBaseRx.test(configuredEndpoint);
  const method = usePollinationsDefault ? "GET" : (process.env.MEDIA_VIDEO_METHOD || "POST").toUpperCase();
  const model = (process.env.MEDIA_VIDEO_MODEL || "").trim();
  const seed = Number(process.env.MEDIA_VIDEO_SEED || "");
  const fallbackVideoModel = process.env.MEDIA_VIDEO_MODEL_DEFAULT || "ltx-2";
  const selectedModel =
    model && POLLINATIONS_VIDEO_MODELS.has(model)
      ? model
      : POLLINATIONS_VIDEO_MODELS.has(fallbackVideoModel)
      ? fallbackVideoModel
      : "ltx-2";

  const styleAwarePrompt = buildStyleInfluencedPrompt(prompt);
  const endpoint = usePollinationsDefault
    ? `https://gen.pollinations.ai/image/${encodeURIComponent(styleAwarePrompt)}`
    : configuredEndpoint;
  const url = new URL(endpoint);
  if (usePollinationsDefault) {
    url.searchParams.set("model", selectedModel);
    if (Number.isFinite(seed) && seed > 0) {
      url.searchParams.set("seed", String(Math.floor(seed)));
    }
    const duration = Number(process.env.MEDIA_VIDEO_DURATION || "");
    if (Number.isFinite(duration) && duration >= 1 && duration <= 10) {
      url.searchParams.set("duration", String(Math.floor(duration)));
    }
    const aspectRatio = (process.env.MEDIA_VIDEO_ASPECT_RATIO || "").trim();
    if (aspectRatio === "16:9" || aspectRatio === "9:16") {
      url.searchParams.set("aspectRatio", aspectRatio);
    }
    if ((process.env.MEDIA_VIDEO_AUDIO || "").trim() === "1") {
      url.searchParams.set("audio", "true");
    }
    const styleRefs = await normalizeVideoStyleReferences(selectedModel, await getStyleReferenceUrls());
    if (styleRefs.length) {
      url.searchParams.set("image", styleRefs.join(","));
    }
  }

  const body = !usePollinationsDefault && method !== "GET" ? JSON.stringify({ prompt: styleAwarePrompt }) : undefined;
  const baseHeaders: HeadersInit = {
    ...(!usePollinationsDefault ? { "Content-Type": "application/json" } : {}),
  };
  const token = (process.env.MEDIA_VIDEO_TOKEN || "").trim();
  if (usePollinationsDefault && token) {
    // Pollinations docs support API keys in either Authorization bearer header or `?key=` query params.
    // Setting both increases compatibility for proxies/gateways that strip auth headers.
    url.searchParams.set("key", token);
  }
  const authHeaders: HeadersInit = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : { ...baseHeaders };

  const executeRequest = async (requestUrl: URL, headers: HeadersInit = authHeaders) =>
    fetch(requestUrl.toString(), {
      method,
      headers,
      body,
      cache: "no-store",
    });

  const maybeRetryWithoutNovaReel = async (response: Response): Promise<Response> => {
    if (!usePollinationsDefault || selectedModel !== "nova-reel") return response;
    if (url.searchParams.get("model") !== "nova-reel") return response;
    const detail = await response.clone().text().catch(() => "");
    if (!detail.toLowerCase().includes("http2.connect method is not implemented")) {
      return response;
    }
    url.searchParams.set("model", "ltx-2");
    return executeRequest(url, authHeaders);
  };

  let res = await executeRequest(url);
  res = await maybeRetryWithoutNovaReel(res);
  if (usePollinationsDefault && res.status === 400) {
    const detail = await res.text().catch(() => "");
    const invalidModelResponse = isPollinationsModelError(detail);
    if (invalidModelResponse) {
      url.searchParams.delete("model");
      res = await executeRequest(url, authHeaders);
      if (!res.ok && token) {
        const unauthDetail = await res.text().catch(() => "");
        const invalidModelWithToken = isPollinationsModelError(unauthDetail);
        if (invalidModelWithToken) {
          res = await executeRequest(url, baseHeaders);
        }
      }
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const hasToken = Boolean(token);
    throw new Error(
      !usePollinationsDefault
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}`
        : hasToken && res.status === 401
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. Pollinations rejected the provided MEDIA_VIDEO_TOKEN. Confirm the token is valid for gen.pollinations.ai/video and restart the app after updating env vars.`
        : usePollinationsDefault &&
          selectedModel === "nova-reel" &&
          detail.toLowerCase().includes("expected type image/png")
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. MEDIA_VIDEO_MODEL=nova-reel only accepts PNG style/reference images. Convert MEDIA_STYLE_IMAGE_URLS (and Setup style-pack URLs) to PNG, or switch MEDIA_VIDEO_MODEL to a model that accepts JPEG references.`
        : hasToken
        ? `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. Pollinations rejected the request even though MEDIA_VIDEO_TOKEN is set.${model && !POLLINATIONS_VIDEO_MODELS.has(model) ? ` MEDIA_VIDEO_MODEL=${model} is not a supported Pollinations video model; using ${selectedModel}.` : ""}`
        : `Video generation failed (${res.status})${detail ? `: ${detail}` : ""}. Set MEDIA_VIDEO_TOKEN for Pollinations, or set MEDIA_VIDEO_ENDPOINT to a custom provider.${model && !POLLINATIONS_VIDEO_MODELS.has(model) ? ` MEDIA_VIDEO_MODEL=${model} is not a supported Pollinations video model; using ${selectedModel}.` : ""}`
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

export async function generateAudio(prompt: string): Promise<GeneratedMedia> {
  const endpoint = new URL(`https://gen.pollinations.ai/audio/${encodeURIComponent(prompt)}`);
  endpoint.searchParams.set("nologo", "true");
  endpoint.searchParams.set("enhance", "true");
  let audioModel = (process.env.MEDIA_AUDIO_MODEL || "").trim();
  if (audioModel && POLLINATIONS_TRANSCRIPTION_MODELS.has(audioModel.toLowerCase())) {
    audioModel = "";
  }
  if (!audioModel) audioModel = "elevenmusic";
  if (audioModel) endpoint.searchParams.set("model", audioModel);
  endpoint.searchParams.set("instrumental", "true");
  const token = (process.env.MEDIA_VIDEO_TOKEN || "").trim();
  if (token) endpoint.searchParams.set("key", token);
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}`, accept: "audio/mpeg" } : { accept: "audio/mpeg" };
  const requestAudio = async (url: URL) => fetch(url.toString(), { method: "GET", headers, cache: "no-store" });
  let res = await requestAudio(endpoint);
  if (!res.ok && audioModel) {
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && isPollinationsModelError(detail)) {
      endpoint.searchParams.delete("model");
      res = await requestAudio(endpoint);
    } else {
      throw new Error(`Audio generation failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Audio generation failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  let mimeType = (res.headers.get("content-type") || "audio/mpeg").toLowerCase();
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(await res.arrayBuffer());

  const retryWithModel = async (model: string): Promise<{ mimeType: string; bytes: Uint8Array<ArrayBufferLike> } | null> => {
    endpoint.searchParams.set("model", model);
    const modelRes = await requestAudio(endpoint);
    if (!modelRes.ok) return null;
    const nextMimeType = (modelRes.headers.get("content-type") || "audio/mpeg").toLowerCase();
    const nextBytes = new Uint8Array(await modelRes.arrayBuffer());
    if (!nextBytes.length || !nextMimeType.startsWith("audio/")) return null;
    return { mimeType: nextMimeType, bytes: nextBytes };
  };

  const isAudioMime = mimeType.startsWith("audio/");
  if (!bytes.length || !isAudioMime) {
    if (audioModel) endpoint.searchParams.delete("model");
    const retryRes = await requestAudio(endpoint);
    if (!retryRes.ok) {
      const detail = await retryRes.text().catch(() => "");
      throw new Error(`Audio generation failed (${retryRes.status})${detail ? `: ${detail}` : ""}`);
    }
    mimeType = (retryRes.headers.get("content-type") || "audio/mpeg").toLowerCase();
    bytes = new Uint8Array(await retryRes.arrayBuffer());

    if (!bytes.length || !mimeType.startsWith("audio/")) {
      for (const model of POLLINATIONS_AUDIO_FALLBACK_MODELS) {
        if (model === audioModel) continue;
        const retried = await retryWithModel(model);
        if (retried) {
          mimeType = retried.mimeType;
          bytes = retried.bytes;
          break;
        }
      }
    }
  }

  if (!bytes.length || !mimeType.startsWith("audio/")) {
    throw new Error(`Audio generation failed: provider returned non-audio payload (${mimeType || "unknown"}). Try setting MEDIA_AUDIO_MODEL=openai-audio.`);
  }
  const persisted = await persistBytes(bytes, prompt, mimeType);
  return {
    kind: "audio",
    prompt,
    provider: "pollinations",
    mimeType,
    ...persisted,
  };
}
