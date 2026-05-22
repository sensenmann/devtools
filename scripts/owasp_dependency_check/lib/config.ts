import os from "node:os";
import path from "node:path";

import { normalizePath } from "../../../src/path-utils.ts";
import { loadScriptConfig } from "../../../src/script-runtime.ts";
import type { OwaspDependencyCheckConfig, RawOwaspDependencyCheckConfig } from "./types.ts";

export function loadOwaspDependencyCheckConfig(scriptDirectory: string): OwaspDependencyCheckConfig {
  const raw = loadScriptConfig<RawOwaspDependencyCheckConfig>(scriptDirectory);
  const dbUrl = requiredValue(raw.db_url, "db_url");
  return {
    dbUrl,
    cacheDir: resolveOptionalDirectory(scriptDirectory, raw.cache_dir, defaultOdcCacheDir()),
    reportDir: resolveOptionalDirectory(scriptDirectory, raw.report_dir, defaultOdcReportDir()),
    ignoreSsl: raw.ignore_ssl === true,
    openReport: raw.open_report !== false,
  };
}

export function defaultOdcCacheDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "devtools", "odc");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "devtools", "odc");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "devtools", "odc");
}

export function defaultOdcReportDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "devtools", "odc-reports");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "devtools", "odc-reports");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "devtools", "odc-reports");
}

function requiredValue(value: unknown, key: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`Missing required config value: ${key}`);
  }
  return normalized;
}

function resolveOptionalDirectory(scriptDirectory: string, configuredValue: unknown, fallback: string): string {
  const normalized = String(configuredValue ?? "").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith("~")) {
    return normalizePath(normalized);
  }
  return path.resolve(scriptDirectory, normalized);
}
