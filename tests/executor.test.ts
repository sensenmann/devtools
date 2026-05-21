import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runScriptForProject } from "../src/executor.ts";
import type { AppConfig, Project, ScriptDefinition } from "../src/models.ts";

test("executor captures output from builtin scripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-"));
  const config: AppConfig = {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["python"],
      cacheFile: path.join(root, ".cache.json"),
    },
    scripts: {
      directory: path.join(root, "scripts"),
    },
  };
  const script: ScriptDefinition = {
    scriptId: "echo_project",
    name: "Echo Project",
    description: "",
    projectTypes: ["python"],
    entry: "echoProject",
    directory: root,
    manifestPath: path.join(root, "manifest.toml"),
    defaultArgs: { include_marker: true },
  };
  const project: Project = {
    name: "sample",
    path: root,
    projectType: "python",
    marker: "pyproject.toml",
    projectTypes: ["python"],
    identity: `sample:${root}`,
  };
  const result = await runScriptForProject(config, script, project);
  assert.equal(result.success, true);
  assert.equal(result.message, "Project info printed.");
  assert.match(result.output, /project=sample/);
});
