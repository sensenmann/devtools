import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppConfig, Project, ScriptDefinition } from "../src/models.ts";
import { applicableScripts, loadScripts } from "../src/registry.ts";

function makeConfig(root: string): AppConfig {
  return {
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
  };
}

test("registry loads scripts and filters by project capability", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-registry-"));
  const scriptsDir = path.join(root, "scripts", "node-only");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "manifest.toml"),
    `
id = "node-only"
name = "Node Only"
description = "Node task"
project_types = ["node"]
entry = "nodeDependencyUpdate"
`.trim(),
    "utf8",
  );
  const scripts = loadScripts(makeConfig(root));
  const projects: Project[] = [{
    name: "demo",
    path: root,
    projectType: "node",
    marker: "package.json",
    projectTypes: ["node"],
    identity: `demo:${root}`,
  }];
  assert.equal(scripts.length, 1);
  assert.equal(applicableScripts(scripts, projects).length, 1);
});

test("registry accepts mixed-capability projects", () => {
  const projects: Project[] = [{
    name: "mixed",
    path: "/tmp/mixed",
    projectType: "maven",
    marker: "pom.xml",
    projectTypes: ["maven", "node"],
    identity: "mixed:/tmp/mixed",
  }];
  const scripts: ScriptDefinition[] = [
    {
      scriptId: "node",
      name: "node",
      description: "",
      projectTypes: ["node"],
      entry: "nodeDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
    {
      scriptId: "maven",
      name: "maven",
      description: "",
      projectTypes: ["maven"],
      entry: "mavenDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
    {
      scriptId: "python",
      name: "python",
      description: "",
      projectTypes: ["python"],
      entry: "echoProject",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
  ];
  assert.equal(applicableScripts(scripts, projects).length, 2);
});
