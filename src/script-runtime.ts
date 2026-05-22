import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import type { BuiltinScriptResponse } from "./models.ts";
import { parseSimpleToml } from "./toml.ts";

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

export async function runSingleCommand(
  cwd: string,
  command: string[],
  successLabel: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  quiet = false,
): Promise<BuiltinScriptResponse> {
  if (signal?.aborted) {
    return {
      success: false,
      message: `${successLabel} cancelled.`,
    };
  }
  log?.(`[cmd] global :: ${command.join(" ")}`);
  if (!quiet) {
    process.stdout.write(`Running: ${command.join(" ")}\n`);
  }
  const result = await spawnCommand(cwd, command, signal, outputMode);
  if (!quiet && result.stdout.trim()) {
    process.stdout.write(`${result.stdout.trimEnd()}\n`);
  }
  if (!quiet && result.stderr.trim()) {
    process.stderr.write(`${result.stderr.trimEnd()}\n`);
  }
  if (result.cancelled) {
    return {
      success: false,
      message: `${successLabel} cancelled.`,
    };
  }
  if (result.status !== 0) {
    return {
      success: false,
      message: `${successLabel} failed with exit code ${result.status ?? "unknown"}.`,
    };
  }
  return {
    success: true,
    message: `${successLabel} completed.`,
  };
}

export async function runShellCommand(
  cwd: string,
  command: string,
  successLabel: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<BuiltinScriptResponse> {
  if (signal?.aborted) {
    return {
      success: false,
      message: `${successLabel} cancelled.`,
    };
  }
  log?.(`[cmd] global :: ${command}`);
  process.stdout.write(`Running: ${command}\n`);
  const result = await spawnCommand(cwd, [command], signal, outputMode, true);
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
    return {
      success: false,
      message: `${successLabel} failed with exit code ${result.status ?? "unknown"}.`,
    };
  }
  return {
    success: true,
    message: `${successLabel} completed.`,
  };
}

export function loadScriptConfig<T extends Record<string, unknown>>(scriptDirectory: string, filename = "config.toml"): T {
  const configPath = path.join(scriptDirectory, filename);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing script config: ${configPath}`);
  }
  return parseSimpleToml(fs.readFileSync(configPath, "utf8")) as T;
}

export async function promptLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive prompt requires an interactive TTY.");
  }

  return await new Promise<string>((resolve, reject) => {
    const restoreRawMode = process.stdin.isRaw;
    const output = createTtyOutput();
    const rl = readline.createInterface({
      input: process.stdin,
      output: output.stream,
      terminal: true,
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    rl.question(prompt, (answer) => {
      rl.close();
      output.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(restoreRawMode);
      }
      resolve(answer.trim());
    });

    rl.on("error", (error) => {
      rl.close();
      output.close();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(restoreRawMode);
      }
      reject(error);
    });
  });
}

export async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password prompt requires an interactive TTY.");
  }

  return await new Promise<string>((resolve, reject) => {
    const restoreRawMode = process.stdin.isRaw;
    const output = createTtyOutput();

    const cleanup = () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(restoreRawMode);
      }
      output.close();
    };

    let value = "";
    output.write(prompt);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new Error("Password prompt cancelled."));
        return;
      }
      if (text === "\r" || text === "\n") {
        output.write("\n");
        cleanup();
        resolve(value);
        return;
      }
      if (text === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += text;
    };

    process.stdin.on("data", onData);
  });
}

function createTtyOutput(): { stream: NodeJS.WritableStream; write: (value: string) => void; close: () => void } {
  try {
    const stream = fs.createWriteStream("/dev/tty");
    return {
      stream,
      write: (value: string) => {
        stream.write(value);
      },
      close: () => {
        stream.end();
      },
    };
  } catch {
    return {
      stream: process.stdout,
      write: (value: string) => {
        process.stdout.write(value);
      },
      close: () => {},
    };
  }
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
  useShell = false,
): Promise<{ status: number | null; stdout: string; stderr: string; cancelled: boolean }> {
  return await new Promise((resolve, reject) => {
    const shouldCaptureOutput = outputMode === "capture";
    const child = spawn(command[0], useShell ? [] : command.slice(1), {
      cwd,
      shell: useShell,
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
