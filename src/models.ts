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

export interface TuiConfig {
  width?: number;
  projectRows: number;
  summaryRows: number;
  projectSort: TuiProjectSort;
  favoritesFile: string;
  scriptStateFile: string;
}

export type TuiProjectSort = "alphabetical" | "modified";

export interface AppConfig {
  configPath: string;
  discovery: DiscoveryConfig;
  scripts: ScriptsConfig;
  tui: TuiConfig;
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
  group?: string;
  variant?: ScriptVariantDefinition;
}

export interface ScriptGroupDefinition {
  scriptId: string;
  name: string;
  description: string;
  projectTypes: ProjectType[];
  childScriptIds: string[];
  kind: "group";
}

export type ScriptEntry = ScriptDefinition | ScriptGroupDefinition;

export interface ScriptVariantDefinition {
  argKey: string;
  values: string[];
  defaultValue: string;
  argValues: Record<string, unknown>;
}

export interface ScriptContext {
  configPath: string;
  script: ScriptDefinition;
  project: Project;
  args: Record<string, unknown>;
  runId: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
  outputMode?: RunOutputMode;
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

export type RunOutputMode = "capture" | "passthrough";

export type BuiltinScriptRunner = (context: ScriptContext) => Promise<BuiltinScriptResponse> | BuiltinScriptResponse;
