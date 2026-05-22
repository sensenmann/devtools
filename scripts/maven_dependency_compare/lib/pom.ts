import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runSingleCommand } from "../../../src/script-runtime.ts";
import type { Project } from "../../../src/models.ts";
import { compareVersions, maxVersion } from "./version.ts";
import { childElements, cloneElement, ensureChild, firstChild, localName, parseXmlDocument, removeChild, serializeXmlDocument, setTextContent, textContent, walkElements, type XmlElementNode } from "./xml.ts";
import { ROW_KIND_LABELS, ROW_KIND_ORDER } from "./constants.ts";

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
  hasLocalPropertyOverride: boolean;
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
  isHighest: boolean;
  isOutdated: boolean;
  isPinnedBelowProvider: boolean;
  removeOverrideAvailable: boolean;
  adoptHighestAvailable: boolean;
}

export interface ReportRow {
  rowId: string;
  kind: CompareRowKind;
  label: string;
  highestVersion?: string;
  cells: ReportCell[];
}

export interface CompareReport {
  generatedAt: string;
  projects: Array<{ name: string; path: string }>;
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

export async function analyzeProjects(
  projects: Project[],
  mvnPath: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<ProjectPomAnalysis[]> {
  const analyses: ProjectPomAnalysis[] = [];
  for (const project of projects) {
    analyses.push(await analyzeProject(project, mvnPath, log, signal, outputMode));
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
    const template = rowStates.find(Boolean);
    const cells = analyses.map((analysis) => {
      const row = analysis.rows.get(rowId);
      const effectiveVersion = normalizeResolvedVersion(row?.effectiveVersion, row?.propertyValue);
      const providerVersion = row?.providerVersion;
      const isHighest = Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) === 0);
      const isOutdated = Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) < 0);
      const isPinnedBelowProvider = Boolean(
        row?.hasLocalPropertyOverride &&
        effectiveVersion &&
        providerVersion &&
        compareVersions(providerVersion, effectiveVersion) > 0,
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
        hasLocalPropertyOverride: row?.hasLocalPropertyOverride ?? false,
        projectPath: analysis.project.path,
        projectName: analysis.project.name,
        present: Boolean(row),
        displayVersion: effectiveVersion ?? row?.propertyValue ?? row?.rawVersion,
        isHighest,
        isOutdated,
        isPinnedBelowProvider,
        removeOverrideAvailable: Boolean(
          row?.hasLocalPropertyOverride &&
          row.providerVersion,
        ),
        adoptHighestAvailable: Boolean(row && highestVersion && effectiveVersion && compareVersions(effectiveVersion, highestVersion) < 0),
      };
    });
    return {
      rowId,
      kind: template?.kind ?? "direct",
      label: buildReportLabel(rowStates, template, rowId),
      highestVersion,
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
    const rowState = analysis?.rows.get(rowId);
    if (!analysis || !rowState) {
      continue;
    }
    mutatePom(analysis.pomPath, (raw) => {
      applyAdoptHighest(raw, rowState, sourceCell.effectiveVersion ?? row.highestVersion!, sourceCell.propertyName);
    });
  }
}

export async function removeOverride(
  rowId: string,
  targetProjectPaths: string[],
  mvnPath: string,
): Promise<void> {
  const analyses = await analyzeProjectsForPaths(targetProjectPaths, mvnPath);
  for (const analysis of analyses) {
    const row = analysis.rows.get(rowId);
    if (!row?.hasLocalPropertyOverride || !row.propertyName) {
      continue;
    }
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

async function analyzeProject(
  project: Project,
  mvnPath: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<ProjectPomAnalysis> {
  const pomPath = path.join(project.path, "pom.xml");
  const rawPom = loadRawPom(pomPath);
  const effectivePom = await loadEffectivePom(
    pomPath,
    mvnPath,
    { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
    log,
    signal,
    outputMode,
  );
  const effectiveRows = extractEffectiveRows(effectivePom);

  const rows = new Map<string, PomDependencyRow>();
  for (const [rowId, row] of rawPom.rows.entries()) {
    const effectiveRow = effectiveRows.get(rowId);
    const providerVersion = row.hasLocalPropertyOverride
      ? await resolveProviderVersionForRow(pomPath, mvnPath, rawPom, row, log, signal, outputMode)
      : undefined;
    rows.set(rowId, {
      ...row,
      effectiveVersion: normalizeResolvedVersion(effectiveRow?.effectiveVersion ?? row.rawVersion, row.propertyValue),
      providerVersion: normalizeResolvedVersion(providerVersion, undefined),
    });
  }
  for (const overrideRow of await buildOverrideRows(pomPath, mvnPath, rawPom, effectiveRows, log, signal, outputMode)) {
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
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
  quiet = false,
): Promise<XmlElementNode> {
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
  return selectEffectiveProjectRoot(parseXmlDocument(fs.readFileSync(outputPath, "utf8")), projectCoordinates);
}

async function buildOverrideRows(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  effectiveRows: Map<string, PomDependencyRow>,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<PomDependencyRow[]> {
  const overrideRows: PomDependencyRow[] = [];
  for (const [propertyName, propertyValue] of rawPom.localProperties.entries()) {
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
    if (!propertyProbe || propertyProbe.targets.length === 0) {
      continue;
    }
    if (!propertyProbe.targets.some((target) => rawPom.rows.get(target.rowId)?.propertyName !== propertyName)) {
      continue;
    }
    const providerVersion = maxVersion(
      propertyProbe.targets
        .map((target) => normalizeResolvedVersion(target.providerVersion, undefined))
        .filter((value): value is string => Boolean(value)),
    );
    overrideRows.push({
      rowId: `override:${propertyName}`,
      kind: "override",
      groupId: "__override__",
      artifactId: propertyName,
      dependencyLabel: buildOverrideLabel(propertyName, propertyProbe.targets),
      rawVersion: propertyValue,
      effectiveVersion: propertyValue,
      propertyName,
      propertyValue,
      providerVersion,
      hasLocalPropertyOverride: true,
      overrideTargets: propertyProbe.targets,
    });
  }
  return overrideRows;
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
): Promise<{ targets: OverrideTarget[] } | undefined> {
  const cloned = cloneElement(rawPom.root);
  removePropertyDefinition(cloned, propertyName);
  const projectDir = path.dirname(pomPath);
  const tempPomPath = path.join(projectDir, `.devtools-provider-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pom.xml`);
  fs.writeFileSync(tempPomPath, serializeXmlDocument(cloned), "utf8");
  try {
    const providerPom = await loadEffectivePom(
      tempPomPath,
      mvnPath,
      { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
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
    return { targets: changedTargets };
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tempPomPath, { force: true });
  }
}

async function resolveProviderVersionForRow(
  pomPath: string,
  mvnPath: string,
  rawPom: RawPomModel,
  row: PomDependencyRow,
  log?: (message: string) => void,
  signal?: AbortSignal,
  outputMode: "capture" | "passthrough" = "capture",
): Promise<string | undefined> {
  if (!row.propertyName || row.kind === "parent") {
    return undefined;
  }
  const cloned = cloneElement(rawPom.root);
  removePropertyDefinition(cloned, row.propertyName);
  if (!prepareRowForProviderFallback(cloned, row)) {
    return undefined;
  }

  const projectDir = path.dirname(pomPath);
  const tempPomPath = path.join(projectDir, `.devtools-provider-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pom.xml`);
  fs.writeFileSync(tempPomPath, serializeXmlDocument(cloned), "utf8");
  try {
    const providerPom = await loadEffectivePom(
      tempPomPath,
      mvnPath,
      { groupId: rawPom.groupId, artifactId: rawPom.artifactId },
      log,
      signal,
      "capture",
      true,
    );
    const providerRows = extractEffectiveRows(providerPom);
    return providerRows.get(row.rowId)?.effectiveVersion;
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

function mutatePom(pomPath: string, mutate: (root: XmlElementNode) => void): void {
  const root = parseXmlDocument(fs.readFileSync(pomPath, "utf8"));
  mutate(root);
  fs.writeFileSync(pomPath, serializeXmlDocument(root), "utf8");
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

function prepareRowForProviderFallback(root: XmlElementNode, row: PomDependencyRow): boolean {
  const target = findRowElement(root, row);
  if (!target) {
    return false;
  }
  if (row.kind === "direct") {
    const versionElement = firstChild(target, "version");
    if (!versionElement) {
      return false;
    }
    removeChild(target, versionElement);
    return true;
  }
  if (row.kind === "managed") {
    const dependencyManagement = firstChild(root, "dependencyManagement");
    const dependencies = firstChild(dependencyManagement ?? root, "dependencies");
    if (!dependencyManagement || !dependencies) {
      return false;
    }
    removeChild(dependencies, target);
    if (childElements(dependencies, "dependency").length === 0) {
      removeChild(dependencyManagement, dependencies);
    }
    if (childElements(dependencyManagement).length === 0) {
      removeChild(root, dependencyManagement);
    }
    return true;
  }
  return false;
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
