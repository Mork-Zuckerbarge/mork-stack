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

type FacebootWindow = Window & {
  facebootAgent?: FacebootAgentBridge;
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
  const bridge = getAgentBridge();
  if (!bridge.post) {
    throw new FacebootAgentError("Faceboot agent post API is unavailable.", "POST_NOT_SUPPORTED");
  }

  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  try {
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
  const bridge = getAgentBridge();
  if (!bridge.comment) {
    throw new FacebootAgentError(
      "Faceboot agent comment API is unavailable. Add window.facebootAgent.comment(token, postId, text) in Faceboot.",
      "COMMENT_NOT_SUPPORTED",
    );
  }

  const resolvedToken = token ?? getSavedFacebootToken();
  if (!resolvedToken) {
    throw new FacebootAgentError("No active Faceboot account logged in.", "NO_TOKEN");
  }

  try {
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
