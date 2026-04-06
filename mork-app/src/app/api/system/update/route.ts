import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, access, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";

const PRESERVED_FILES = [
  ".env",
  "mork-app/.env.local",
  "services/sherpa/encrypted_credentials.bin",
  "services/sherpa/encrypted_characters.bin",
  "services/sherpa/encrypted_feed_config.bin",
] as const;

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

function runGit(args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: GIT_ENV,
        timeout: 30000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : 1;
          reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: 0 });
      },
    );
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectGitState({ refreshRemote = true }: { refreshRemote?: boolean } = {}) {
  const topLevel = (await runGit(["rev-parse", "--show-toplevel"])).stdout;
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], topLevel)).stdout;

  if (refreshRemote) {
    await runGit(["fetch", "--all", "--prune"], topLevel);
  }

  let upstream = "";
  try {
    upstream = (await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], topLevel)).stdout;
  } catch {
    upstream = "";
  }

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    ahead = Number((await runGit(["rev-list", "--count", `${upstream}..HEAD`], topLevel)).stdout || "0");
    behind = Number((await runGit(["rev-list", "--count", `HEAD..${upstream}`], topLevel)).stdout || "0");
  }

  return {
    topLevel,
    branch,
    upstream,
    ahead,
    behind,
    hasUpdates: behind > 0,
  };
}

async function backupPreservedFiles(repoRoot: string, backupRoot: string) {
  const copied: string[] = [];
  for (const relativePath of PRESERVED_FILES) {
    const source = path.join(repoRoot, relativePath);
    if (!(await pathExists(source))) continue;
    const destination = path.join(backupRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: true, recursive: true });
    copied.push(relativePath);
  }
  return copied;
}

async function restorePreservedFiles(repoRoot: string, backupRoot: string, copied: string[]) {
  for (const relativePath of copied) {
    const source = path.join(backupRoot, relativePath);
    if (!(await pathExists(source))) continue;
    const destination = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: true, recursive: true });
  }
}

export async function GET() {
  try {
    const state = await detectGitState({ refreshRemote: false });
    return NextResponse.json({
      ok: true,
      update: {
        branch: state.branch,
        upstream: state.upstream || null,
        ahead: state.ahead,
        behind: state.behind,
        hasUpdates: state.hasUpdates,
        preservedFiles: PRESERVED_FILES,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "update check failed" },
      { status: 500 },
    );
  }
}

export async function POST() {
  let repoRoot = "";
  let backupRoot = "";
  let copiedFiles: string[] = [];

  try {
    const state = await detectGitState({ refreshRemote: true });
    repoRoot = state.topLevel;

    backupRoot = await mkdtemp(path.join(os.tmpdir(), "mork-update-"));
    copiedFiles = await backupPreservedFiles(repoRoot, backupRoot);

    const pullResult = await runGit(["pull", "--rebase", "--autostash"], repoRoot);
    await restorePreservedFiles(repoRoot, backupRoot, copiedFiles);

    const after = await detectGitState({ refreshRemote: false });
    return NextResponse.json({
      ok: true,
      message: after.behind > 0 ? "Update attempted (still behind upstream)." : "Repository updated.",
      pullOutput: pullResult.stdout || pullResult.stderr,
      update: {
        branch: after.branch,
        upstream: after.upstream || null,
        ahead: after.ahead,
        behind: after.behind,
        hasUpdates: after.hasUpdates,
      },
      preserved: copiedFiles,
    });
  } catch (error) {
    if (repoRoot && backupRoot && copiedFiles.length > 0) {
      await restorePreservedFiles(repoRoot, backupRoot, copiedFiles).catch(() => {});
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "update failed", preservedAttempted: copiedFiles },
      { status: 500 },
    );
  }
}
