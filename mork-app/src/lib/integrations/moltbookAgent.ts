export const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
export const MOLTBOOK_API_KEY_STORAGE_KEY = "moltbook.api-key.v1";

export class MoltbookAgentError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = "MoltbookAgentError";
  }
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
  return moltbookRequest("/posts", {
    method: "POST",
    apiKey,
    body: input,
  });
}

export async function commentOnMoltbook(
  postId: string,
  content: string,
  options: { parent_id?: string; apiKey?: string } = {},
): Promise<MoltbookApiResult> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/comments`, {
    method: "POST",
    apiKey: options.apiKey,
    body: {
      content,
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
