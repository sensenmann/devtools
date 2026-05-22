import type { BuiltinScriptResponse } from "../../../src/models.ts";

export interface OwaspDependencyCheckConfig {
  dbUrl: string;
  cacheDir: string;
  reportDir: string;
  ignoreSsl: boolean;
  openReport: boolean;
}

export interface RawOwaspDependencyCheckConfig {
  db_url?: string;
  cache_dir?: string;
  report_dir?: string;
  ignore_ssl?: boolean;
  open_report?: boolean;
}

export interface DatabaseMetadata {
  etag?: string;
  lastModified?: string;
  checkedAt?: string;
}

export interface DependencyCheckReport {
  dependencies?: DependencyReportEntry[];
}

export interface DependencyReportEntry {
  fileName?: string;
  filePath?: string;
  packagePath?: string;
  packages?: Array<{ id?: string; url?: string }>;
  vulnerabilities?: Array<{ name?: string; severity?: string; source?: string; url?: string }>;
}

export interface DependencyVulnerability {
  vulnerabilityId: string;
  vulnerabilityUrl?: string;
  severity: string;
}

export interface ProjectFinding {
  dependency: string;
  highestSeverity: string;
  vulnerabilities: DependencyVulnerability[];
  dependencyTrees?: string[];
}

export interface ProjectSummary {
  projectName: string;
  projectPath: string;
  htmlReportPath: string;
  jsonReportPath: string;
  dependencyTreePath: string;
  success: boolean;
  message: string;
  vulnerableDependencyCount: number;
  vulnerabilityCount: number;
  findings: ProjectFinding[];
}

export interface ReportPaths {
  latestDir: string;
  summariesDir: string;
  indexPath: string;
}

export interface DatabaseAvailabilityContext {
  batchProjectIndex?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface DependencyTreeNode {
  display: string;
  ga: string;
  version?: string;
  children: DependencyTreeNode[];
}

export interface DatabaseAvailabilityResult extends BuiltinScriptResponse {}
