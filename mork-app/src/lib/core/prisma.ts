import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveDatabaseUrl() {
  const configuredUrl = process.env.DATABASE_URL;
  if (configuredUrl && !configuredUrl.startsWith("file:")) {
    return configuredUrl;
  }

  const appRootFromFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const appRootFromCwd = path.resolve(process.cwd());
  const appRoot = existsSync(path.join(appRootFromCwd, "prisma"))
    ? appRootFromCwd
    : appRootFromFile;
  const schemaDir = path.join(appRoot, "prisma");

  const configuredPath = configuredUrl?.slice("file:".length) ?? "./dev.db";
  if (path.isAbsolute(configuredPath)) {
    return `file:${configuredPath}`;
  }

  const absolutePath = path.resolve(schemaDir, configuredPath);
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
