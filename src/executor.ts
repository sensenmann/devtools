import { randomUUID } from "node:crypto";

import { BUILTIN_SCRIPT_MODULES } from "./script-modules.ts";
import type { AppConfig, ExecutionResult, Project, ScriptContext, ScriptDefinition } from "./models.ts";

export async function runScriptForProjects(
  config: AppConfig,
  script: ScriptDefinition,
  projects: Project[],
  cliArgs: Record<string, unknown> = {},
  eventCallback?: (message: string) => void,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const project of projects) {
    eventCallback?.(`[start] ${script.scriptId} -> ${project.path}`);
    const result = await runScriptForProject(config, script, project, cliArgs);
    results.push(result);
    const prefix = result.success ? "ok" : "fail";
    const detail = result.message || result.error;
    eventCallback?.(`[${prefix}] ${project.path} :: ${detail}`);
  }
  return results;
}

export async function runScriptForProject(
  config: AppConfig,
  script: ScriptDefinition,
  project: Project,
  cliArgs: Record<string, unknown> = {},
): Promise<ExecutionResult> {
  const args = { ...script.defaultArgs, ...cliArgs };
  const context: ScriptContext = {
    configPath: config.configPath,
    script,
    project,
    args,
    runId: randomUUID().replaceAll("-", ""),
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const interceptStdout = (chunk: string | Uint8Array): boolean => {
    stdoutBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  const interceptStderr = (chunk: string | Uint8Array): boolean => {
    stderrBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };

  try {
    const runner = loadEntry(script);
    process.stdout.write = interceptStdout as typeof process.stdout.write;
    process.stderr.write = interceptStderr as typeof process.stderr.write;
    const response = await runner(context);
    return {
      project,
      script,
      success: Boolean(response.success),
      message: String(response.message ?? ""),
      output: stdoutBuffer,
      error: stderrBuffer,
    };
  } catch (error) {
    return {
      project,
      script,
      success: false,
      message: "",
      output: stdoutBuffer,
      error: `${stderrBuffer}${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function loadEntry(script: ScriptDefinition) {
  const runner = BUILTIN_SCRIPT_MODULES[script.entry];
  if (!runner) {
    throw new Error(`Unknown script entry for ${script.scriptId}: ${script.entry}`);
  }
  return runner;
}
