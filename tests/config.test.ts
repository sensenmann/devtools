import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.ts";

test("config resolves relative script and cache paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-config-"));
  const configPath = path.join(root, "devtools.toml");
  fs.writeFileSync(
    configPath,
    `
[discovery]
roots = ["~/Develop", "./projects"]
project_types = ["maven", "node"]

[scripts]
directory = "scripts"

[tui]
width = 120
project_rows = 22
summary_rows = 8
project_sort = "modified"
confirm_run = false
scripts_percent = 50
projects_percent = 30
jobs_percent = 20
favorites_file = ".favorites.json"
script_state_file = ".script-state.json"
scheduled_jobs_file = ".scheduled-jobs.json"
`.trim(),
    "utf8",
  );

  const config = loadConfig(configPath);
  assert.equal(config.scripts.directory, path.resolve(root, "scripts"));
  assert.equal(config.discovery.cacheFile, path.resolve(root, ".devtools-project-cache.json"));
  assert.deepEqual(config.discovery.projectTypes, ["maven", "node"]);
  assert.equal(config.tui.width, 120);
  assert.equal(config.tui.projectRows, 22);
  assert.equal(config.tui.summaryRows, 8);
  assert.equal(config.tui.projectSort, "modified");
  assert.equal(config.tui.confirmRun, false);
  assert.equal(config.tui.scriptsPercent, 50);
  assert.equal(config.tui.projectsPercent, 30);
  assert.equal(config.tui.jobsPercent, 20);
  assert.equal(config.tui.favoritesFile, path.resolve(root, ".favorites.json"));
  assert.equal(config.tui.scriptStateFile, path.resolve(root, ".script-state.json"));
  assert.equal(config.tui.scheduledJobsFile, path.resolve(root, ".scheduled-jobs.json"));
});
