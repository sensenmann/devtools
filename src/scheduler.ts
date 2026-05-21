import type { DevtoolsService } from "./service.ts";
import type { ScheduledJob, ScheduledWeekday, ScriptDefinition } from "./models.ts";
import { loadScheduledJobs, saveScheduledJobs } from "./scheduled-jobs.ts";
import { saveSchedulerHeartbeat, saveSchedulerStopped } from "./scheduler-status.ts";
import { getScriptEntryById, isScriptGroup, loadScripts } from "./registry.ts";

export const POLL_INTERVAL_MS = 30_000;

export async function runSchedulerLoop(service: DevtoolsService): Promise<void> {
  const runningJobs = new Map<string, AbortController>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const controller of runningJobs.values()) {
      controller.abort();
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await tickScheduler(service, runningJobs);
    while (!stopped) {
      await delay(POLL_INTERVAL_MS);
      if (stopped) {
        break;
      }
      await tickScheduler(service, runningJobs);
    }
  } finally {
    saveSchedulerStopped(service.config, new Date().toISOString());
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function tickScheduler(service: DevtoolsService, runningJobs: Map<string, AbortController>): Promise<void> {
  const now = new Date();
  saveSchedulerHeartbeat(service.config, now.toISOString());
  const jobs = loadScheduledJobs(service.config);
  const scripts = loadScripts(service.config);

  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    const dueAt = getLatestDueTime(job.schedule, now);
    if (!dueAt) {
      continue;
    }
    const dueAtIso = dueAt.toISOString();
    if (job.lastTriggeredAt === dueAtIso) {
      continue;
    }
    if (runningJobs.has(job.jobId)) {
      updateJobRunMetadata(service, job, {
        lastTriggeredAt: dueAtIso,
        lastRunStatus: "skipped",
        lastRunSummary: `Skipped overlapping run at ${dueAtIso}.`,
      });
      continue;
    }
    const controller = new AbortController();
    runningJobs.set(job.jobId, controller);
    void runScheduledJob(service, scripts, job, dueAtIso, controller).finally(() => {
      runningJobs.delete(job.jobId);
    });
  }
}

export function getLatestDueTime(schedule: ScheduledJob["schedule"], now: Date): Date | null {
  if (schedule.kind === "hourly") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      0,
      0,
      0,
    );
  }

  const [hour, minute] = schedule.time.split(":").map((part) => Number(part));
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (schedule.kind === "daily") {
    const due = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0,
    );
    if (due.getTime() > now.getTime()) {
      due.setDate(due.getDate() - 1);
    }
    return due;
  }

  const targetWeekday = weekdayToIndex(schedule.weekday);
  const currentWeekday = getLocalWeekday(now);
  const dayDelta = (currentWeekday - targetWeekday + 7) % 7;
  const due = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - dayDelta,
    hour,
    minute,
    0,
    0,
  );
  if (due.getTime() > now.getTime()) {
    due.setDate(due.getDate() - 7);
  }
  return due;
}

export function getNextDueTime(schedule: ScheduledJob["schedule"], now: Date): Date | null {
  if (schedule.kind === "hourly") {
    const due = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours() + 1,
      0,
      0,
      0,
    );
    return due;
  }

  const [hour, minute] = schedule.time.split(":").map((part) => Number(part));
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (schedule.kind === "daily") {
    const due = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0,
    );
    if (due.getTime() <= now.getTime()) {
      due.setDate(due.getDate() + 1);
    }
    return due;
  }

  const targetWeekday = weekdayToIndex(schedule.weekday);
  const currentWeekday = getLocalWeekday(now);
  const dayDelta = (targetWeekday - currentWeekday + 7) % 7;
  const due = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayDelta,
    hour,
    minute,
    0,
    0,
  );
  if (due.getTime() <= now.getTime()) {
    due.setDate(due.getDate() + 7);
  }
  return due;
}

async function runScheduledJob(
  service: DevtoolsService,
  scripts: ScriptDefinition[],
  job: ScheduledJob,
  dueAtIso: string,
  controller: AbortController,
): Promise<void> {
  const projects = service.listProjects({
    explicitPaths: job.projectPaths,
    refresh: true,
  });
  if (projects.length === 0) {
    updateJobRunMetadata(service, job, {
      lastTriggeredAt: dueAtIso,
      lastRunStartedAt: new Date().toISOString(),
      lastRunFinishedAt: new Date().toISOString(),
      lastRunStatus: "failure",
      lastRunSummary: "No scheduled projects could be resolved.",
    });
    return;
  }

  const jobScriptArgOverrides = buildJobScriptArgOverrides(job, scripts);
  const startTime = new Date().toISOString();
  updateJobRunMetadata(service, job, {
    lastTriggeredAt: dueAtIso,
    lastRunStartedAt: startTime,
    lastRunStatus: "skipped",
    lastRunSummary: "Running...",
  });

  let failures = 0;
  for (const scriptId of job.selectedScriptIds) {
    const entry = getScriptEntryById(scripts, scriptId);
    if (!entry) {
      failures += 1;
      continue;
    }
    const label = isScriptGroup(entry) ? `[group] ${entry.name}` : entry.name;
    process.stdout.write(`[schedule] ${job.name} -> ${label}\n`);
    const results = await service.runScript(
      scriptId,
      projects,
      {},
      (message) => process.stdout.write(`${message}\n`),
      controller.signal,
      "passthrough",
      jobScriptArgOverrides,
    );
    failures += results.filter((result) => !result.success).length;
  }

  updateJobRunMetadata(service, job, {
    lastTriggeredAt: dueAtIso,
    lastRunStartedAt: startTime,
    lastRunFinishedAt: new Date().toISOString(),
    lastRunStatus: failures > 0 ? "failure" : "success",
    lastRunSummary: failures > 0 ? `Finished with ${failures} failure(s).` : "Finished successfully.",
  });
}

function buildJobScriptArgOverrides(job: ScheduledJob, scripts: ScriptDefinition[]): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const script of scripts) {
    if (!script.variant) {
      continue;
    }
    const selectedValue = job.selectedVariants[script.scriptId] ?? script.variant.defaultValue;
    overrides[script.scriptId] = {
      [script.variant.argKey]: script.variant.argValues[selectedValue],
    };
  }
  return overrides;
}

function updateJobRunMetadata(
  service: DevtoolsService,
  job: ScheduledJob,
  updates: Partial<Pick<ScheduledJob, "lastTriggeredAt" | "lastRunStartedAt" | "lastRunFinishedAt" | "lastRunStatus" | "lastRunSummary">>,
): void {
  const jobs = loadScheduledJobs(service.config);
  const nextJobs = jobs.map((currentJob) => currentJob.jobId === job.jobId
    ? { ...currentJob, ...updates, updatedAt: new Date().toISOString() }
    : currentJob);
  saveScheduledJobs(service.config, nextJobs);
}

function weekdayToIndex(weekday: ScheduledWeekday): number {
  return ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(weekday);
}

function getLocalWeekday(date: Date): number {
  const weekday = date.getDay();
  return weekday === 0 ? 6 : weekday - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
