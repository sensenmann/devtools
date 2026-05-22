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
  const batchRunId = randomUUID().replaceAll("-", "");
  if (script.scope === "global") {
    eventCallback?.(`[start] ${script.scriptId} -> global`);
    const result = await runScriptForProject(config, script, undefined, cliArgs, eventCallback, signal, outputMode, {
      batchRunId,
      batchProjectIndex: 0,
      batchProjectCount: 0,
    });
    const prefix = result.success ? "ok" : "fail";
    const detail = result.message || result.error;
    eventCallback?.(`[${prefix}] global :: ${detail}`);
    return [result];
  }

  const results: ExecutionResult[] = [];
  for (const [projectIndex, project] of projects.entries()) {
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
    writeProjectBanner(project, outputMode);
    eventCallback?.(`[start] ${script.scriptId} -> ${project.path}`);
    const result = await runScriptForProject(config, script, project, cliArgs, eventCallback, signal, outputMode, {
      batchRunId,
      batchProjectIndex: projectIndex,
      batchProjectCount: projects.length,
    });
    results.push(result);
    const prefix = result.success ? "ok" : "fail";
    const detail = result.message || result.error;
    eventCallback?.(`[${prefix}] ${project.path} :: ${detail}`);
  }
  return results;
}

function writeProjectBanner(project: Project, outputMode: RunOutputMode): void {
  if (outputMode !== "passthrough") {
    return;
  }
  const separator = "-".repeat(Math.max(24, project.name.length + 16));
  process.stdout.write(
    [
      "",
      `\x1b[93m${separator}\x1b[0m`,
      `\x1b[30;103m----- ${project.name} -----\x1b[0m`,
      `\x1b[93m${separator}\x1b[0m`,
      "",
    ].join("\n"),
  );
}

export async function runScriptForProject(
  config: AppConfig,
  script: ScriptDefinition,
  project?: Project,
  cliArgs: Record<string, unknown> = {},
  eventCallback?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: RunOutputMode = "capture",
  batchMetadata?: {
    batchRunId: string;
    batchProjectIndex: number;
    batchProjectCount: number;
  },
): Promise<ExecutionResult> {
  const args = { ...script.defaultArgs, ...cliArgs };
  const context: ScriptContext = {
    configPath: config.configPath,
    script,
    project,
    args,
    runId: randomUUID().replaceAll("-", ""),
    batchRunId: batchMetadata?.batchRunId,
    batchProjectIndex: batchMetadata?.batchProjectIndex,
    batchProjectCount: batchMetadata?.batchProjectCount,
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
  if (script.scope === "global") {
    return true;
  }
  return script.projectTypes.some((projectType) => project.projectTypes.includes(projectType));
}
