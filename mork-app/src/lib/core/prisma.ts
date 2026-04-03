import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findAppRootFrom(startDir: string) {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, "prisma", "schema.prisma"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveAppRoot() {
  const candidates = [
    process.env.MORK_APP_ROOT,
    process.env.INIT_CWD,
    process.env.npm_config_local_prefix,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const found = findAppRootFrom(candidate);
    if (found) {
      return found;
    }
  }

  return process.cwd();
}

function resolveDatabaseUrl() {
  const configuredUrl = process.env.DATABASE_URL;

  if (configuredUrl && !configuredUrl.startsWith("file:")) {
    return configuredUrl;
  }

  const appRoot = resolveAppRoot();
  const sqlitePath = configuredUrl?.slice("file:".length) ?? "./prisma/dev.db";
  const absolutePath = path.resolve(appRoot, sqlitePath);

  return `file:${absolutePath}`;
}

process.env.DATABASE_URL = resolveDatabaseUrl();

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
