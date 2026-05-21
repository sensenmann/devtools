export const PROJECT_MARKERS = {
  maven: "pom.xml",
  node: "package.json",
  python: "pyproject.toml",
} as const;

export type ProjectType = keyof typeof PROJECT_MARKERS;

export interface DiscoveryConfig {
  roots: string[];
  includePatterns: string[];
  excludePatterns: string[];
  projectTypes: ProjectType[];
  cacheFile: string;
}

export interface ScriptsConfig {
  directory: string;
}

export interface AppConfig {
  configPath: string;
  discovery: DiscoveryConfig;
  scripts: ScriptsConfig;
}

export interface Project {
  name: string;
  path: string;
  projectType: ProjectType;
  marker: string;
  projectTypes: ProjectType[];
  identity: string;
}

export interface ScriptDefinition {
  scriptId: string;
  name: string;
  description: string;
  projectTypes: ProjectType[];
  entry: string;
  directory: string;
  manifestPath: string;
  defaultArgs: Record<string, unknown>;
}

export interface ScriptContext {
  configPath: string;
  script: ScriptDefinition;
  project: Project;
  args: Record<string, unknown>;
  runId: string;
}

export interface ExecutionResult {
  project: Project;
  script: ScriptDefinition;
  success: boolean;
  message: string;
  output: string;
  error: string;
}

export interface BuiltinScriptResponse {
  success: boolean;
  message: string;
}

export type BuiltinScriptRunner = (context: ScriptContext) => Promise<BuiltinScriptResponse> | BuiltinScriptResponse;

