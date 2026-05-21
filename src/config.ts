import fs from "node:fs";
import path from "node:path";

import type { AppConfig, ProjectType, TuiProjectSort } from "./models.ts";
import { normalizePath } from "./path-utils.ts";
import { parseSimpleToml } from "./toml.ts";

const DEFAULT_CONFIG_FILENAME = "devtools.toml";

interface RawConfig {
  discovery?: {
    roots?: string[];
    include_patterns?: string[];
    exclude_patterns?: string[];
    project_types?: ProjectType[];
    cache_file?: string;
  };
  scripts?: {
    directory?: string;
  };
  tui?: {
    width?: number;
    project_rows?: number;
    summary_rows?: number;
    project_sort?: TuiProjectSort;
    confirm_run?: boolean;
    scripts_percent?: number;
    projects_percent?: number;
    jobs_percent?: number;
    favorites_file?: string;
    script_state_file?: string;
    scheduled_jobs_file?: string;
  };
}

export function resolveConfigPath(configPath?: string, cwd: string = process.cwd()): string {
  if (configPath) {
    return normalizePath(configPath);
  }
  return path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
}

export function loadConfig(configPath?: string, cwd?: string): AppConfig {
  const resolved = resolveConfigPath(configPath, cwd);
  const rawText = fs.readFileSync(resolved, "utf8");
  const raw = parseSimpleToml(rawText) as RawConfig;
  const discoveryRaw = raw.discovery ?? {};
  const scriptsRaw = raw.scripts ?? {};
  const tuiRaw = raw.tui ?? {};

  const roots = (discoveryRaw.roots ?? ["~/Develop"]).map((item) => normalizePath(item));
  const cacheFile = path.isAbsolute(discoveryRaw.cache_file ?? "")
    ? normalizePath(discoveryRaw.cache_file ?? "")
    : path.resolve(path.dirname(resolved), discoveryRaw.cache_file ?? ".devtools-project-cache.json");
  const scriptsDirectory = path.isAbsolute(scriptsRaw.directory ?? "")
    ? normalizePath(scriptsRaw.directory ?? "")
    : path.resolve(path.dirname(resolved), scriptsRaw.directory ?? "scripts");
  const favoritesFile = path.isAbsolute(tuiRaw.favorites_file ?? "")
    ? normalizePath(tuiRaw.favorites_file ?? "")
    : path.resolve(path.dirname(resolved), tuiRaw.favorites_file ?? ".devtools-favorites.json");
  const scriptStateFile = path.isAbsolute(tuiRaw.script_state_file ?? "")
    ? normalizePath(tuiRaw.script_state_file ?? "")
    : path.resolve(path.dirname(resolved), tuiRaw.script_state_file ?? ".devtools-script-state.json");
  const scheduledJobsFile = path.isAbsolute(tuiRaw.scheduled_jobs_file ?? "")
    ? normalizePath(tuiRaw.scheduled_jobs_file ?? "")
    : path.resolve(path.dirname(resolved), tuiRaw.scheduled_jobs_file ?? ".devtools-scheduled-jobs.json");

  return {
    configPath: resolved,
    discovery: {
      roots,
      includePatterns: [...(discoveryRaw.include_patterns ?? [])],
      excludePatterns: [...(discoveryRaw.exclude_patterns ?? [])],
      projectTypes: [...(discoveryRaw.project_types ?? ["maven", "node", "python"])],
      cacheFile,
    },
    scripts: {
      directory: scriptsDirectory,
    },
    tui: {
      width: typeof tuiRaw.width === "number" && tuiRaw.width > 0 ? tuiRaw.width : undefined,
      projectRows: typeof tuiRaw.project_rows === "number" && tuiRaw.project_rows > 0 ? tuiRaw.project_rows : 18,
      summaryRows: typeof tuiRaw.summary_rows === "number" && tuiRaw.summary_rows > 0 ? tuiRaw.summary_rows : 6,
      projectSort: tuiRaw.project_sort === "modified" ? "modified" : "alphabetical",
      confirmRun: tuiRaw.confirm_run !== false,
      scriptsPercent: normalizePanePercent(tuiRaw.scripts_percent),
      projectsPercent: normalizePanePercent(tuiRaw.projects_percent),
      jobsPercent: normalizePanePercent(tuiRaw.jobs_percent),
      favoritesFile,
      scriptStateFile,
      scheduledJobsFile,
    },
  };
}

function normalizePanePercent(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}
