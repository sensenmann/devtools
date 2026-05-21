import { loadConfig } from "./config.ts";
import { discoverExplicitProjects, discoverProjects, filterProjects } from "./discovery.ts";
import { runScriptForProjects } from "./executor.ts";
import { getScriptById, loadScripts, applicableScripts } from "./registry.ts";
import type { AppConfig, ExecutionResult, Project, ScriptDefinition } from "./models.ts";

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

  listScripts(projects?: Project[]): ScriptDefinition[] {
    const scripts = loadScripts(this.config);
    return projects ? applicableScripts(scripts, projects) : scripts;
  }

  async runScript(
    scriptId: string,
    projects: Project[],
    cliArgs: Record<string, unknown> = {},
    eventCallback?: (message: string) => void,
  ): Promise<ExecutionResult[]> {
    const scripts = loadScripts(this.config);
    const script = getScriptById(scripts, scriptId);
    if (!script) {
      throw new Error(`Unknown script id: ${scriptId}`);
    }
    return runScriptForProjects(this.config, script, projects, cliArgs, eventCallback);
  }
}
