import fs from "node:fs";

import type { DependencyTreeNode, ProjectFinding } from "./types.ts";

export function loadDependencyTrees(treeFilePath: string, findings: ProjectFinding[]): ProjectFinding[] {
  if (!fs.existsSync(treeFilePath)) {
    return findings;
  }
  const root = parseDependencyTree(fs.readFileSync(treeFilePath, "utf8"));
  return findings.map((finding) => ({
    ...finding,
    dependencyTrees: renderMatchingDependencyTrees(root, finding.dependency),
  }));
}

export function parseDependencyTree(raw: string): DependencyTreeNode | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[INFO\]\s*/, "").trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let root: DependencyTreeNode | undefined;
  const stack: Array<{ depth: number; node: DependencyTreeNode }> = [];

  for (const line of lines) {
    const depth = computeDepth(line);
    const node = parseTreeNode(line);
    if (!root) {
      root = node;
      stack.push({ depth, node });
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.node ?? root;
    parent.children.push(node);
    stack.push({ depth, node });
  }

  return root;
}

export function renderMatchingDependencyTrees(root: DependencyTreeNode | undefined, dependencyLabel: string): string[] {
  if (!root) {
    return [];
  }
  const target = parseFindingLabel(dependencyLabel);
  const paths = findMatchingPaths(root, target.ga, target.version);
  return paths.map((path) => renderPath(path));
}

function findMatchingPaths(node: DependencyTreeNode, ga: string, version?: string, trail: DependencyTreeNode[] = []): DependencyTreeNode[][] {
  const nextTrail = [...trail, node];
  const matches = node.ga === ga && (!version || node.version === version);
  const result: DependencyTreeNode[][] = matches ? [nextTrail] : [];
  for (const child of node.children) {
    result.push(...findMatchingPaths(child, ga, version, nextTrail));
  }
  return result;
}

function renderPath(path: DependencyTreeNode[]): string {
  return path.map((node, index) => {
    if (index === 0) {
      return node.display;
    }
    const isLast = index === path.length - 1;
    const parentPrefix = "  ".repeat(index - 1);
    return `${parentPrefix}${isLast ? "\\-" : "+-"} ${node.display}`;
  }).join("\n");
}

function parseTreeNode(line: string): DependencyTreeNode {
  const normalized = line.replace(/^(\|  |   |\+- |\\- )+/, "");
  const parts = normalized.split(":");
  const groupId = parts[0] ?? "unknown";
  const artifactId = parts[1] ?? "unknown";
  const version = parts[3] ?? parts[2] ?? undefined;
  return {
    display: version ? `${groupId}:${artifactId}:${version}` : `${groupId}:${artifactId}`,
    ga: `${groupId}:${artifactId}`,
    version,
    children: [],
  };
}

function computeDepth(line: string): number {
  const match = line.match(/^((?:\|  |   )*)(?:\+- |\\- )?/);
  const prefix = match?.[1] ?? "";
  return prefix.length / 3;
}

function parseFindingLabel(label: string): { ga: string; version?: string } {
  const pkgMatch = label.match(/^pkg:maven\/([^/]+)\/([^@]+)@(.+)$/);
  if (pkgMatch) {
    return {
      ga: `${pkgMatch[1]}:${pkgMatch[2]}`,
      version: pkgMatch[3],
    };
  }
  const colonParts = label.split(":");
  if (colonParts.length >= 3) {
    return {
      ga: `${colonParts[0]}:${colonParts[1]}`,
      version: colonParts[2],
    };
  }
  return { ga: label };
}
