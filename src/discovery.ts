import fs from "node:fs";
import path from "node:path";

import type { AppConfig, Project, ProjectType } from "./models.ts";
import { PROJECT_MARKERS } from "./models.ts";
import { pathIdentity, toPosixPath } from "./path-utils.ts";

interface CacheFileShape {
  roots: string[];
  projects: Omit<Project, "identity">[];
}

const RUNTIME_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".angular", ".cache", ".next"]);

export function detectProjectType(projectPath: string, enabledTypes: ProjectType[]): [ProjectType, string] | null {
  for (const projectType of enabledTypes) {
    const marker = PROJECT_MARKERS[projectType];
    if (fs.existsSync(path.join(projectPath, marker))) {
      return [projectType, marker];
    }
  }
  return null;
}

export function detectProjectTypesRecursive(projectPath: string, enabledTypes: ProjectType[]): ProjectType[] {
  const found: ProjectType[] = [];
  const remaining = new Set(enabledTypes);

  walkProjectTree(projectPath, (_dir, filenames) => {
    const fileSet = new Set(filenames);
    for (const projectType of enabledTypes) {
      if (!remaining.has(projectType)) {
        continue;
      }
      const marker = PROJECT_MARKERS[projectType];
      if (fileSet.has(marker)) {
        found.push(projectType);
        remaining.delete(projectType);
      }
    }
    return remaining.size > 0;
  });

  return found;
}

export function discoverProjects(config: AppConfig, roots?: string[], refresh = false): Project[] {
  if (refresh || !fs.existsSync(config.discovery.cacheFile)) {
    return sortProjects(rebuildProjectCache(config, roots));
  }
  return sortProjects(loadProjectCache(config));
}

export function rebuildProjectCache(config: AppConfig, roots?: string[]): Project[] {
  const scanRoots = roots ?? config.discovery.roots;
  const projects = new Map<string, Project>();
  for (const root of scanRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    const children = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }
      const childPath = path.resolve(root, child.name);
      if (shouldSkipPath(childPath, config) || !isIncluded(childPath, config)) {
        continue;
      }
      const detectedTypes = detectProjectTypesRecursive(childPath, config.discovery.projectTypes);
      if (detectedTypes.length === 0) {
        continue;
      }
      const projectType = detectedTypes[0];
      const marker = PROJECT_MARKERS[projectType];
      const project: Project = {
        name: child.name,
        path: childPath,
        projectType,
        marker,
        projectTypes: detectedTypes,
        identity: pathIdentity(child.name, childPath),
      };
      projects.set(project.identity, project);
    }
  }
  writeProjectCache(config, [...projects.values()]);
  return [...projects.values()];
}

export function loadProjectCache(config: AppConfig): Project[] {
  const raw = JSON.parse(fs.readFileSync(config.discovery.cacheFile, "utf8")) as CacheFileShape;
  const projects: Project[] = [];
  for (const item of raw.projects ?? []) {
    const resolved = path.resolve(item.path);
    const detected = detectProjectType(resolved, config.discovery.projectTypes);
    if (!detected) {
      continue;
    }
    projects.push({
      ...item,
      path: resolved,
      projectTypes: item.projectTypes?.length ? item.projectTypes : detectProjectTypesRecursive(resolved, config.discovery.projectTypes),
      identity: pathIdentity(item.name, resolved),
    });
  }
  return projects;
}

export function discoverExplicitProjects(config: AppConfig, pathsToInspect: string[]): Project[] {
  const projects: Project[] = [];
  for (const item of pathsToInspect) {
    const resolved = path.resolve(item);
    const detected = detectProjectType(resolved, config.discovery.projectTypes);
    if (!detected) {
      continue;
    }
    const [projectType, marker] = detected;
    projects.push({
      name: path.basename(resolved),
      path: resolved,
      projectType,
      marker,
      projectTypes: detectProjectTypesRecursive(resolved, config.discovery.projectTypes),
      identity: pathIdentity(path.basename(resolved), resolved),
    });
  }
  return sortProjects(projects);
}

export function filterProjects(projects: Project[], projectType?: string, nameFilter?: string): Project[] {
  let filtered = projects;
  if (projectType) {
    filtered = filtered.filter((project) => project.projectTypes.includes(projectType as ProjectType));
  }
  if (nameFilter) {
    const lowered = nameFilter.toLowerCase();
    filtered = filtered.filter((project) => {
      const projectPath = toPosixPath(project.path).toLowerCase();
      return project.name.toLowerCase().includes(lowered) || projectPath.includes(lowered);
    });
  }
  return filtered;
}

function writeProjectCache(config: AppConfig, projects: Project[]): void {
  fs.mkdirSync(path.dirname(config.discovery.cacheFile), { recursive: true });
  const payload: CacheFileShape = {
    roots: [...config.discovery.roots],
    projects: sortProjects(projects).map(({ identity: _identity, ...project }) => project),
  };
  fs.writeFileSync(config.discovery.cacheFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return toPosixPath(left.path).localeCompare(toPosixPath(right.path));
  });
}

function isIncluded(value: string, config: AppConfig): boolean {
  if (config.discovery.includePatterns.length === 0) {
    return true;
  }
  const posix = toPosixPath(value);
  return config.discovery.includePatterns.some((pattern) => posix.includes(pattern.replace("**/", "")));
}

function shouldSkipPath(value: string, config: AppConfig): boolean {
  const posix = toPosixPath(value);
  return config.discovery.excludePatterns.some((pattern) => posix.includes(pattern.replace("**/", "")));
}

function walkProjectTree(
  root: string,
  visitor: (currentDir: string, filenames: string[]) => boolean,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const directories: string[] = [];
    const filenames: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!RUNTIME_SKIP_DIRS.has(entry.name)) {
          directories.push(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        filenames.push(entry.name);
      }
    }
    const shouldContinue = visitor(currentDir, filenames);
    if (!shouldContinue) {
      return;
    }
    directories.sort((a, b) => a.localeCompare(b)).reverse().forEach((directory) => stack.push(directory));
  }
}
