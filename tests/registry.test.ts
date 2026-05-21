import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppConfig, Project, ScriptDefinition } from "../src/models.ts";
import { applicableScripts, buildScriptEntries, isScriptGroup, loadScripts } from "../src/registry.ts";

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

test("registry returns the union of scripts across selected projects", () => {
  const projects: Project[] = [
    {
      name: "fullstack",
      path: "/tmp/fullstack",
      projectType: "maven",
      marker: "pom.xml",
      projectTypes: ["maven", "node"],
      identity: "fullstack:/tmp/fullstack",
    },
    {
      name: "backend",
      path: "/tmp/backend",
      projectType: "maven",
      marker: "pom.xml",
      projectTypes: ["maven"],
      identity: "backend:/tmp/backend",
    },
  ];
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
  ];
  assert.deepEqual(applicableScripts(scripts, projects).map((script) => script.scriptId), ["node", "maven"]);
});

test("registry builds one-level executable groups before child scripts", () => {
  const scripts: ScriptDefinition[] = [
    {
      scriptId: "node",
      name: "Node Update",
      description: "",
      projectTypes: ["node"],
      entry: "nodeDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Dependency Update",
    },
    {
      scriptId: "maven",
      name: "Maven Update",
      description: "",
      projectTypes: ["maven"],
      entry: "mavenDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Dependency Update",
    },
    {
      scriptId: "git_pull",
      name: "Git Pull",
      description: "",
      projectTypes: ["node"],
      entry: "gitPull",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
  ];

  const entries = buildScriptEntries(scripts);
  assert.equal(entries.length, 4);
  assert.equal(entries[0]?.scriptId, "group_dependency_update");
  assert.equal(isScriptGroup(entries[0]!), true);
  assert.deepEqual(entries.slice(1).map((entry) => entry.scriptId), ["maven", "node", "git_pull"]);
});

test("registry keeps global scripts applicable without project matches", () => {
  const projects: Project[] = [{
    name: "backend",
    path: "/tmp/backend",
    projectType: "maven",
    marker: "pom.xml",
    projectTypes: ["maven"],
    identity: "backend:/tmp/backend",
  }];
  const scripts: ScriptDefinition[] = [
    {
      scriptId: "openshift",
      name: "OpenShift",
      description: "",
      projectTypes: ["maven", "node", "python"],
      scope: "global",
      entry: "openshiftOcLogin",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
    {
      scriptId: "node",
      name: "Node",
      description: "",
      projectTypes: ["node"],
      entry: "nodeDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
  ];

  assert.deepEqual(applicableScripts(scripts, projects).map((script) => script.scriptId), ["openshift"]);
});
