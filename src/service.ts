import { loadConfig } from "./config.ts";
import { discoverExplicitProjects, discoverProjects, filterProjects } from "./discovery.ts";
import { runScriptForProjects } from "./executor.ts";
import { applicableScripts, buildScriptEntries, expandScriptEntry, getScriptEntryById, loadScripts } from "./registry.ts";
import type { AppConfig, ExecutionResult, Project, RunOutputMode, ScriptDefinition, ScriptEntry } from "./models.ts";

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
