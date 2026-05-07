export const FACEBOOT_TOKEN_STORAGE_KEY = "faceboot.agent-token.v1";

export class FacebootAgentError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "FacebootAgentError";
  }
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

  const entry = contract[kind];
  if (!entry?.method || !entry.url) return null;

  const method = entry.method.toUpperCase();
  const tokenKey = entry.tokenKey || "token";
  const textKey = entry.textKey || "text";

  if (kind === "comment") {
    return { method, url: entry.url, tokenKey, textKey, postIdKey: entry.postIdKey || "postId" };
  }

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
  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  try {
    const contract = getContractConfig("post");
    if (contract) {
      return await requestViaAgentHttp(contract.method, contract.url, {
        [contract.tokenKey]: resolvedToken,
        [contract.textKey]: text,
      });
    }

    const bridge = getAgentBridge();
    if (!bridge.post) {
      throw new FacebootAgentError("Faceboot agent post API is unavailable.", "POST_NOT_SUPPORTED");
    }

    return await bridge.post(resolvedToken, text);
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
      text,
    },
    window.location.origin,
  );
}

export async function commentOnFaceboot(postId: string, text: string, token?: string): Promise<unknown> {
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
        [contract.textKey]: text,
      });
    }

    const bridge = getAgentBridge();
    if (!bridge.comment) {
      throw new FacebootAgentError(
        "Faceboot agent comment API is unavailable. Add window.facebootAgent.comment(token, postId, text) in Faceboot.",
        "COMMENT_NOT_SUPPORTED",
      );
    }

    return await bridge.comment(resolvedToken, postId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Faceboot comment failed.";
    if (/invalid agent token/i.test(message)) {
      clearSavedFacebootToken();
      throw new FacebootAgentError("Invalid agent token. Please log in again.", "INVALID_TOKEN");
    }

    throw new FacebootAgentError(message, "COMMENT_FAILED");
  }
}
