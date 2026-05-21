import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "./models.ts";

interface SchedulerStatusFileShape {
  lastHeartbeatAt?: string;
  lastStoppedAt?: string;
}

export interface SchedulerStatus {
  lastHeartbeatAt?: string;
  lastStoppedAt?: string;
}

export function loadSchedulerStatus(config: AppConfig): SchedulerStatus {
  const statusPath = getSchedulerStatusPath(config);
  if (!fs.existsSync(statusPath)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(statusPath, "utf8")) as SchedulerStatusFileShape;
  return {
    lastHeartbeatAt: raw.lastHeartbeatAt,
    lastStoppedAt: raw.lastStoppedAt,
  };
}

export function saveSchedulerHeartbeat(config: AppConfig, heartbeatAt: string): void {
  writeSchedulerStatus(config, {
    lastHeartbeatAt: heartbeatAt,
  });
}

export function saveSchedulerStopped(config: AppConfig, stoppedAt: string): void {
  writeSchedulerStatus(config, {
    ...loadSchedulerStatus(config),
    lastStoppedAt: stoppedAt,
  });
}

export function getSchedulerStatusPath(config: AppConfig): string {
  const directory = path.dirname(config.tui.scheduledJobsFile);
  return path.join(directory, ".devtools-scheduler-status.json");
}

function writeSchedulerStatus(config: AppConfig, status: SchedulerStatusFileShape): void {
  const statusPath = getSchedulerStatusPath(config);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}
