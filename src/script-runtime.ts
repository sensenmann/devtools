import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { BuiltinScriptResponse } from "./models.ts";

const RUNTIME_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".angular", ".cache", ".next"]);

export function findProjectFileDirs(projectRoot: string, filename: string): string[] {
  const discovered: string[] = [];
  walkProjectTree(projectRoot, (currentDir, filenames) => {
    if (filenames.includes(filename)) {
      discovered.push(path.resolve(currentDir));
    }
  });
  return discovered.sort((left, right) => left.localeCompare(right));
}

export function resolveExecutable(command: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const part of pathValue.split(path.delimiter)) {
    const candidate = path.join(part, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function runCommandAcrossDirs(
  projectRoot: string,
  targetDirs: string[],
  command: string[],
  successLabel: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<BuiltinScriptResponse> {
  const failures: string[] = [];
  for (const targetDir of targetDirs) {
    if (signal?.aborted) {
      return {
        success: false,
        message: `${successLabel} cancelled.`,
      };
    }
    const relativeDir = path.relative(projectRoot, targetDir);
    const label = relativeDir === "" ? "." : relativeDir.split(path.sep).join("/");
    log?.(`[cmd] ${label} :: ${command.join(" ")}`);
    process.stdout.write(`Running in ${label}: ${command.join(" ")}\n`);
    const result = await spawnCommand(targetDir, command, signal, outputMode);
    if (result.stdout.trim()) {
      process.stdout.write(`${result.stdout.trimEnd()}\n`);
    }
    if (result.stderr.trim()) {
      process.stderr.write(`${result.stderr.trimEnd()}\n`);
    }
    if (result.cancelled) {
      return {
        success: false,
        message: `${successLabel} cancelled.`,
      };
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

function walkProjectTree(
  currentDir: string,
  visit: (directory: string, filenames: string[]) => void,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const filenames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  visit(currentDir, filenames);
  for (const entry of entries) {
    if (!entry.isDirectory() || RUNTIME_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    walkProjectTree(path.join(currentDir, entry.name), visit);
  }
}

async function spawnCommand(
  cwd: string,
  command: string[],
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<{ status: number | null; stdout: string; stderr: string; cancelled: boolean }> {
  return await new Promise((resolve, reject) => {
    const shouldCaptureOutput = outputMode === "capture";
    const child = spawn(command[0], command.slice(1), {
      cwd,
      shell: false,
      stdio: shouldCaptureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });

    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let settled = false;

    const finalize = (value: { status: number | null; stdout: string; stderr: string; cancelled: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      cancelled = true;
      try {
        child.kill("SIGINT");
      } catch {
        // Ignore kill races if the child already exited.
      }
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (shouldCaptureOutput) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
    }

    child.on("error", fail);
    child.on("close", (status) => {
      finalize({ status, stdout, stderr, cancelled });
    });
  });
}
