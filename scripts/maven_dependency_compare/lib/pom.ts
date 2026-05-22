import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSingleCommand } from "../../../src/script-runtime.ts";
import type { Project } from "../../../src/models.ts";
import { compareVersions, maxVersion } from "./version.ts";
import { childElements, cloneElement, ensureChild, firstChild, localName, parseXmlDocument, removeChild, serializeXmlDocument, setTextContent, textContent, walkElements, type XmlElementNode } from "./xml.ts";
import { ROW_KIND_LABELS, ROW_KIND_ORDER } from "./constants.ts";

const SCRIPT_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIRECTORY = path.join(SCRIPT_DIRECTORY, ".cache");
const EFFECTIVE_POM_CACHE_DIRECTORY = path.join(CACHE_DIRECTORY, "effective-pom");
const VERSIONS_REPORT_CACHE_DIRECTORY = path.join(CACHE_DIRECTORY, "versions-report");

export type CompareRowKind = "parent" | "override" | "direct" | "managed";

export interface OverrideTarget {
  rowId: string;
  kind: Exclude<CompareRowKind, "override" | "parent">;
  groupId: string;
  artifactId: string;
  dependencyLabel: string;
  providerVersion?: string;
}

export interface PomDependencyRow {
  rowId: string;
  kind: CompareRowKind;
  groupId: string;
  artifactId: string;
  dependencyLabel: string;
  rawVersion?: string;
  effectiveVersion?: string;
  propertyName?: string;
  propertyValue?: string;
  providerVersion?: string;
  availableUpdateVersion?: string;
  hasLocalPropertyOverride: boolean;
  isUnusedOverride?: boolean;
  overrideTargets?: OverrideTarget[];
}

export interface ProjectPomAnalysis {
  project: Project;
  pomPath: string;
  rows: Map<string, PomDependencyRow>;
}

export interface ReportCell extends PomDependencyRow {
  projectPath: string;
  projectName: string;
  present: boolean;
  displayVersion?: string;
  isMissingOverrideWarning: boolean;
  isUnusedOverride: boolean;
  isHighest: boolean;
  isOutdated: boolean;
  isPinnedBelowProvider: boolean;
  hasDifferentProviderVersion: boolean;
  showAvailableUpdateVersion: boolean;
  removeOverrideAvailable: boolean;
  adoptHighestAvailable: boolean;
}

export interface ReportRow {
  rowId: string;
  kind: CompareRowKind;
  label: string;
  highestVersion?: string;
  availableUpdateVersion?: string;
  cells: ReportCell[];
}

export interface CompareReport {
  generatedAt: string;
  projects: Array<{ name: string; path: string }>;
  enableDependencyUpdates?: boolean;
  repoDefaultBaseUrl?: string;
  repoOverrides?: Array<{ pattern: string; baseUrl: string }>;
  rows: ReportRow[];
}

interface RawPomModel {
  root: XmlElementNode;
  projectName: string;
  groupId?: string;
  artifactId?: string;
  localProperties: Map<string, string>;
  rows: Map<string, PomDependencyRow>;
}

interface PropertyProbeResult {
  targets: OverrideTarget[];
  propertyProviderValue?: string;
  forceRow?: boolean;
}

interface ProbeProgress {
  stage?: "property" | "update";
  projectName: string;
  projectIndex: number;
  projectCount: number;
  propertyName: string;
  propertyIndex: number;
  propertyCount: number;
}

interface DependencyUpdateEntry {
  kind: "direct" | "managed";
  groupId: string;
  artifactId: string;
  availableVersion: string;
}

function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

function ensureCacheDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function buildEffectivePomCachePath(contentHash: string, projectCoordinates?: { groupId?: string; artifactId?: string }): string {
  const coordinatePart = [
    projectCoordinates?.groupId ?? "nogroup",
    projectCoordinates?.artifactId ?? "noartifact",
  ]
    .map((value) => value.replace(/[^A-Za-z0-9._-]+/g, "_"))
    .join("__");
  return path.join(EFFECTIVE_POM_CACHE_DIRECTORY, `${contentHash}__${coordinatePart}.xml`);
}

function buildVersionsReportCachePath(contentHash: string, goal: string, extraArgs: string[]): string {
  const argsHash = hashContent(`${goal}\n${extraArgs.join("\n")}`).slice(0, 16);
  const goalPart = goal.replace(/[^A-Za-z0-9._:-]+/g, "_");
  return path.join(VERSIONS_REPORT_CACHE_DIRECTORY, `${contentHash}__${goalPart}__${argsHash}.txt`);
}

export async function analyzeProjects(
  projects: Project[],
  mvnPath: string,
  mode: "fast" | "deep" = "deep",
  includeDependencyUpdates = true,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  onProbeProgress?: (progress: ProbeProgress) => void,
): Promise<ProjectPomAnalysis[]> {
  const analyses: ProjectPomAnalysis[] = [];
  for (const [projectIndex, project] of projects.entries()) {
    analyses.push(await analyzeProject(project, mvnPath, mode, includeDependencyUpdates, log, signal, outputMode, {
      projectIndex,
      projectCount: projects.length,
      onProbeProgress,
    }));
  }
  return analyses;
}

export function buildCompareReport(analyses: ProjectPomAnalysis[]): CompareReport {
  const rowIds = [...new Set(analyses.flatMap((analysis) => [...analysis.rows.keys()]))].sort((left, right) => left.localeCompare(right));
  const rows = rowIds.map((rowId) => {
    const rowStates = analyses.map((analysis) => analysis.rows.get(rowId));
    const highestVersion = maxVersion(
      rowStates
        .map((row) => normalizeResolvedVersion(row?.effectiveVersion, row?.propertyValue))
        .filter((value): value is string => Boolean(value)),
    );
    const availableUpdateVersion = maxVersion(
      rowStates
        .map((row) => row?.availableUpdateVersion)
        .filter((value): value is string => Boolean(value)),
    );
    const showAvailableUpdateVersion = Boolean(
      availableUpdateVersion &&
      (!highestVersion || compareVersions(availableUpdateVersion, highestVersion) > 0)
    ) ? availableUpdateVersion : undefined;
    const template = rowStates.find(Boolean);
    const cells = analyses.map((analysis) => {
      const row = analysis.rows.get(rowId);
      const effectiveVersion = normalizeResolvedVersion(row?.effectiveVersion, row?.propertyValue);
      const providerVersion = row?.providerVersion;
      const isMissingOverrideWarning = !row && template?.kind === "override";
      const isUnusedOverride = Boolean(row?.isUnusedOverride);
      const isHighest = Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) === 0);
      const isOutdated = Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) < 0);
      const isPinnedBelowProvider = Boolean(
        row?.hasLocalPropertyOverride &&
        effectiveVersion &&
        providerVersion &&
        compareVersions(providerVersion, effectiveVersion) > 0,
      );
      const hasDifferentProviderVersion = Boolean(
        row?.hasLocalPropertyOverride &&
        effectiveVersion &&
        providerVersion &&
        compareVersions(providerVersion, effectiveVersion) !== 0,
      );
      return {
        rowId,
        kind: row?.kind ?? template?.kind ?? "direct",
        groupId: row?.groupId ?? template?.groupId ?? "",
        artifactId: row?.artifactId ?? template?.artifactId ?? "",
        dependencyLabel: row?.dependencyLabel ?? template?.dependencyLabel ?? rowId,
        rawVersion: row?.rawVersion,
        effectiveVersion,
        propertyName: row?.propertyName,
        propertyValue: row?.propertyValue,
        providerVersion,
        availableUpdateVersion: showAvailableUpdateVersion,
        hasLocalPropertyOverride: row?.hasLocalPropertyOverride ?? false,
        isUnusedOverride,
        overrideTargets: row?.overrideTargets,
        projectPath: analysis.project.path,
        projectName: analysis.project.name,
        present: Boolean(row),
        displayVersion: effectiveVersion ?? row?.propertyValue ?? row?.rawVersion,
        isMissingOverrideWarning,
        isUnusedOverride,
        isHighest,
        isOutdated,
        isPinnedBelowProvider,
        hasDifferentProviderVersion,
        showAvailableUpdateVersion: Boolean(row && showAvailableUpdateVersion),
        removeOverrideAvailable: Boolean(
          row?.hasLocalPropertyOverride &&
          (row.providerVersion || row.isUnusedOverride || row.kind === "override"),
        ),
        adoptHighestAvailable: Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) < 0),
      };
    });
    return {
      rowId,
      kind: template?.kind ?? "direct",
      label: buildReportLabel(rowStates, template, rowId),
      highestVersion,
      availableUpdateVersion: showAvailableUpdateVersion,
      cells,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    projects: analyses.map((analysis) => ({ name: analysis.project.name, path: analysis.project.path })),
    rows: rows.sort((left, right) => {
      const kindDiff = ROW_KIND_ORDER[left.kind] - ROW_KIND_ORDER[right.kind];
      if (kindDiff !== 0) {
        return kindDiff;
      }
      return left.label.localeCompare(right.label);
    }),
  };
}

export async function adoptHighestVersion(
  rowId: string,
  sourceProjectPath: string | undefined,
  targetProjectPaths: string[],
  mvnPath: string,
  log?: (message: string) => void,
): Promise<void> {
  const analyses = await analyzeProjectsForPaths([...(sourceProjectPath ? [sourceProjectPath] : []), ...targetProjectPaths], mvnPath);
  const report = buildCompareReport(analyses);
  const row = report.rows.find((entry) => entry.rowId === rowId);
  if (!row || !row.highestVersion) {
    throw new Error(`Could not resolve row ${rowId}.`);
  }
  const sourceCell = selectSourceCell(row, sourceProjectPath);
  if (!sourceCell) {
    throw new Error(`Could not resolve source project for ${rowId}.`);
  }
  for (const targetPath of targetProjectPaths) {
    const analysis = analyses.find((entry) => entry.project.path === targetPath);
    if (!analysis) {
      continue;
    }
    const rowState = analysis.rows.get(rowId) ?? (
      row.kind === "override" && sourceCell.propertyName
        ? {
          rowId,
          kind: "override" as const,
          groupId: "__override__",
          artifactId: sourceCell.propertyName,
          dependencyLabel: row.label,
          propertyName: sourceCell.propertyName,
          hasLocalPropertyOverride: true,
        }
        : undefined
    );
    if (!rowState) {
      continue;
    }
    const targetVersion = sourceCell.effectiveVersion ?? row.highestVersion!;
    log?.(`[apply] adopt highest for ${describeRow(rowState)} -> ${targetVersion}`);
    log?.(`[write] ${analysis.pomPath}`);
    mutatePom(analysis.pomPath, (raw) => {
      applyAdoptHighest(raw, rowState, targetVersion, sourceCell.propertyName);
    });
  }
}

export async function removeOverride(
  rowId: string,
  targetProjectPaths: string[],
  mvnPath: string,
  log?: (message: string) => void,
): Promise<void> {
  const analyses = await analyzeProjectsForPaths(targetProjectPaths, mvnPath);
  for (const analysis of analyses) {
    const row = analysis.rows.get(rowId);
    if (!row?.hasLocalPropertyOverride || !row.propertyName) {
      continue;
    }
    log?.(`[apply] remove override for ${describeRow(row)}`);
    log?.(`[write] ${analysis.pomPath}`);
    mutatePom(analysis.pomPath, (raw) => {
      applyRemoveOverride(raw, row);
    });
  }
}

export async function analyzeProjectsForPaths(projectPaths: string[], mvnPath: string): Promise<ProjectPomAnalysis[]> {
  const projects = projectPaths.map((projectPath) => ({
    name: path.basename(projectPath),
    path: projectPath,
    projectType: "maven" as const,
    marker: "pom.xml",
    projectTypes: ["maven"] as ("maven")[],
    identity: `${path.basename(projectPath)}:${projectPath}`,
  }));
  return await analyzeProjects(projects, mvnPath);
}

export async function analyzeProjectsForPathsWithProgress(
  projectPaths: string[],
  mvnPath: string,
  mode: "fast" | "deep" = "deep",
  includeDependencyUpdates = true,
  onProbeProgress?: (progress: ProbeProgress) => void,
): Promise<ProjectPomAnalysis[]> {
  const projects = projectPaths.map((projectPath) => ({
    name: path.basename(projectPath),
    path: projectPath,
    projectType: "maven" as const,
    marker: "pom.xml",
    projectTypes: ["maven"] as ("maven")[],
    identity: `${path.basename(projectPath)}:${projectPath}`,
  }));
  return await analyzeProjects(projects, mvnPath, mode, includeDependencyUpdates, undefined, undefined, "capture", onProbeProgress);
}

async function analyzeProject(
  project: Project,
  mvnPath: string,
  mode: "fast" | "deep",
  includeDependencyUpdates: boolean,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<ProjectPomAnalysis> {
  const pomPath = path.join(project.path, "pom.xml");
  const pomContent = fs.readFileSync(pomPath, "utf8");
  const rawPom = loadRawPom(pomPath);
  const effectivePom = await loadEffectivePom(
    pomPath,
    mvnPath,
    { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
    pomContent,
    log,
    signal,
    outputMode,
  );
  const effectiveRows = extractEffectiveRows(effectivePom);
  const propertyProbeCache = await buildPropertyProbeCache(pomPath, mvnPath, rawPom, effectiveRows, mode, log, signal, outputMode, {
    projectName: project.name,
    projectIndex: progress?.projectIndex ?? 0,
    projectCount: progress?.projectCount ?? 1,
    onProbeProgress: progress?.onProbeProgress,
  });
  const availableUpdates = mode === "deep" && includeDependencyUpdates
    ? await resolveAvailableUpdates(
      pomPath,
      mvnPath,
      rawPom,
      log,
      signal,
      outputMode,
      {
        projectName: project.name,
        projectIndex: progress?.projectIndex ?? 0,
        projectCount: progress?.projectCount ?? 1,
        onProbeProgress: progress?.onProbeProgress,
      },
    )
    : new Map<string, string>();

  const rows = new Map<string, PomDependencyRow>();
  for (const [rowId, row] of rawPom.rows.entries()) {
    const effectiveRow = effectiveRows.get(rowId);
    const providerVersion = row.propertyName
      ? propertyProbeCache.get(row.propertyName)?.targets.find((target) => target.rowId === rowId)?.providerVersion
      : undefined;
    rows.set(rowId, {
      ...row,
      effectiveVersion: normalizeResolvedVersion(effectiveRow?.effectiveVersion ?? row.rawVersion, row.propertyValue),
      providerVersion: normalizeResolvedVersion(providerVersion, undefined),
      availableUpdateVersion: availableUpdates.get(rowId),
    });
  }
  for (const overrideRow of buildOverrideRows(rawPom, propertyProbeCache, mode)) {
    overrideRow.availableUpdateVersion = availableUpdates.get(overrideRow.rowId)
      ?? maxVersion(
        (overrideRow.overrideTargets ?? [])
          .map((target) => availableUpdates.get(target.rowId))
          .filter((value): value is string => Boolean(value)),
      );
    rows.set(overrideRow.rowId, overrideRow);
  }

  return {
    project,
    pomPath,
    rows,
  };
}

function loadRawPom(pomPath: string): RawPomModel {
  const root = parseXmlDocument(fs.readFileSync(pomPath, "utf8"));
  const projectElement = root;
  const propertiesElement = firstChild(projectElement, "properties");
  const localProperties = new Map<string, string>();
  for (const child of childElements(propertiesElement ?? projectElement)) {
    if (propertiesElement && child !== propertiesElement && localName(child.name) === "properties") {
      continue;
    }
  }
  if (propertiesElement) {
    for (const property of childElements(propertiesElement)) {
      localProperties.set(localName(property.name), textContent(property));
    }
  }

  const rows = new Map<string, PomDependencyRow>();
  const parent = firstChild(projectElement, "parent");
  if (parent) {
    const row = buildRow("parent", parent, localProperties);
    if (row) {
      rows.set(row.rowId, row);
    }
  }

  const dependencies = firstChild(projectElement, "dependencies");
  for (const dependency of childElements(dependencies ?? projectElement, "dependency")) {
    const row = buildRow("direct", dependency, localProperties);
    if (row) {
      rows.set(row.rowId, row);
    }
  }

  const dependencyManagement = firstChild(projectElement, "dependencyManagement");
  const managedDependencies = firstChild(dependencyManagement ?? projectElement, "dependencies");
  for (const dependency of childElements(managedDependencies ?? dependencyManagement ?? projectElement, "dependency")) {
    const row = buildRow("managed", dependency, localProperties);
    if (row) {
      rows.set(row.rowId, row);
    }
  }

  return {
    root,
    projectName: textContent(firstChild(projectElement, "artifactId") ?? projectElement) || path.basename(path.dirname(pomPath)),
    groupId: textContent(firstChild(projectElement, "groupId") ?? projectElement) || textContent(firstChild(parent ?? projectElement, "groupId") ?? projectElement) || undefined,
    artifactId: textContent(firstChild(projectElement, "artifactId") ?? projectElement) || undefined,
    localProperties,
    rows,
  };
}

function extractEffectiveRows(root: XmlElementNode): Map<string, PomDependencyRow> {
  const rows = new Map<string, PomDependencyRow>();
  const parent = firstChild(root, "parent");
  if (parent) {
    const row = buildRow("parent", parent, new Map());
    if (row) {
      rows.set(row.rowId, { ...row, effectiveVersion: row.rawVersion });
    }
  }
  const dependencies = firstChild(root, "dependencies");
  for (const dependency of childElements(dependencies ?? root, "dependency")) {
    const row = buildRow("direct", dependency, new Map());
    if (row) {
      rows.set(row.rowId, { ...row, effectiveVersion: row.rawVersion });
    }
  }
  const dependencyManagement = firstChild(root, "dependencyManagement");
  const managedDependencies = firstChild(dependencyManagement ?? root, "dependencies");
  for (const dependency of childElements(managedDependencies ?? dependencyManagement ?? root, "dependency")) {
    const row = buildRow("managed", dependency, new Map());
    if (row) {
      rows.set(row.rowId, { ...row, effectiveVersion: row.rawVersion });
    }
  }
  return rows;
}

function buildRow(kind: CompareRowKind, element: XmlElementNode, localProperties: Map<string, string>): PomDependencyRow | undefined {
  const groupId = textContent(firstChild(element, "groupId") ?? element);
  const artifactId = textContent(firstChild(element, "artifactId") ?? element);
  if (!groupId || !artifactId) {
    return undefined;
  }
  const version = textContent(firstChild(element, "version") ?? element) || undefined;
  const propertyName = version ? referencedLocalProperty(version, localProperties) : undefined;
  const propertyValue = propertyName ? localProperties.get(propertyName) : undefined;
  return {
    rowId: `${kind}:${groupId}:${artifactId}`,
    kind,
    groupId,
    artifactId,
    dependencyLabel: kind === "parent" ? `${groupId}:${artifactId}` : `${groupId}:${artifactId}`,
    rawVersion: version,
    hasLocalPropertyOverride: Boolean(propertyName),
    propertyName,
    propertyValue,
  };
}

async function loadEffectivePom(
  pomPath: string,
  mvnPath: string,
  projectCoordinates?: { groupId?: string; artifactId?: string },
  pomContent?: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  quiet = false,
): Promise<XmlElementNode> {
  const sourceContent = pomContent ?? fs.readFileSync(pomPath, "utf8");
  const cachePath = buildEffectivePomCachePath(hashContent(sourceContent), projectCoordinates);
  if (fs.existsSync(cachePath)) {
    return selectEffectiveProjectRoot(parseXmlDocument(fs.readFileSync(cachePath, "utf8")), projectCoordinates);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-effective-pom-"));
  const outputPath = path.join(tempDir, "effective-pom.xml");
  const result = await runSingleCommand(
    path.dirname(pomPath),
    [mvnPath, "-q", "-f", pomPath, "help:effective-pom", `-Doutput=${outputPath}`],
    "maven effective pom",
    log,
    signal,
    outputMode,
    quiet,
  );
  if (!result.success || !fs.existsSync(outputPath)) {
    throw new Error(`Could not resolve effective POM for ${pomPath}. ${result.message}`);
  }
  const effectivePomContent = fs.readFileSync(outputPath, "utf8");
  ensureCacheDirectory(EFFECTIVE_POM_CACHE_DIRECTORY);
  fs.writeFileSync(cachePath, effectivePomContent, "utf8");
  return selectEffectiveProjectRoot(parseXmlDocument(effectivePomContent), projectCoordinates);
}

function buildOverrideRows(
  rawPom: RawPomModel,
  propertyProbeCache: Map<string, PropertyProbeResult>,
  mode: "fast" | "deep",
): PomDependencyRow[] {
  const overrideRows: PomDependencyRow[] = [];
  for (const [propertyName, propertyValue] of rawPom.localProperties.entries()) {
    if (!isVersionLikeProperty(propertyName)) {
      continue;
    }
    const propertyProbe = propertyProbeCache.get(propertyName);
    const isUnusedOverride = !propertyProbe || (!propertyProbe.propertyProviderValue && propertyProbe.targets.length === 0);
    const providerVersion = maxVersion(
      [
        propertyProbe?.propertyProviderValue,
        ...(propertyProbe?.targets ?? [])
        .map((target) => normalizeResolvedVersion(target.providerVersion, undefined))
        .filter((value): value is string => Boolean(value)),
      ],
    );
    overrideRows.push({
      rowId: `override:${propertyName}`,
      kind: "override",
      groupId: "__override__",
      artifactId: propertyName,
      dependencyLabel: buildOverrideLabel(propertyName, propertyProbe?.targets ?? []),
      rawVersion: propertyValue,
      effectiveVersion: propertyValue,
      propertyName,
      propertyValue,
      providerVersion,
      hasLocalPropertyOverride: true,
      isUnusedOverride,
      overrideTargets: propertyProbe?.targets ?? [],
    });
  }
  return overrideRows;
}

async function buildPropertyProbeCache(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  effectiveRows: Map<string, PomDependencyRow>,
  mode: "fast" | "deep",
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectName: string;
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<Map<string, PropertyProbeResult>> {
  const cache = new Map<string, PropertyProbeResult>();
  const propertyNames = [...rawPom.localProperties.keys()].filter(isVersionLikeProperty);
  if (mode === "fast") {
    const removablePropertyNames = propertyNames.filter((propertyName) => !isDirectlyReferencedProperty(rawPom, propertyName));
    const baseline = await resolveAllVersionPropertiesBaseline(
      pomPath,
      mvnPath,
      rawPom,
      effectiveRows,
      removablePropertyNames,
      log,
      signal,
      outputMode,
      progress,
    );
    for (const propertyName of propertyNames) {
      const propertyProbe = buildFastPropertyProbe(rawPom, baseline, propertyName);
      if (propertyProbe) {
        cache.set(propertyName, propertyProbe);
      }
    }
    return cache;
  }
  for (const [propertyIndex, propertyName] of propertyNames.entries()) {
    progress?.onProbeProgress?.({
      projectName: progress.projectName,
      projectIndex: progress.projectIndex,
      projectCount: progress.projectCount,
      propertyName,
      propertyIndex,
      propertyCount: propertyNames.length,
    });
    const propertyProbe = await resolvePropertyOverrideRows(
      pomPath,
      mvnPath,
      rawPom,
      propertyName,
      effectiveRows,
      log,
      signal,
      outputMode,
    );
    if (propertyProbe) {
      cache.set(propertyName, propertyProbe);
    }
  }
  return cache;
}

async function resolveAvailableUpdates(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectName: string;
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<Map<string, string>> {
  const availableUpdates = new Map<string, string>();
  const dependencyUpdates = await resolveDependencyUpdates(
    pomPath,
    mvnPath,
    log,
    signal,
    outputMode,
    progress,
  );
  for (const update of dependencyUpdates) {
    availableUpdates.set(`${update.kind}:${update.groupId}:${update.artifactId}`, update.availableVersion);
  }

  const propertyNames = [...rawPom.localProperties.keys()].filter(isVersionLikeProperty);
  if (propertyNames.length === 0) {
    return availableUpdates;
  }
  const propertyUpdates = await resolvePropertyUpdates(
    pomPath,
    mvnPath,
    propertyNames,
    log,
    signal,
    outputMode,
    progress,
  );
  for (const [propertyName, availableVersion] of propertyUpdates.entries()) {
    availableUpdates.set(`override:${propertyName}`, availableVersion);
  }
  return availableUpdates;
}

interface FastBaseline {
  providerRows: Map<string, PomDependencyRow>;
  providerProperties: Map<string, string>;
  changedTargets: OverrideTarget[];
}

async function resolveAllVersionPropertiesBaseline(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  effectiveRows: Map<string, PomDependencyRow>,
  removablePropertyNames: string[],
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectName: string;
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<FastBaseline | undefined> {
  progress?.onProbeProgress?.({
    projectName: progress.projectName,
    projectIndex: progress.projectIndex,
    projectCount: progress.projectCount,
    propertyName: "",
    propertyIndex: 0,
    propertyCount: 0,
  });
  const cloned = cloneElement(rawPom.root);
  for (const propertyName of removablePropertyNames) {
    removePropertyDefinition(cloned, propertyName);
  }
  const clonedContent = serializeXmlDocument(cloned);
  const projectDir = path.dirname(pomPath);
  const tempPomPath = path.join(projectDir, `.devtools-provider-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pom.xml`);
  fs.writeFileSync(tempPomPath, clonedContent, "utf8");
  try {
    const providerPom = await loadEffectivePom(
      tempPomPath,
      mvnPath,
      { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
      clonedContent,
      log,
      signal,
      "capture",
      true,
    );
    return {
      providerRows: extractEffectiveRows(providerPom),
      providerProperties: extractProperties(providerPom),
      changedTargets: extractChangedTargets(effectiveRows, extractEffectiveRows(providerPom)),
    };
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tempPomPath, { force: true });
  }
}

function buildFastPropertyProbe(
  rawPom: RawPomModel,
  baseline: FastBaseline | undefined,
  propertyName: string,
): PropertyProbeResult | undefined {
  if (!baseline) {
    return undefined;
  }
  const directTargets = [...rawPom.rows.values()]
    .filter((row) => row.propertyName === propertyName && row.kind !== "parent")
    .map((row) => ({
      rowId: row.rowId,
      kind: row.kind as Exclude<CompareRowKind, "override" | "parent">,
      groupId: row.groupId,
      artifactId: row.artifactId,
      dependencyLabel: row.dependencyLabel,
      providerVersion: normalizeResolvedVersion(
        baseline.providerRows.get(row.rowId)?.effectiveVersion ?? baseline.providerRows.get(row.rowId)?.rawVersion,
        undefined,
      ),
    }))
    .filter((target) => Boolean(target.providerVersion));
  const inferredTargets = directTargets.length > 0
    ? directTargets
    : baseline.changedTargets.filter((target) => matchesPropertyTarget(propertyName, target));

  const currentPropertyValue = rawPom.localProperties.get(propertyName);
  const providerPropertyValue = baseline.providerProperties.get(propertyName);
  const propertyChanged = Boolean(providerPropertyValue && currentPropertyValue && providerPropertyValue !== currentPropertyValue);

  if (!propertyChanged && inferredTargets.length === 0) {
    return {
      targets: [],
      forceRow: !isDirectlyReferencedProperty(rawPom, propertyName),
    };
  }
  return {
    targets: inferredTargets,
    propertyProviderValue: propertyChanged ? providerPropertyValue : undefined,
    forceRow: !isDirectlyReferencedProperty(rawPom, propertyName),
  };
}

const VERSIONS_PLUGIN_CANDIDATE_VERSIONS = ["2.21.0", "2.19.1", "2.18.0", "2.17.1", "2.7"];
const IGNORED_UPDATE_VERSION_PATTERNS = [
  "(?i).*[._-]alpha\\d*.*",
  "(?i).*[._-]beta\\d*.*",
  "(?i).*[._-]milestone\\d*.*",
  "(?i).*[._-]m\\d+.*",
  "(?i).*[._-]rc\\d*.*",
  "(?i).*[._-]cr\\d*.*",
  "(?i).*[._-]ea\\d*.*",
  "(?i).*[._-]preview\\d*.*",
  ".*-SNAPSHOT",
].join(",");

function resolveVersionsPluginCoordinate(): string {
  const m2Repository = path.join(os.homedir(), ".m2", "repository", "org", "codehaus", "mojo", "versions-maven-plugin");
  for (const version of VERSIONS_PLUGIN_CANDIDATE_VERSIONS) {
    const directory = path.join(m2Repository, version);
    if (
      fs.existsSync(path.join(directory, `versions-maven-plugin-${version}.jar`)) &&
      fs.existsSync(path.join(directory, `versions-maven-plugin-${version}.pom`))
    ) {
      return `org.codehaus.mojo:versions-maven-plugin:${version}`;
    }
  }
  return "org.codehaus.mojo:versions-maven-plugin:2.21.0";
}

async function resolveDependencyUpdates(
  pomPath: string,
  mvnPath: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectName: string;
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<DependencyUpdateEntry[]> {
  if (progress?.onProbeProgress) {
    progress.onProbeProgress({
      stage: "update",
      projectName: progress.projectName,
      projectIndex: progress.projectIndex,
      projectCount: progress.projectCount,
      propertyName: "dependency updates",
      propertyIndex: 0,
      propertyCount: 2,
    });
  }
  const output = await runVersionsDisplayGoal(
    pomPath,
    mvnPath,
    `${resolveVersionsPluginCoordinate()}:display-dependency-updates`,
    [
      "-DprocessDependencyManagement=true",
      "-DallowMajorUpdates=true",
      "-DallowMinorUpdates=true",
      "-DallowIncrementalUpdates=true",
      "-DallowSnapshots=false",
      `-Dmaven.version.ignore=${IGNORED_UPDATE_VERSION_PATTERNS}`,
    ],
    log,
    signal,
    outputMode,
  );
  return parseDependencyUpdatesOutput(output);
}

async function resolvePropertyUpdates(
  pomPath: string,
  mvnPath: string,
  propertyNames: string[],
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  progress?: {
    projectName: string;
    projectIndex: number;
    projectCount: number;
    onProbeProgress?: (progress: ProbeProgress) => void;
  },
): Promise<Map<string, string>> {
  if (progress?.onProbeProgress) {
    progress.onProbeProgress({
      stage: "update",
      projectName: progress.projectName,
      projectIndex: progress.projectIndex,
      projectCount: progress.projectCount,
      propertyName: "property updates",
      propertyIndex: 1,
      propertyCount: 2,
    });
  }
  const output = await runVersionsDisplayGoal(
    pomPath,
    mvnPath,
    `${resolveVersionsPluginCoordinate()}:display-property-updates`,
    [
      `-DincludeProperties=${propertyNames.join(",")}`,
      "-DallowMajorUpdates=true",
      "-DallowMinorUpdates=true",
      "-DallowIncrementalUpdates=true",
      "-DallowSnapshots=false",
      `-Dmaven.version.ignore=${IGNORED_UPDATE_VERSION_PATTERNS}`,
      "-DincludeParent=false",
    ],
    log,
    signal,
    outputMode,
  );
  return parsePropertyUpdatesOutput(output);
}

async function runVersionsDisplayGoal(
  pomPath: string,
  mvnPath: string,
  goal: string,
  extraArgs: string[],
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<string> {
  const pomContent = fs.readFileSync(pomPath, "utf8");
  const cachePath = buildVersionsReportCachePath(hashContent(pomContent), goal, extraArgs);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf8");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-versions-report-"));
  const outputPath = path.join(tempDir, "updates.txt");
  try {
    const result = await runSingleCommand(
      path.dirname(pomPath),
      [
        mvnPath,
        "-q",
        "-f",
        pomPath,
        goal,
        `-Dversions.outputFile=${outputPath}`,
        "-Dversions.logOutput=false",
        "-Dversions.outputLineWidth=1000",
        ...extraArgs,
      ],
      "maven versions report",
      log,
      signal,
      outputMode,
      true,
    );
    if (!result.success || !fs.existsSync(outputPath)) {
      return "";
    }
    const reportContent = fs.readFileSync(outputPath, "utf8");
    ensureCacheDirectory(VERSIONS_REPORT_CACHE_DIRECTORY);
    fs.writeFileSync(cachePath, reportContent, "utf8");
    return reportContent;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseDependencyUpdatesOutput(text: string): DependencyUpdateEntry[] {
  const updates: DependencyUpdateEntry[] = [];
  let section: "direct" | "managed" = "direct";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[INFO\]\s?/, "").trimEnd();
    if (/The following dependencies in Dependency Management have newer versions:/i.test(line)) {
      section = "managed";
      continue;
    }
    if (/The following dependency updates are available:/i.test(line) || /The following dependencies(?: in Dependencies)? have newer versions:/i.test(line)) {
      section = "direct";
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\s+\.+\s+(\S+)\s+->\s+(\S+)\s*$/);
    if (!match) {
      continue;
    }
    if (!isStableUpdateVersion(match[4])) {
      continue;
    }
    updates.push({
      kind: section,
      groupId: match[1],
      artifactId: match[2],
      availableVersion: match[4],
    });
  }
  return updates;
}

function parsePropertyUpdatesOutput(text: string): Map<string, string> {
  const updates = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[INFO\]\s?/, "").trimEnd();
    const match = line.match(/^\s*\$\{([^}]+)\}\s+\.+\s+(\S+)\s+->\s+(\S+)\s*$/);
    if (!match) {
      continue;
    }
    if (!isStableUpdateVersion(match[3])) {
      continue;
    }
    updates.set(match[1], match[3]);
  }
  return updates;
}

function isStableUpdateVersion(version: string): boolean {
  return !/[._-](?:alpha|beta|milestone|m\d+|rc|cr|ea|preview)\d*/i.test(version) &&
    !/-SNAPSHOT/i.test(version);
}

function isVersionLikeProperty(propertyName: string): boolean {
  return /(?:^|[._-])version$/i.test(propertyName);
}

function isDirectlyReferencedProperty(rawPom: RawPomModel, propertyName: string): boolean {
  return [...rawPom.rows.values()].some((row) => row.propertyName === propertyName);
}

async function resolvePropertyOverrideRows(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  propertyName: string,
  effectiveRows: Map<string, PomDependencyRow>,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<PropertyProbeResult | undefined> {
  const cloned = cloneElement(rawPom.root);
  removePropertyDefinition(cloned, propertyName);
  const clonedContent = serializeXmlDocument(cloned);
  const projectDir = path.dirname(pomPath);
  const tempPomPath = path.join(projectDir, `.devtools-provider-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pom.xml`);
  fs.writeFileSync(tempPomPath, clonedContent, "utf8");
  try {
    const providerPom = await loadEffectivePom(
      tempPomPath,
      mvnPath,
      { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
      clonedContent,
      log,
      signal,
      "capture",
      true,
    );
    const providerRows = extractEffectiveRows(providerPom);
    const changedTargets: OverrideTarget[] = [];
    const rowIds = [...new Set([...effectiveRows.keys(), ...providerRows.keys()])];
    for (const rowId of rowIds) {
      const current = effectiveRows.get(rowId);
      const provider = providerRows.get(rowId);
      const currentVersion = normalizeResolvedVersion(current?.effectiveVersion ?? current?.rawVersion, current?.propertyValue);
      const providerVersion = normalizeResolvedVersion(provider?.effectiveVersion ?? provider?.rawVersion, provider?.propertyValue);
      if (!current || current.kind === "parent" || !currentVersion || !providerVersion || currentVersion === providerVersion) {
        continue;
      }
      changedTargets.push({
        rowId,
        kind: current.kind as Exclude<CompareRowKind, "override" | "parent">,
        groupId: current.groupId,
        artifactId: current.artifactId,
        dependencyLabel: current.dependencyLabel,
        providerVersion,
      });
    }
    if (changedTargets.length === 0) {
      return undefined;
    }
    changedTargets.sort((left, right) => left.dependencyLabel.localeCompare(right.dependencyLabel));
    return {
      targets: changedTargets,
      propertyProviderValue: normalizeResolvedVersion(extractProperties(providerPom).get(propertyName), undefined),
    };
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tempPomPath, { force: true });
  }
}

function referencedLocalProperty(version: string, localProperties: Map<string, string>): string | undefined {
  const match = version.match(/^\$\{([^}]+)\}$/);
  if (!match) {
    return undefined;
  }
  return localProperties.has(match[1]!) ? match[1] : undefined;
}

function normalizeResolvedVersion(candidate: string | undefined, propertyValue: string | undefined): string | undefined {
  if (!candidate) {
    return propertyValue;
  }
  if (/^\$\{[^}]+\}$/.test(candidate)) {
    return propertyValue ?? candidate;
  }
  return candidate;
}

function extractProperties(root: XmlElementNode): Map<string, string> {
  const properties = firstChild(root, "properties");
  const values = new Map<string, string>();
  if (!properties) {
    return values;
  }
  for (const property of childElements(properties)) {
    values.set(localName(property.name), textContent(property));
  }
  return values;
}

function extractChangedTargets(
  effectiveRows: Map<string, PomDependencyRow>,
  providerRows: Map<string, PomDependencyRow>,
): OverrideTarget[] {
  const changedTargets: OverrideTarget[] = [];
  const rowIds = [...new Set([...effectiveRows.keys(), ...providerRows.keys()])];
  for (const rowId of rowIds) {
    const current = effectiveRows.get(rowId);
    const provider = providerRows.get(rowId);
    const currentVersion = normalizeResolvedVersion(current?.effectiveVersion ?? current?.rawVersion, current?.propertyValue);
    const providerVersion = normalizeResolvedVersion(provider?.effectiveVersion ?? provider?.rawVersion, provider?.propertyValue);
    if (!current || current.kind === "parent" || !currentVersion || !providerVersion || currentVersion === providerVersion) {
      continue;
    }
    changedTargets.push({
      rowId,
      kind: current.kind as Exclude<CompareRowKind, "override" | "parent">,
      groupId: current.groupId,
      artifactId: current.artifactId,
      dependencyLabel: current.dependencyLabel,
      providerVersion,
    });
  }
  changedTargets.sort((left, right) => left.dependencyLabel.localeCompare(right.dependencyLabel));
  return changedTargets;
}

function matchesPropertyTarget(propertyName: string, target: OverrideTarget): boolean {
  const search = `${target.groupId}:${target.artifactId}`.toLowerCase();
  const candidates = buildPropertyMatchCandidates(propertyName);
  return candidates.some((candidate) => candidate.length >= 4 && search.includes(candidate));
}

function buildPropertyMatchCandidates(propertyName: string): string[] {
  const stem = propertyName.replace(/(?:^|[._-])version$/i, "");
  const rawTokens = stem.toLowerCase().split(/[._-]+/).filter(Boolean);
  const simplifiedTokens = rawTokens.flatMap((token) => {
    const withoutDigits = token.replace(/\d+/g, "");
    return withoutDigits && withoutDigits !== token ? [token, withoutDigits] : [token];
  });
  const joined = simplifiedTokens.join("");
  return [...new Set([...simplifiedTokens, joined])];
}

function mutatePom(pomPath: string, mutate: (root: XmlElementNode) => void): void {
  const root = parseXmlDocument(fs.readFileSync(pomPath, "utf8"));
  mutate(root);
  fs.writeFileSync(pomPath, serializeXmlDocument(root), "utf8");
}

function describeRow(row: Pick<PomDependencyRow, "kind" | "dependencyLabel" | "propertyName">): string {
  if (row.kind === "override") {
    return `$${row.propertyName ?? row.dependencyLabel.replace(/^\$/, "")}`;
  }
  return `${row.kind} ${row.dependencyLabel}`;
}

function removePropertyDefinition(root: XmlElementNode, propertyName: string): void {
  const properties = firstChild(root, "properties");
  if (!properties) {
    return;
  }
  const property = childElements(properties).find((child) => localName(child.name) === propertyName);
  if (!property) {
    return;
  }
  removeChild(properties, property);
  if (childElements(properties).length === 0) {
    removeChild(root, properties);
  }
}

function applyAdoptHighest(root: XmlElementNode, row: PomDependencyRow, version: string, sourcePropertyName?: string): void {
  if (row.kind === "override") {
    const propertyName = sourcePropertyName ?? row.propertyName;
    if (!propertyName) {
      return;
    }
    const properties = ensureChild(root, "properties");
    const property = ensureChild(properties, propertyName);
    setTextContent(property, version);
    return;
  }
  const target = findRowElement(root, row);
  if (!target) {
    return;
  }
  const versionElement = ensureChild(target, "version");
  if (sourcePropertyName) {
    const properties = ensureChild(root, "properties");
    const property = ensureChild(properties, sourcePropertyName);
    setTextContent(property, version);
    setTextContent(versionElement, `\${${sourcePropertyName}}`);
    return;
  }
  setTextContent(versionElement, version);
}

function applyRemoveOverride(root: XmlElementNode, row: PomDependencyRow): void {
  if (row.kind === "override") {
    for (const target of row.overrideTargets ?? []) {
      const rawTarget: PomDependencyRow = {
        rowId: target.rowId,
        kind: target.kind,
        groupId: target.groupId,
        artifactId: target.artifactId,
        dependencyLabel: target.dependencyLabel,
        propertyName: row.propertyName,
        providerVersion: target.providerVersion,
        hasLocalPropertyOverride: true,
      };
      applyRemoveOverrideInternal(root, rawTarget, false);
    }
    if (row.propertyName) {
      maybeRemoveProperty(root, row.propertyName);
    }
    return;
  }
  applyRemoveOverrideInternal(root, row, true);
}

function applyRemoveOverrideInternal(root: XmlElementNode, row: PomDependencyRow, cleanupProperty: boolean): void {
  const target = findRowElement(root, row);
  if (!target) {
    return;
  }
  const versionElement = firstChild(target, "version");
  if (!versionElement) {
    return;
  }
  if (row.kind === "direct") {
    removeChild(target, versionElement);
  } else if (row.providerVersion) {
    setTextContent(versionElement, row.providerVersion);
  } else {
    return;
  }
  if (cleanupProperty && row.propertyName) {
    maybeRemoveProperty(root, row.propertyName);
  }
}

function maybeRemoveProperty(root: XmlElementNode, propertyName: string): void {
  let referenced = false;
  walkElements(root, (element) => {
    if (referenced) {
      return;
    }
    if (textContent(element).includes(`\${${propertyName}}`)) {
      referenced = true;
    }
  });
  if (referenced) {
    return;
  }
  const properties = firstChild(root, "properties");
  if (!properties) {
    return;
  }
  const property = childElements(properties).find((child) => localName(child.name) === propertyName);
  if (!property) {
    return;
  }
  removeChild(properties, property);
  if (childElements(properties).length === 0) {
    removeChild(root, properties);
  }
}

function findRowElement(root: XmlElementNode, row: PomDependencyRow): XmlElementNode | undefined {
  if (row.kind === "parent") {
    const parent = firstChild(root, "parent");
    if (!parent) {
      return undefined;
    }
    return textContent(firstChild(parent, "groupId") ?? parent) === row.groupId &&
      textContent(firstChild(parent, "artifactId") ?? parent) === row.artifactId
      ? parent
      : undefined;
  }
  const container = row.kind === "direct"
    ? firstChild(root, "dependencies")
    : firstChild(firstChild(root, "dependencyManagement") ?? root, "dependencies");
  if (!container) {
    return undefined;
  }
  return childElements(container, "dependency").find((dependency) =>
    textContent(firstChild(dependency, "groupId") ?? dependency) === row.groupId &&
    textContent(firstChild(dependency, "artifactId") ?? dependency) === row.artifactId);
}

function selectSourceCell(row: ReportRow, sourceProjectPath?: string): ReportCell | undefined {
  if (sourceProjectPath) {
    const explicit = row.cells.find((cell) => cell.projectPath === sourceProjectPath && cell.present);
    if (explicit) {
      return explicit;
    }
  }
  const highestCells = row.cells.filter((cell) => cell.present && cell.isHighest);
  return highestCells.find((cell) => cell.hasLocalPropertyOverride) ?? highestCells[0];
}

export function rowKindLabel(kind: CompareRowKind): string {
  return ROW_KIND_LABELS[kind];
}

function buildOverrideLabel(propertyName: string, targets: OverrideTarget[]): string {
  void targets;
  return `$${propertyName}`;
}

function buildReportLabel(
  rowStates: Array<PomDependencyRow | undefined>,
  template: PomDependencyRow | undefined,
  rowId: string,
): string {
  if (template?.kind !== "override") {
    return template?.dependencyLabel ?? rowId;
  }
  const propertyName = template.propertyName ?? template.artifactId;
  return buildOverrideLabel(propertyName, rowStates.flatMap((row) => row?.overrideTargets ?? []));
}

export function selectEffectiveProjectRoot(
  root: XmlElementNode,
  projectCoordinates?: { groupId?: string; artifactId?: string },
): XmlElementNode {
  if (localName(root.name) !== "projects") {
    return root;
  }
  const projects = childElements(root, "project");
  if (projects.length === 0) {
    return root;
  }
  const matchingProject = projects.find((project) =>
    (!projectCoordinates?.artifactId || textContent(firstChild(project, "artifactId") ?? project) === projectCoordinates.artifactId) &&
    (!projectCoordinates?.groupId || textContent(firstChild(project, "groupId") ?? project) === projectCoordinates.groupId)
  );
  return matchingProject ?? projects[0]!;
}
