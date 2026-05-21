import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AppConfig, ExecutionResult, Project, RunOutputMode, ScriptContext, ScriptDefinition } from "./models.ts";

export async function runScriptForProjects(
  config: AppConfig,
  script: ScriptDefinition,
  projects: Project[],
  cliArgs: Record<string, unknown> = {},
  eventCallback?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: RunOutputMode = "capture",
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const project of projects) {
    if (signal?.aborted) {
      eventCallback?.("[cancelled] Script execution interrupted.");
      break;
    }
    if (!supportsScript(script, project)) {
      const result: ExecutionResult = {
        project,
        script,
        success: true,
        message: `Skipped: ${script.scriptId} does not apply to [${project.projectTypes.join(",")}].`,
        output: "",
        error: "",
      };
      results.push(result);
      eventCallback?.(`[skip] ${project.path} :: ${result.message}`);
      continue;
    }
    eventCallback?.(`[start] ${script.scriptId} -> ${project.path}`);
    const result = await runScriptForProject(config, script, project, cliArgs, eventCallback, signal, outputMode);
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
  eventCallback?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: RunOutputMode = "capture",
): Promise<ExecutionResult> {
  const args = { ...script.defaultArgs, ...cliArgs };
  const context: ScriptContext = {
    configPath: config.configPath,
    script,
    project,
    args,
    runId: randomUUID().replaceAll("-", ""),
    log: eventCallback,
    signal,
    outputMode,
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const shouldCaptureOutput = outputMode === "capture";
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
    if (signal?.aborted) {
      return {
        project,
        script,
        success: false,
        message: "Execution cancelled before start.",
        output: "",
        error: "",
      };
    }
    const runner = await loadEntry(script);
    if (shouldCaptureOutput) {
      process.stdout.write = interceptStdout as typeof process.stdout.write;
      process.stderr.write = interceptStderr as typeof process.stderr.write;
    }
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
    if (shouldCaptureOutput) {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  }
}

async function loadEntry(script: ScriptDefinition) {
  const modulePath = path.join(script.directory, "script.ts");
  const scriptModule = await import(pathToFileURL(modulePath).href);
  const runner = scriptModule[script.entry];
  if (!runner) {
    throw new Error(`Unknown script entry for ${script.scriptId}: ${script.entry} in ${modulePath}`);
  }
  return runner;
}

function supportsScript(script: ScriptDefinition, project: Project): boolean {
  return script.projectTypes.some((projectType) => project.projectTypes.includes(projectType));
}
