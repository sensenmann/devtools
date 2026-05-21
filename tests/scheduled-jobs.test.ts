import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createScheduledJob, deleteScheduledJob, loadScheduledJobs, upsertScheduledJob } from "../src/scheduled-jobs.ts";
import type { AppConfig, ScheduledJob } from "../src/models.ts";

function makeConfig(root: string): AppConfig {
  return {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["maven", "node", "python"],
      cacheFile: path.join(root, ".cache.json"),
    },
    scripts: {
      directory: path.join(root, "scripts"),
    },
    tui: {
      favoritesFile: path.join(root, ".favorites.json"),
      scriptStateFile: path.join(root, ".script-state.json"),
      scheduledJobsFile: path.join(root, ".scheduled-jobs.json"),
      projectRows: 10,
      summaryRows: 6,
      projectSort: "alphabetical",
    },
  };
}

test("scheduled jobs persist create, update and delete operations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-scheduled-jobs-"));
  const config = makeConfig(root);
  const created = createScheduledJob({
    name: "Dependency Update",
    enabled: true,
    projectPaths: [path.join(root, "project-a")],
    selectedScriptIds: ["dependency_update"],
    selectedVariants: { dependency_update: "major" },
    schedule: { kind: "daily", time: "08:15" },
  });

  upsertScheduledJob(config, created);
  let jobs = loadScheduledJobs(config);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.name, "Dependency Update");
  assert.equal(jobs[0]?.schedule.kind, "daily");

  const updated: ScheduledJob = {
    ...jobs[0]!,
    enabled: false,
    selectedScriptIds: ["dependency_update", "git_pull"],
    schedule: { kind: "weekly", weekday: "friday", time: "17:30" },
  };
  upsertScheduledJob(config, updated);

  jobs = loadScheduledJobs(config);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.enabled, false);
  assert.deepEqual(jobs[0]?.selectedScriptIds, ["dependency_update", "git_pull"]);
  assert.deepEqual(jobs[0]?.schedule, { kind: "weekly", weekday: "friday", time: "17:30" });

  deleteScheduledJob(config, updated.jobId);
  assert.deepEqual(loadScheduledJobs(config), []);
});
