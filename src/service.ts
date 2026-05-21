import { loadConfig } from "./config.ts";
import { discoverExplicitProjects, discoverProjects, filterProjects } from "./discovery.ts";
import { runScriptForProjects } from "./executor.ts";
import { applicableScripts, buildScriptEntries, expandScriptEntry, getScriptEntryById, loadScripts } from "./registry.ts";
import { createScheduledJob, deleteScheduledJob, loadScheduledJobs, upsertScheduledJob } from "./scheduled-jobs.ts";
import type { AppConfig, ExecutionResult, Project, RunOutputMode, ScheduledJob, ScriptDefinition, ScriptEntry } from "./models.ts";

export class DevtoolsService {
  readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  static fromPath(configPath?: string): DevtoolsService {
    return new DevtoolsService(loadConfig(configPath));
  }

  listProjects(options: {
    explicitPaths?: string[];
    projectType?: string;
    nameFilter?: string;
    refresh?: boolean;
  }): Project[] {
    const { explicitPaths, projectType, nameFilter, refresh = false } = options;
    const projects = explicitPaths?.length
      ? discoverExplicitProjects(this.config, explicitPaths)
      : discoverProjects(this.config, undefined, refresh);
    return filterProjects(projects, projectType, nameFilter);
  }

  refreshProjects(): Project[] {
    return discoverProjects(this.config, undefined, true);
  }

  listScripts(projects?: Project[]): ScriptEntry[] {
    const scripts = loadScripts(this.config);
    return buildScriptEntries(projects ? applicableScripts(scripts, projects) : scripts);
  }

  listScheduledJobs(): ScheduledJob[] {
    return loadScheduledJobs(this.config);
  }

  createScheduledJob(input: Omit<ScheduledJob, "jobId" | "createdAt" | "updatedAt">): ScheduledJob {
    const job = createScheduledJob(input);
    upsertScheduledJob(this.config, job);
    return job;
  }

  saveScheduledJob(job: ScheduledJob): ScheduledJob {
    upsertScheduledJob(this.config, job);
    return job;
  }

  deleteScheduledJob(jobId: string): ScheduledJob[] {
    return deleteScheduledJob(this.config, jobId);
  }

  async runScript(
    scriptId: string,
    projects: Project[],
    cliArgs: Record<string, unknown> = {},
    eventCallback?: (message: string) => void,
    signal?: AbortSignal,
    outputMode: RunOutputMode = "capture",
    scriptArgOverrides?: Record<string, Record<string, unknown>>,
  ): Promise<ExecutionResult[]> {
    const scripts = loadScripts(this.config);
    const entry = getScriptEntryById(scripts, scriptId);
    if (!entry) {
      throw new Error(`Unknown script id: ${scriptId}`);
    }
    const runnableScripts = expandScriptEntry(entry, scripts);
    const results: ExecutionResult[] = [];
    for (const script of runnableScripts) {
      eventCallback?.(`[script] ${script.scriptId}`);
      const effectiveArgs = { ...cliArgs, ...(scriptArgOverrides?.[script.scriptId] ?? {}) };
      results.push(...await runScriptForProjects(this.config, script, projects, effectiveArgs, eventCallback, signal, outputMode));
    }
    return results;
  }
}
