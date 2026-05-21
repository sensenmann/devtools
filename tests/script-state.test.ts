import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSelectedVariants, saveSelectedVariants } from "../src/script-state.ts";
import type { AppConfig } from "../src/models.ts";

test("script state persists selected variants", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-script-state-"));
  const config: AppConfig = {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["node"],
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

  saveSelectedVariants(config, { node_dependency_update: "force", maven_dependency_update: "major" });
  assert.deepEqual(loadSelectedVariants(config), {
    node_dependency_update: "force",
    maven_dependency_update: "major",
  });
});
