type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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

export const logger = {
  info: (message: string, ...args: any[]) => {
    if (!shouldLog("info")) return;
    console.log(`[INFO] ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    if (!shouldLog("error")) return;
    console.error(`[ERROR] ${message}`, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    if (!shouldLog("warn")) return;
    console.warn(`[WARN] ${message}`, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (!shouldLog("debug")) return;
    console.debug(`[DEBUG] ${message}`, ...args);
  },
};
