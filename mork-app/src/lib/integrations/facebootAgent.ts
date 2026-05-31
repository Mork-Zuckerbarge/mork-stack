export const FACEBOOT_TOKEN_STORAGE_KEY = "faceboot.agent-token.v1";

export class FacebootAgentError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "FacebootAgentError";
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

type FacebootAgentBridge = {
  login?: (email: string, password: string) => Promise<string>;
  post?: (token: string, text: string) => Promise<unknown>;
  comment?: (token: string, postId: string, text: string) => Promise<unknown>;
};

type FacebootAgentContract = {
  post?: {
    method?: string;
    url?: string;
    tokenKey?: string;
    textKey?: string;
  };
  comment?: {
    method?: string;
    url?: string;
    tokenKey?: string;
    postIdKey?: string;
    textKey?: string;
  };
};

type FacebootAgentHttp = {
  request?: (method: string, url: string, payload: Record<string, unknown>) => Promise<unknown>;
};

type FacebootWindow = Window & {
  facebootAgent?: FacebootAgentBridge;
  facebootAgentContract?: FacebootAgentContract;
  facebootAgentHttp?: FacebootAgentHttp;
};

function getAgentBridge(): FacebootAgentBridge {
  if (typeof window === "undefined") {
    throw new FacebootAgentError("Faceboot agent APIs are only available in the browser.", "NOT_IN_BROWSER");
  }

  const bridge = (window as FacebootWindow).facebootAgent;
  if (!bridge) {
    throw new FacebootAgentError("window.facebootAgent is not available.", "MISSING_AGENT_BRIDGE");
  }

  return bridge;
}

function getContractConfig(
  kind: "post" | "comment",
): { method: string; url: string; tokenKey: string; textKey: string; postIdKey?: string } | null {
  if (typeof window === "undefined") return null;
  const contract = (window as FacebootWindow).facebootAgentContract;
  if (!contract) return null;

  if (kind === "comment") {
    const entry = contract.comment;
    if (!entry?.method || !entry.url) return null;
    const method = entry.method.toUpperCase();
    const tokenKey = entry.tokenKey || "token";
    const textKey = entry.textKey || "text";
    return { method, url: entry.url, tokenKey, textKey, postIdKey: entry.postIdKey || "postId" };
  }

  const entry = contract.post;
  if (!entry?.method || !entry.url) return null;
  const method = entry.method.toUpperCase();
  const tokenKey = entry.tokenKey || "token";
  const textKey = entry.textKey || "text";
  return { method, url: entry.url, tokenKey, textKey };
}

async function requestViaAgentHttp(method: string, url: string, payload: Record<string, unknown>): Promise<unknown> {
  if (typeof window === "undefined") {
    throw new FacebootAgentError("Faceboot agent HTTP APIs are only available in the browser.", "NOT_IN_BROWSER");
  }

  const http = (window as FacebootWindow).facebootAgentHttp;
  if (!http?.request) {
    throw new FacebootAgentError("window.facebootAgentHttp.request is not available.", "MISSING_AGENT_HTTP");
  }

  return http.request(method, url, payload);
}

export function getSavedFacebootToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(FACEBOOT_TOKEN_STORAGE_KEY);
}

export function clearSavedFacebootToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(FACEBOOT_TOKEN_STORAGE_KEY);
}

export async function loginFacebootAgent(email: string, password: string): Promise<string> {
  const bridge = getAgentBridge();
  if (!bridge.login) {
    throw new FacebootAgentError("Faceboot agent login API is unavailable.", "LOGIN_NOT_SUPPORTED");
  }

  try {
    const token = await bridge.login(email, password);
    if (!token) {
      throw new FacebootAgentError("Faceboot login did not return a token.", "EMPTY_TOKEN");
    }

    window.localStorage.setItem(FACEBOOT_TOKEN_STORAGE_KEY, token);
    return token;
  } catch (error) {
    throw new FacebootAgentError(
      error instanceof Error ? error.message : "Faceboot login failed.",
      "LOGIN_FAILED",
    );
  }
}

export async function postToFaceboot(text: string, token?: string): Promise<unknown> {
  const cleaned = sanitizeBannedPhrases(text);
  if (!cleaned) {
    throw new FacebootAgentError("Faceboot post is empty after banned phrase sanitization.", "EMPTY_AFTER_SANITIZE");
  }
  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  try {
    const contract = getContractConfig("post");
    if (contract) {
      return await requestViaAgentHttp(contract.method, contract.url, {
        [contract.tokenKey]: resolvedToken,
        [contract.textKey]: cleaned,
      });
    }

    const bridge = getAgentBridge();
    if (!bridge.post) {
      throw new FacebootAgentError("Faceboot agent post API is unavailable.", "POST_NOT_SUPPORTED");
    }

    return await bridge.post(resolvedToken, cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Faceboot post failed.";
    if (/invalid agent token/i.test(message)) {
      clearSavedFacebootToken();
      throw new FacebootAgentError("Invalid agent token. Please log in again.", "INVALID_TOKEN");
    }

    throw new FacebootAgentError(message, "POST_FAILED");
  }
}

export function postToFacebootViaMessage(text: string, token?: string) {
  const cleaned = sanitizeBannedPhrases(text);
  if (!cleaned) {
    throw new FacebootAgentError("Faceboot post is empty after banned phrase sanitization.", "EMPTY_AFTER_SANITIZE");
  }
  if (typeof window === "undefined") {
    throw new FacebootAgentError("Faceboot postMessage publishing is only available in browser.", "NOT_IN_BROWSER");
  }

  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  window.postMessage(
    {
      type: "faceboot:post",
      token: resolvedToken,
      text: cleaned,
    },
    window.location.origin,
  );
}

export async function commentOnFaceboot(postId: string, text: string, token?: string): Promise<unknown> {
  const cleaned = sanitizeBannedPhrases(text);
  if (!cleaned) {
    throw new FacebootAgentError("Faceboot comment is empty after banned phrase sanitization.", "EMPTY_AFTER_SANITIZE");
  }
  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  try {
    const contract = getContractConfig("comment");
    if (contract && contract.postIdKey) {
      return await requestViaAgentHttp(contract.method, contract.url, {
        [contract.tokenKey]: resolvedToken,
        [contract.postIdKey]: postId,
        [contract.textKey]: cleaned,
      });
    }

    const bridge = getAgentBridge();
    if (!bridge.comment) {
      throw new FacebootAgentError(
        "Faceboot agent comment API is unavailable. Add window.facebootAgent.comment(token, postId, text) in Faceboot.",
        "COMMENT_NOT_SUPPORTED",
      );
    }

    return await bridge.comment(resolvedToken, postId, cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Faceboot comment failed.";
    if (/invalid agent token/i.test(message)) {
      clearSavedFacebootToken();
      throw new FacebootAgentError("Invalid agent token. Please log in again.", "INVALID_TOKEN");
    }

    throw new FacebootAgentError(message, "COMMENT_FAILED");
  }
}
