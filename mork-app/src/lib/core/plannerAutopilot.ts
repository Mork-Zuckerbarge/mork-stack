import { POST as runPlannerTickRoute } from "@/app/planner/tick/route";
import { getAppControlState } from "@/lib/core/appControl";

type PlannerAutopilotState = {
  startedAt: number;
  intervalMs: number;
  timer: NodeJS.Timeout;
  running: boolean;
};

declare global {
  var __morkPlannerAutopilotState: PlannerAutopilotState | undefined;
}

function getIntervalMs() {
  const raw = Number(process.env.MORK_PLANNER_TICK_INTERVAL_MS ?? 120_000);
  if (!Number.isFinite(raw)) return 120_000;
  return Math.max(30_000, Math.floor(raw));
}

async function runTick(state: PlannerAutopilotState) {
  if (state.running) return;
  state.running = true;
  try {
    const app = await getAppControlState();
    const shouldRun =
      app.controls.startupCompleted &&
      app.arb.status === "running" &&
      app.controls.plannerEnabled &&
      app.controls.executionAuthority.mode === "agent_assisted";
    if (!shouldRun) return;
    await runPlannerTickRoute();
  } catch {
    // Keep scheduler alive even when a tick fails.
  } finally {
    state.running = false;
  }
}

export function ensurePlannerAutopilotStarted() {
  if (process.env.MORK_PLANNER_AUTORUN === "0") return;
  if (globalThis.__morkPlannerAutopilotState) return;

  const intervalMs = getIntervalMs();
  const state: PlannerAutopilotState = {
    startedAt: Date.now(),
    intervalMs,
    timer: setInterval(() => {
      void runTick(state);
    }, intervalMs),
    running: false,
  };

  globalThis.__morkPlannerAutopilotState = state;
  void runTick(state);
}
