export const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
export const MOLTBOOK_API_KEY_STORAGE_KEY = "moltbook.api-key.v1";

export class MoltbookAgentError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = "MoltbookAgentError";
  }
}


const DEFAULT_AGENT_BANNED_PHRASES = [
  "nanu nanu",
  "na-nu",
  "shazbot",
  "gleeb",
  "gleek",
  "ork",
  "mork and mindy",
  "reflection",
  "observation",
];
const AGENT_BANNED_PHRASES_STORAGE_KEY = "agent.banned-phrases.v1";

function splitLinesOrCsv(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function configuredBannedPhrases(): string[] {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(AGENT_BANNED_PHRASES_STORAGE_KEY);
    if (saved) return Array.from(new Set([...splitLinesOrCsv(saved), ...DEFAULT_AGENT_BANNED_PHRASES]));
  }

  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NEXT_PUBLIC_AGENT_BANNED_PHRASES;
  return env ? Array.from(new Set([...splitLinesOrCsv(env), ...DEFAULT_AGENT_BANNED_PHRASES])) : DEFAULT_AGENT_BANNED_PHRASES;
}

function phraseToPattern(phrase: string): string {
  return phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\ /g, "\\s+")
    .replace(/\\-/g, "\\s*-\\s*");
}

export function sanitizeBannedPhrases(text: string, phrases = configuredBannedPhrases()): string {
  const parts = phrases.map(phraseToPattern).filter(Boolean);
  const banned = parts.length ? new RegExp(`\\b(?:${parts.join("|")})\\b`, "gi") : null;
  return (banned ? text.replace(banned, " ") : text)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type MoltbookRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  apiKey?: string;
  body?: Record<string, unknown>;
};

type MoltbookApiResult = {
  success?: boolean;
  error?: string;
  message?: string;
  verification_required?: boolean;
  verification?: unknown;
  [key: string]: unknown;
};



type MoltbookRegisterResult = MoltbookApiResult & {
  agent?: {
    api_key?: string;
    claim_url?: string;
    verification_code?: string;
    [key: string]: unknown;
  };
};
function assertMoltbookUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new MoltbookAgentError("Moltbook API path must start with '/'.", "INVALID_PATH");
  }

  return `${MOLTBOOK_API_BASE}${path}`;
}

async function moltbookPublicRequest(path: string, body: Record<string, unknown>): Promise<MoltbookApiResult> {
  const url = assertMoltbookUrl(path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: MoltbookApiResult = {};

  if (text) {
    try {
      payload = JSON.parse(text) as MoltbookApiResult;
    } catch {
      throw new MoltbookAgentError("Moltbook returned a non-JSON response.", "NON_JSON_RESPONSE", response.status);
    }
  }

  if (!response.ok || payload.success === false) {
    throw new MoltbookAgentError(
      String(payload.error || payload.message || `Moltbook request failed (${response.status}).`),
      "REQUEST_FAILED",
      response.status,
    );
  }

  return payload;
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey ?? getSavedMoltbookApiKey();
  if (!resolved) {
    throw new MoltbookAgentError("No Moltbook API key is configured.", "NO_API_KEY");
  }

  return resolved;
}

async function moltbookRequest(path: string, options: MoltbookRequestOptions = {}): Promise<MoltbookApiResult> {
  const method = options.method ?? "GET";
  const apiKey = resolveApiKey(options.apiKey);
  const url = assertMoltbookUrl(path);

  const makeHeaders = (authMode: "bearer" | "raw") => ({
    Authorization: authMode === "bearer" ? `Bearer ${apiKey}` : apiKey,
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  });

  let response = await fetch(url, {
    method,
    headers: makeHeaders("bearer"),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401 || response.status === 403) {
    response = await fetch(url, {
      method,
      headers: makeHeaders("raw"),
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }

  const text = await response.text();
  let payload: MoltbookApiResult = {};

  if (text) {
    try {
      payload = JSON.parse(text) as MoltbookApiResult;
    } catch {
      throw new MoltbookAgentError("Moltbook returned a non-JSON response.", "NON_JSON_RESPONSE", response.status);
    }
  }

  if (!response.ok || payload.success === false) {
    if (response.status === 401 || /invalid|unauthoriz/i.test(String(payload.error || payload.message || ""))) {
      clearSavedMoltbookApiKey();
    }

    throw new MoltbookAgentError(
      String(payload.error || payload.message || `Moltbook request failed (${response.status}).`),
      "REQUEST_FAILED",
      response.status,
    );
  }

  return payload;
}

export function getSavedMoltbookApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(MOLTBOOK_API_KEY_STORAGE_KEY);
}

export function saveMoltbookApiKey(apiKey: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MOLTBOOK_API_KEY_STORAGE_KEY, apiKey);
}

export function clearSavedMoltbookApiKey(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(MOLTBOOK_API_KEY_STORAGE_KEY);
}

export async function getMoltbookHome(apiKey?: string): Promise<MoltbookApiResult> {
  return moltbookRequest("/home", { apiKey });
}

export async function getMoltbookFeed(
  params: { sort?: "hot" | "new" | "top"; limit?: number; filter?: "all" | "following"; cursor?: string } = {},
  apiKey?: string,
): Promise<MoltbookApiResult> {
  const query = new URLSearchParams();
  if (params.sort) query.set("sort", params.sort);
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (params.filter) query.set("filter", params.filter);
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return moltbookRequest(`/feed${suffix}`, { apiKey });
}

export async function postToMoltbook(
  input: {
    submolt_name: string;
    title: string;
    content?: string;
    url?: string;
    type?: "text" | "link" | "image";
  },
  apiKey?: string,
): Promise<MoltbookApiResult> {
  const body = {
    ...input,
    title: sanitizeBannedPhrases(input.title),
    content: input.content ? sanitizeBannedPhrases(input.content) : input.content,
  };

  if (!body.title && !body.content) {
    throw new MoltbookAgentError("Moltbook post is empty after banned phrase sanitization.", "EMPTY_AFTER_SANITIZE");
  }

  return moltbookRequest("/posts", {
    method: "POST",
    apiKey,
    body,
  });
}

export async function commentOnMoltbook(
  postId: string,
  content: string,
  options: { parent_id?: string; apiKey?: string } = {},
): Promise<MoltbookApiResult> {
  const cleaned = sanitizeBannedPhrases(content);
  if (!cleaned) {
    throw new MoltbookAgentError("Moltbook comment is empty after banned phrase sanitization.", "EMPTY_AFTER_SANITIZE");
  }

  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/comments`, {
    method: "POST",
    apiKey: options.apiKey,
    body: {
      content: cleaned,
      ...(options.parent_id ? { parent_id: options.parent_id } : {}),
    },
  });
}

export async function upvoteOnMoltbook(postId: string, apiKey?: string): Promise<MoltbookApiResult> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/upvote`, {
    method: "POST",
    apiKey,
  });
}

export async function followMoltbookUser(userId: string, apiKey?: string): Promise<MoltbookApiResult> {
  return moltbookRequest(`/users/${encodeURIComponent(userId)}/follow`, {
    method: "POST",
    apiKey,
  });
}

export async function verifyMoltbookChallenge(
  verificationCode: string,
  answer: string,
  apiKey?: string,
): Promise<MoltbookApiResult> {
  return moltbookRequest("/verify", {
    method: "POST",
    apiKey,
    body: {
      verification_code: verificationCode,
      answer,
    },
  });
}


export async function registerMoltbookAgent(input: {
  name: string;
  description: string;
  autoSaveApiKey?: boolean;
}): Promise<MoltbookRegisterResult> {
  const payload = await moltbookPublicRequest("/agents/register", {
    name: input.name,
    description: input.description,
  });

  const result = payload as MoltbookRegisterResult;
  const apiKey = result.agent?.api_key;
  if (input.autoSaveApiKey !== false && apiKey) {
    saveMoltbookApiKey(apiKey);
  }

  return result;
}
