import { POST as runPlannerTickRoute } from "@/app/planner/tick/route";

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
  const raw = Number(process.env.MORK_PLANNER_TICK_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(raw)) return 60_000;
  return Math.max(15_000, Math.floor(raw));
}

async function runTick(state: PlannerAutopilotState) {
  if (state.running) return;
  state.running = true;
  try {
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
