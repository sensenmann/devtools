import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScriptForProject, runScriptForProjects } from "../src/executor.ts";
import type { AppConfig, Project, ScriptDefinition } from "../src/models.ts";

const REPO_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("executor captures output from builtin scripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-"));
  writeEchoProjectModule(root);
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
    tui: {
      favoritesFile: path.join(root, ".favorites.json"),
      scriptStateFile: path.join(root, ".script-state.json"),
      scheduledJobsFile: path.join(root, ".scheduled-jobs.json"),
      projectRows: 10,
      summaryRows: 6,
      projectSort: "alphabetical",
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

test("executor skips projects that do not support the selected script", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-skip-"));
  writeEchoProjectModule(root);
  const config: AppConfig = {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["node", "python"],
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
  const script: ScriptDefinition = {
    scriptId: "node_only",
    name: "Node Only",
    description: "",
    projectTypes: ["node"],
    entry: "echoProject",
    directory: root,
    manifestPath: path.join(root, "manifest.toml"),
    defaultArgs: {},
  };
  const projects: Project[] = [
    {
      name: "frontend",
      path: path.join(root, "frontend"),
      projectType: "node",
      marker: "package.json",
      projectTypes: ["node"],
      identity: `frontend:${root}`,
    },
    {
      name: "tooling",
      path: path.join(root, "tooling"),
      projectType: "python",
      marker: "pyproject.toml",
      projectTypes: ["python"],
      identity: `tooling:${root}`,
    },
  ];

  const results = await runScriptForProjects(config, script, projects);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.success, true);
  assert.equal(results[1]?.success, true);
  assert.match(results[1]?.message ?? "", /Skipped:/);
});

test("executor forwards command log events before builtin execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-command-log-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(npmPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(npmPath, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

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
  const script: ScriptDefinition = {
    scriptId: "node_only",
    name: "Node Only",
    description: "",
    projectTypes: ["node"],
    entry: "nodeDependencyUpdate",
    directory: path.join(REPO_ROOT, "scripts/node_dependency_update"),
    manifestPath: path.join(REPO_ROOT, "scripts/node_dependency_update/manifest.toml"),
    defaultArgs: {},
  };
  const project: Project = {
    name: "frontend",
    path: root,
    projectType: "node",
    marker: "package.json",
    projectTypes: ["node"],
    identity: `frontend:${root}`,
  };
  const events: string[] = [];

  await runScriptForProject(config, script, project, {}, (message) => events.push(message));
  process.env.PATH = originalPath;

  assert.ok(events.some((message) => /\[cmd\] \. :: .*npm audit fix --registry=https:\/\/registry\.npmjs\.org/.test(message)));
});

test("executor cancels running external commands via abort signal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-cancel-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(
    npmPath,
    [
      "#!/bin/sh",
      "trap 'echo interrupted; exit 130' INT",
      "echo started",
      "sleep 30",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  fs.chmodSync(npmPath, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

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
  const script: ScriptDefinition = {
    scriptId: "node_only",
    name: "Node Only",
    description: "",
    projectTypes: ["node"],
    entry: "nodeDependencyUpdate",
    directory: path.join(REPO_ROOT, "scripts/node_dependency_update"),
    manifestPath: path.join(REPO_ROOT, "scripts/node_dependency_update/manifest.toml"),
    defaultArgs: {},
  };
  const project: Project = {
    name: "frontend",
    path: root,
    projectType: "node",
    marker: "package.json",
    projectTypes: ["node"],
    identity: `frontend:${root}`,
  };

  const controller = new AbortController();
  const startedAt = Date.now();
  const promise = runScriptForProject(config, script, project, {}, undefined, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  process.env.PATH = originalPath;

  assert.equal(result.success, false);
  assert.match(result.message, /cancelled/i);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("executor runs global scripts once without project selection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-executor-global-"));
  fs.writeFileSync(
    path.join(root, "script.ts"),
    [
      "export function globalTask() {",
      "  process.stdout.write('global-run\\n');",
      "  return { success: true, message: 'Global task completed.' };",
      "}",
    ].join("\n"),
    "utf8",
  );
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
  const script: ScriptDefinition = {
    scriptId: "global_task",
    name: "Global Task",
    description: "",
    projectTypes: ["maven", "node", "python"],
    scope: "global",
    entry: "globalTask",
    directory: root,
    manifestPath: path.join(root, "manifest.toml"),
    defaultArgs: {},
  };

  const results = await runScriptForProjects(config, script, []);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.success, true);
  assert.equal(results[0]?.project, undefined);
  assert.match(results[0]?.output ?? "", /global-run/);
});

function writeEchoProjectModule(directory: string): void {
  fs.writeFileSync(
    path.join(directory, "script.ts"),
    [
      "export function echoProject(context) {",
      "  process.stdout.write(`project=${context.project.name}\\n`);",
      "  process.stdout.write(`path=${context.project.path}\\n`);",
      "  process.stdout.write(`type=${context.project.projectType}\\n`);",
      "  if (Boolean(context.args.include_marker ?? true)) {",
      "    process.stdout.write(`marker=${context.project.marker}\\n`);",
      "  }",
      "  return { success: true, message: 'Project info printed.' };",
      "}",
    ].join("\n"),
    "utf8",
  );
}
