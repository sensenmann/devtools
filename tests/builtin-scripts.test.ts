import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gitPull } from "../scripts/git_pull/script.ts";
import { gitPullDevelop } from "../scripts/git_pull_develop/script.ts";
import { mavenCleanInstall } from "../scripts/maven_clean_install/script.ts";
import { mavenDependencyUpdate } from "../scripts/maven_dependency_update/script.ts";
import { nodeDependencyUpdate } from "../scripts/node_dependency_update/script.ts";
import { findProjectFileDirs } from "../src/script-runtime.ts";
import type { Project, ScriptContext, ScriptDefinition } from "../src/models.ts";

const REPO_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("builtin scripts find nested package.json locations and skip node_modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-node-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "frontend"));
  fs.writeFileSync(path.join(root, "frontend", "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "node_modules", "bad"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "bad", "package.json"), "{}", "utf8");
  assert.deepEqual(findProjectFileDirs(root, "package.json").map((item) => path.relative(root, item) || "."), [".", "frontend"]);
});

test("builtin scripts build node audit fix commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-node-run-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "frontend"));
  fs.writeFileSync(path.join(root, "frontend", "package.json"), "{}", "utf8");
  const binDir = createFakeBin(root, "npm", (filePath) =>
    [
      "#!/bin/sh",
      `printf '%s\n' "$@" > "${filePath}"`,
      "printf 'ok\\n'",
      "exit 0",
    ].join("\n"),
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const logs: string[] = [];
  const result = await nodeDependencyUpdate(
    buildContext(
      root,
      "node",
      "nodeDependencyUpdate",
      {
        force: false,
        registry: "https://registry.npmjs.org",
      },
      "scripts/node_dependency_update",
      (message) => logs.push(message),
    ),
  );
  process.env.PATH = originalPath;
  assert.equal(result.success, true);
  assert.match(logs[0] ?? "", /\[cmd\] \. :: .*npm audit fix --registry=https:\/\/registry\.npmjs\.org/);
  assert.deepEqual(
    fs.readFileSync(path.join(binDir, "npm.args"), "utf8").trim().split(/\r?\n/),
    ["audit", "fix", "--registry=https://registry.npmjs.org"],
  );
});

test("builtin scripts build maven update commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-maven-run-"));
  fs.writeFileSync(path.join(root, "pom.xml"), "<project/>", "utf8");
  const binDir = createFakeBin(root, "mvn", (filePath) =>
    [
      "#!/bin/sh",
      `printf '%s\n' "$@" > "${filePath}"`,
      "exit 0",
    ].join("\n"),
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const result = await mavenDependencyUpdate(
    buildContext(
      root,
      "maven",
      "mavenDependencyUpdate",
      {
        allow_major_updates: false,
      },
      "scripts/maven_dependency_update",
    ),
  );
  process.env.PATH = originalPath;
  assert.equal(result.success, true);
  assert.deepEqual(
    fs.readFileSync(path.join(binDir, "mvn.args"), "utf8").trim().split(/\r?\n/),
    [
      "versions:use-latest-releases",
      "-DgenerateBackupPoms=false",
      "-DallowMajorUpdates=false",
      "-f",
      "pom.xml",
    ],
  );
});

test("builtin scripts build git pull command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-git-run-"));
  const binDir = createFakeBin(root, "git", (filePath) =>
    [
      "#!/bin/sh",
      `printf '%s\n' "$@" > "${filePath}"`,
      "exit 0",
    ].join("\n"),
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const result = await gitPull(buildContext(root, "node", "gitPull", {}, "scripts/git_pull"));
  process.env.PATH = originalPath;
  assert.equal(result.success, true);
  assert.deepEqual(
    fs.readFileSync(path.join(binDir, "git.args"), "utf8").trim().split(/\r?\n/),
    ["pull"],
  );
});

test("builtin scripts build maven clean install command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-maven-clean-install-"));
  fs.writeFileSync(path.join(root, "pom.xml"), "<project/>", "utf8");
  const binDir = createFakeBin(root, "mvn", (filePath) =>
    [
      "#!/bin/sh",
      `printf '%s\n' "$@" > "${filePath}"`,
      "exit 0",
    ].join("\n"),
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const result = await mavenCleanInstall(
    buildContext(root, "maven", "mavenCleanInstall", {}, "scripts/maven_clean_install"),
  );
  process.env.PATH = originalPath;
  assert.equal(result.success, true);
  assert.deepEqual(
    fs.readFileSync(path.join(binDir, "mvn.args"), "utf8").trim().split(/\r?\n/),
    ["clean", "install", "-f", "pom.xml"],
  );
});

test("builtin scripts build git pull develop command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-git-run-develop-"));
  const binDir = createFakeBin(root, "git", (filePath) =>
    [
      "#!/bin/sh",
      `printf '%s\n' "$@" > "${filePath}"`,
      "exit 0",
    ].join("\n"),
  );
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const result = await gitPullDevelop(
    buildContext(root, "node", "gitPullDevelop", {}, "scripts/git_pull_develop"),
  );
  process.env.PATH = originalPath;
  assert.equal(result.success, true);
  assert.deepEqual(
    fs.readFileSync(path.join(binDir, "git.args"), "utf8").trim().split(/\r?\n/),
    ["pull", "origin", "develop"],
  );
});

function buildContext(
  projectRoot: string,
  projectType: Project["projectType"],
  entry: string,
  defaultArgs: Record<string, unknown>,
  scriptDirectory: string,
  log?: (message: string) => void,
): ScriptContext {
  const project: Project = {
    name: path.basename(projectRoot),
    path: projectRoot,
    projectType,
    marker: projectType === "node" ? "package.json" : "pom.xml",
    projectTypes: [projectType],
    identity: `${path.basename(projectRoot)}:${projectRoot}`,
  };
  const script: ScriptDefinition = {
    scriptId: entry,
    name: entry,
    description: "",
    projectTypes: [projectType],
    entry,
    directory: path.join(REPO_ROOT, scriptDirectory),
    manifestPath: path.join(REPO_ROOT, scriptDirectory, "manifest.toml"),
    defaultArgs,
  };
  return {
    configPath: path.join(projectRoot, "devtools.toml"),
    script,
    project,
    args: { ...defaultArgs },
    runId: "test-run",
    log,
  };
}

function createFakeBin(root: string, command: string, scriptBuilder: (argsFile: string) => string): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, command);
  const argsFile = path.join(binDir, `${command}.args`);
  fs.writeFileSync(scriptPath, scriptBuilder(argsFile), { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}
