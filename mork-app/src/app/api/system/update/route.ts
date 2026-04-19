import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

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

async function launchUpdateScript(repoRoot: string) {
  const logsDir = path.join(repoRoot, ".logs");
  const updateLogPath = path.join(logsDir, "update.log");
  await mkdir(logsDir, { recursive: true });

  return new Promise<{ pid: number; logPath: string }>((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", `nohup ./update.sh >> "${updateLogPath}" 2>&1 & echo $!`],
      {
        cwd: repoRoot,
        env: process.env,
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`failed to launch ./update.sh: ${stderr || stdout}`));
          return;
        }
        const pid = Number(stdout.trim());
        if (!Number.isFinite(pid) || pid <= 0) {
          reject(new Error(`failed to launch ./update.sh: invalid pid (${stdout.trim() || "none"})`));
          return;
        }
        resolve({ pid, logPath: updateLogPath });
      },
    );
  });
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
  try {
    const state = await detectGitState({ refreshRemote: true });
    const launched = await launchUpdateScript(state.topLevel);
    return NextResponse.json({
      ok: true,
      message: "Update started via ./update.sh",
      started: true,
      pid: launched.pid,
      logPath: launched.logPath,
      update: {
        branch: state.branch,
        upstream: state.upstream || null,
        ahead: state.ahead,
        behind: state.behind,
        hasUpdates: state.hasUpdates,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "update failed" },
      { status: 500 },
    );
  }
}
