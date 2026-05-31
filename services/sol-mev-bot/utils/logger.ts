type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|cookie|private[-_]?key|secret|token|x-api-key)/i;

function resolveLogLevel(): LogLevel {
  const raw = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const activeLevel = resolveLogLevel();
const activeLevelWeight = LOG_LEVELS[activeLevel];

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= activeLevelWeight;
}

function sanitizeError(error: Error & Record<string, any>): Record<string, unknown> {
  const response = error.response;
  const config = error.config;

  return {
    name: error.name,
    message: error.message,
    code: typeof error.code === "string" ? error.code : undefined,
    status: typeof response?.status === "number" ? response.status : undefined,
    statusText: typeof response?.statusText === "string" ? response.statusText : undefined,
    method: typeof config?.method === "string" ? config.method.toUpperCase() : undefined,
    url: typeof config?.url === "string" ? config.url : undefined,
  };
}

function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return sanitizeError(value as Error & Record<string, any>);

  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 4) return "[Truncated]";

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
  }
  return sanitized;
}

function sanitizeArgs(args: any[]): unknown[] {
  return args.map((arg) => sanitizeValue(arg));
}

export const logger = {
  info: (message: string, ...args: any[]) => {
    if (!shouldLog("info")) return;
    console.log(`[INFO] ${message}`, ...sanitizeArgs(args));
  },
  error: (message: string, ...args: any[]) => {
    if (!shouldLog("error")) return;
    console.error(`[ERROR] ${message}`, ...sanitizeArgs(args));
  },
  warn: (message: string, ...args: any[]) => {
    if (!shouldLog("warn")) return;
    console.warn(`[WARN] ${message}`, ...sanitizeArgs(args));
  },
  debug: (message: string, ...args: any[]) => {
    if (!shouldLog("debug")) return;
    console.debug(`[DEBUG] ${message}`, ...sanitizeArgs(args));
  },
};
