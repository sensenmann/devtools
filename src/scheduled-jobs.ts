import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig, ScheduledJob } from "./models.ts";

interface ScheduledJobsFileShape {
  jobs?: ScheduledJob[];
}

export function loadScheduledJobs(config: AppConfig): ScheduledJob[] {
  if (!fs.existsSync(config.tui.scheduledJobsFile)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(config.tui.scheduledJobsFile, "utf8")) as ScheduledJobsFileShape;
  return [...(raw.jobs ?? [])];
}

export function saveScheduledJobs(config: AppConfig, jobs: ScheduledJob[]): void {
  fs.mkdirSync(path.dirname(config.tui.scheduledJobsFile), { recursive: true });
  const payload: ScheduledJobsFileShape = {
    jobs: [...jobs],
  };
  fs.writeFileSync(config.tui.scheduledJobsFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function createScheduledJob(input: Omit<ScheduledJob, "jobId" | "createdAt" | "updatedAt">): ScheduledJob {
  const now = new Date().toISOString();
  return {
    ...input,
    jobId: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertScheduledJob(config: AppConfig, job: ScheduledJob): ScheduledJob[] {
  const jobs = loadScheduledJobs(config);
  const nextJob = {
    ...job,
    updatedAt: new Date().toISOString(),
  };
  const index = jobs.findIndex((item) => item.jobId === job.jobId);
  if (index === -1) {
    jobs.push(nextJob);
  } else {
    jobs[index] = nextJob;
  }
  saveScheduledJobs(config, jobs);
  return jobs;
}

export function deleteScheduledJob(config: AppConfig, jobId: string): ScheduledJob[] {
  const jobs = loadScheduledJobs(config).filter((job) => job.jobId !== jobId);
  saveScheduledJobs(config, jobs);
  return jobs;
}
