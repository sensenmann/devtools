import { loadScriptConfig } from "../../src/script-runtime.ts";

interface RawCompareConfig {
  default_repo_baseurl?: string;
  repo_overrides?: string[];
  enable_dependency_updates?: boolean;
}

export interface RepoOverride {
  pattern: string;
  baseUrl: string;
}

export interface CompareConfig {
  defaultRepoBaseUrl: string;
  repoOverrides: RepoOverride[];
  enableDependencyUpdates: boolean;
}

const DEFAULT_REPO_BASEURL = "https://mvnrepository.com/artifact/";
const DEFAULT_REPO_OVERRIDES = ["at.gv.brz.*=https://mvnrepository.com/artifact/"];

export function loadCompareConfig(scriptDirectory: string): CompareConfig {
  const raw = loadScriptConfig<RawCompareConfig>(scriptDirectory);
  const defaultRepoBaseUrl = normalizeBaseUrl(String(raw.default_repo_baseurl || DEFAULT_REPO_BASEURL));
  const repoOverrides = parseRepoOverrides(Array.isArray(raw.repo_overrides) && raw.repo_overrides.length > 0
    ? raw.repo_overrides.map((value) => String(value))
    : DEFAULT_REPO_OVERRIDES);
  return {
    defaultRepoBaseUrl,
    repoOverrides,
    enableDependencyUpdates: raw.enable_dependency_updates !== false,
  };
}

function parseRepoOverrides(values: string[]): RepoOverride[] {
  return values.flatMap((entry) => {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      return [];
    }
    const pattern = entry.slice(0, separatorIndex).trim();
    const baseUrl = normalizeBaseUrl(entry.slice(separatorIndex + 1).trim());
    if (!pattern || !baseUrl) {
      return [];
    }
    return [{ pattern, baseUrl }];
  });
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
