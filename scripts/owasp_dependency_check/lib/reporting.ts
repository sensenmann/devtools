import fs from "node:fs";
import path from "node:path";

import type { BuiltinScriptResponse } from "../../../src/models.ts";
import { DEPENDENCY_TREE_FILENAME, REPORT_HTML_FILENAME, REPORT_JSON_FILENAME, LATEST_REPORT_DIRNAME } from "./constants.ts";
import { loadDependencyTrees } from "./dependency-tree.ts";
import { generateAggregatedHtml } from "../templates/aggregated-html.ts";
import type { DependencyCheckReport, DependencyReportEntry, DependencyVulnerability, ProjectFinding, ProjectSummary, ReportPaths } from "./types.ts";

export function buildProjectSummary(
  projectRoot: string,
  runResult: BuiltinScriptResponse,
): ProjectSummary {
  const jsonReportPath = path.join(projectRoot, "target", "dependency-check", REPORT_JSON_FILENAME);
  const htmlReportPath = path.join(projectRoot, "target", "dependency-check", REPORT_HTML_FILENAME);
  const dependencyTreePath = path.join(projectRoot, "target", "dependency-check", DEPENDENCY_TREE_FILENAME);
  const parsed = fs.existsSync(jsonReportPath)
    ? parseDependencyCheckJson(fs.readFileSync(jsonReportPath, "utf8"))
    : { findings: [], vulnerableDependencyCount: 0, vulnerabilityCount: 0 };
  const findings = loadDependencyTrees(dependencyTreePath, parsed.findings);
  return {
    projectName: path.basename(projectRoot),
    projectPath: projectRoot,
    htmlReportPath,
    jsonReportPath,
    dependencyTreePath,
    success: runResult.success,
    message: runResult.message,
    vulnerableDependencyCount: findings.length,
    vulnerabilityCount: parsed.vulnerabilityCount,
    findings,
  };
}

export function parseDependencyCheckJson(raw: string): {
  findings: ProjectFinding[];
  vulnerableDependencyCount: number;
  vulnerabilityCount: number;
} {
  const parsed = JSON.parse(raw) as DependencyCheckReport;
  const findingsByDependency = new Map<string, DependencyVulnerability[]>();
  const vulnerableDependencies = new Set<string>();
  let vulnerabilityCount = 0;

  for (const dependency of parsed.dependencies ?? []) {
    const dependencyLabel = deriveDependencyLabel(dependency);
    const vulnerabilities = dependency.vulnerabilities ?? [];
    if (vulnerabilities.length === 0) {
      continue;
    }
    vulnerabilityCount += vulnerabilities.length;
    vulnerableDependencies.add(dependencyLabel);
    const bucket = findingsByDependency.get(dependencyLabel) ?? [];
    for (const vulnerability of vulnerabilities) {
      const vulnerabilityId = String(vulnerability.name ?? "UNKNOWN");
      bucket.push({
        vulnerabilityId,
        vulnerabilityUrl: deriveVulnerabilityUrl(vulnerabilityId, vulnerability.url),
        severity: normalizeSeverity(String(vulnerability.severity ?? "UNKNOWN")),
      });
    }
    findingsByDependency.set(dependencyLabel, bucket);
  }

  const findings = [...findingsByDependency.entries()].map(([dependency, vulnerabilities]) => {
    const sortedVulnerabilities = [...vulnerabilities].sort(compareVulnerabilities);
    return {
      dependency,
      highestSeverity: sortedVulnerabilities[0]?.severity ?? "UNKNOWN",
      vulnerabilities: sortedVulnerabilities,
    };
  }).sort(compareFindings);

  return {
    findings,
    vulnerableDependencyCount: vulnerableDependencies.size,
    vulnerabilityCount,
  };
}

export function prepareReportPaths(reportDir: string): ReportPaths {
  const latestDir = path.join(reportDir, LATEST_REPORT_DIRNAME);
  return {
    latestDir,
    summariesDir: path.join(latestDir, "summaries"),
    indexPath: path.join(latestDir, "index.html"),
  };
}

export function writeProjectSummary(summariesDir: string, projectIdentity: string, summary: ProjectSummary): void {
  fs.mkdirSync(summariesDir, { recursive: true });
  const filePath = path.join(summariesDir, `${slugify(projectIdentity)}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function loadProjectSummaries(summariesDir: string): ProjectSummary[] {
  if (!fs.existsSync(summariesDir)) {
    return [];
  }
  return fs.readdirSync(summariesDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(summariesDir, entry), "utf8")) as ProjectSummary);
}

export function writeAggregatedIndex(paths: ReportPaths, summaries: ProjectSummary[]): void {
  fs.mkdirSync(paths.latestDir, { recursive: true });
  fs.writeFileSync(paths.indexPath, generateAggregatedHtml(summaries), "utf8");
}

export function resetLatestReportDirectory(latestDir: string): void {
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.mkdirSync(latestDir, { recursive: true });
}

function deriveDependencyLabel(entry: DependencyReportEntry): string {
  const packageId = entry.packages?.find((item) => item.id)?.id;
  return packageId || entry.packagePath || entry.fileName || entry.filePath || "unknown";
}

function compareFindings(left: ProjectFinding, right: ProjectFinding): number {
  const severityDiff = severityRank(left.highestSeverity) - severityRank(right.highestSeverity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  return left.dependency.localeCompare(right.dependency);
}

function compareVulnerabilities(left: DependencyVulnerability, right: DependencyVulnerability): number {
  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  return left.vulnerabilityId.localeCompare(right.vulnerabilityId);
}

function normalizeSeverity(value: string): string {
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "UNKNOWN";
}

function severityRank(value: string): number {
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"];
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function deriveVulnerabilityUrl(vulnerabilityId: string, explicitUrl?: string): string | undefined {
  const normalizedUrl = String(explicitUrl ?? "").trim();
  if (normalizedUrl.length > 0) {
    return normalizedUrl;
  }
  if (/^CVE-\d{4}-\d+$/i.test(vulnerabilityId)) {
    return `https://nvd.nist.gov/vuln/detail/${vulnerabilityId.toUpperCase()}`;
  }
  return undefined;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
