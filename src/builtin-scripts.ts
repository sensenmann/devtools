import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { BuiltinScriptResponse, ScriptContext } from "./models.ts";

const RUNTIME_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".angular", ".cache", ".next"]);

export function createRunId(): string {
  return randomUUID().replaceAll("-", "");
}

export function runNodeAuditFix(context: ScriptContext): BuiltinScriptResponse {
  const npmPath = resolveExecutable("npm");
  if (!npmPath) {
    return { success: false, message: "npm was not found on PATH." };
  }

  const projectRoot = path.resolve(context.project.path);
  const packageDirs = findProjectFileDirs(projectRoot, "package.json");
  if (packageDirs.length === 0) {
    return { success: false, message: "No package.json files found below the selected project." };
  }

  const registry = String(context.args.registry ?? "https://registry.npmjs.org");
  const force = Boolean(context.args.force ?? false);
  const command = [npmPath, "audit", "fix"];
  if (force) {
    command.push("--force");
  }
  command.push(`--registry=${registry}`);
  return runCommandAcrossDirs(projectRoot, packageDirs, command, "npm audit fix");
}

export function runMavenDependencyUpdate(context: ScriptContext): BuiltinScriptResponse {
  const mvnPath = resolveExecutable("mvn");
  if (!mvnPath) {
    return { success: false, message: "mvn was not found on PATH." };
  }

  const projectRoot = path.resolve(context.project.path);
  const pomDirs = findProjectFileDirs(projectRoot, "pom.xml");
  if (pomDirs.length === 0) {
    return { success: false, message: "No pom.xml files found below the selected project." };
  }

  const allowMajorUpdates = Boolean(context.args.allow_major_updates ?? false);
  const command = [mvnPath, "versions:use-latest-releases", "-DgenerateBackupPoms=false"];
  if (!allowMajorUpdates) {
    command.push("-DallowMajorUpdates=false");
  }
  command.push("-f", "pom.xml");
  return runCommandAcrossDirs(projectRoot, pomDirs, command, "maven dependency update");
}

export function runEchoProject(context: ScriptContext): BuiltinScriptResponse {
  process.stdout.write(`project=${context.project.name}\n`);
  process.stdout.write(`path=${context.project.path}\n`);
  process.stdout.write(`type=${context.project.projectType}\n`);
  if (Boolean(context.args.include_marker ?? true)) {
    process.stdout.write(`marker=${context.project.marker}\n`);
  }
  return { success: true, message: "Project info printed." };
}

export function runListDirectChildren(context: ScriptContext): BuiltinScriptResponse {
  const limit = Number(context.args.limit ?? 20);
  const children = fs.readdirSync(context.project.path).sort((a, b) => a.localeCompare(b));
  for (const child of children.slice(0, limit)) {
    process.stdout.write(`${child}\n`);
  }
  return { success: true, message: `Listed up to ${limit} entries.` };
}

export function findProjectFileDirs(projectRoot: string, filename: string): string[] {
  const discovered: string[] = [];
  walkProjectTree(projectRoot, (currentDir, filenames) => {
    if (filenames.includes(filename)) {
      discovered.push(path.resolve(currentDir));
    }
  });
  return discovered.sort((left, right) => left.localeCompare(right));
}

function runCommandAcrossDirs(
  projectRoot: string,
  targetDirs: string[],
  command: string[],
  successLabel: string,
): BuiltinScriptResponse {
  const failures: string[] = [];
  for (const targetDir of targetDirs) {
    const relativeDir = path.relative(projectRoot, targetDir);
    const label = relativeDir === "" ? "." : relativeDir.split(path.sep).join("/");
    process.stdout.write(`Running in ${label}: ${command.join(" ")}\n`);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: targetDir,
      encoding: "utf8",
      shell: false,
    });
    if (result.stdout?.trim()) {
      process.stdout.write(result.stdout.trimEnd() + "\n");
    }
    if (result.stderr?.trim()) {
      process.stderr.write(result.stderr.trimEnd() + "\n");
    }
    if (result.status !== 0) {
      failures.push(label);
      process.stdout.write(`Command failed in ${label} with exit code ${result.status ?? "unknown"}\n`);
    }
  }
  if (failures.length > 0) {
    return {
      success: false,
      message: `${successLabel} failed in ${failures.length} location(s): ${failures.join(", ")}`,
    };
  }
  return {
    success: true,
    message: `${successLabel} completed in ${targetDirs.length} location(s).`,
  };
}

function walkProjectTree(root: string, visitor: (currentDir: string, filenames: string[]) => void): void {
  const stack = [root];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const directories: string[] = [];
    const filenames: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!RUNTIME_SKIP_DIRS.has(entry.name)) {
          directories.push(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        filenames.push(entry.name);
      }
    }
    visitor(currentDir, filenames);
    directories.sort((a, b) => a.localeCompare(b)).reverse().forEach((directory) => stack.push(directory));
  }
}

function resolveExecutable(command: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
