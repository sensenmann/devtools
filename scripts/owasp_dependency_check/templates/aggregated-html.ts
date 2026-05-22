import { pathToFileURL } from "node:url";

import type { ProjectSummary } from "../lib/types.ts";

export function generateAggregatedHtml(summaries: ProjectSummary[]): string {
  const generatedAt = new Date().toISOString();
  const summaryRows = summaries.map((summary) => `
      <tr>
        <td>${escapeHtml(summary.projectName)}</td>
        <td>${escapeHtml(summary.success ? "ok" : "failed")}</td>
        <td>${summary.vulnerableDependencyCount}</td>
        <td><a href="${pathToFileURL(summary.htmlReportPath).href}">project report</a></td>
      </tr>`).join("");
  const findingSections = summaries.map((summary) => {
    const rows = summary.findings.length === 0
      ? `
        <tr class="empty-row">
          <td colspan="4">No vulnerable dependencies found.</td>
        </tr>`
      : summary.findings.map((finding) => `
        <tr>
          <td>${renderDependencyLabel(finding.dependency)}</td>
          <td><span class="severity severity-${finding.highestSeverity.toLowerCase()}">${escapeHtml(finding.highestSeverity)}</span></td>
          <td>${renderVulnerabilityList(finding.vulnerabilities)}</td>
          <td>${renderTrees(finding.dependencyTrees ?? [])}</td>
        </tr>`).join("");

    return `
      <section class="project-findings">
        <h3>${escapeHtml(summary.projectName)}</h3>
        <table>
          <thead>
            <tr>
              <th>Dependency</th>
              <th>Severity</th>
              <th>CVEs</th>
              <th>Tree</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="project-report-link"><a href="${pathToFileURL(summary.htmlReportPath).href}">Open project report</a></p>
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OWASP Dependency Check Summary</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #222; }
      h1, h2 { margin-bottom: 8px; }
      p { color: #555; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
      th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f3f3f3; }
      tr:nth-child(even) td { background: #fafafa; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .project-findings { margin-bottom: 32px; }
      .project-report-link { margin-top: 8px; }
      .severity { display: inline-block; min-width: 72px; font-weight: 700; }
      .severity-critical { color: #9f1239; }
      .severity-high { color: #b91c1c; }
      .severity-medium { color: #c2410c; }
      .severity-low { color: #15803d; }
      .severity-info, .severity-unknown { color: #475569; }
      .vulnerability-link { font-weight: 600; }
      .tree-stack { display: grid; gap: 8px; }
      .tree-box { padding: 0; }
      .tree-line { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; line-height: 1.45; font-size: 0.9rem; }
      .tree-branch { color: #64748b; }
      .tree-package { color: #0f172a; }
      .tree-version { color: #1d4ed8; }
      .tree-line.is-target .tree-package, .tree-line.is-target .tree-version { color: #b91c1c; }
      .vulnerability-list { margin: 0; padding-left: 18px; }
      .vulnerability-list li { margin: 0 0 4px; }
      .empty-row td { color: #64748b; font-style: italic; }
    </style>
  </head>
  <body>
    <h1>OWASP Dependency Check Summary</h1>
    <p>Generated at <code>${escapeHtml(generatedAt)}</code></p>
    <h2>Projects</h2>
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th>Status</th>
          <th>Vulnerable dependencies</th>
          <th>Report</th>
        </tr>
      </thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <h2>Findings</h2>
    ${findingSections}
  </body>
</html>
`;
}

function renderDependencyLabel(dependency: string): string {
  const match = dependency.match(/^pkg:maven\/([^/]+)\/([^@]+)@(.+)$/);
  if (match) {
    const packageName = `${match[1]}:${match[2]}`;
    return `${escapeHtml(packageName)} <span class="tree-version">(${escapeHtml(match[3] ?? "")})</span>`;
  }
  const colonParts = dependency.split(":");
  if (colonParts.length >= 3) {
    const version = colonParts.pop() ?? "";
    return `${escapeHtml(colonParts.join(":"))} <span class="tree-version">(${escapeHtml(version)})</span>`;
  }
  return escapeHtml(dependency);
}

function renderVulnerabilityList(vulnerabilities: Array<{ vulnerabilityId: string; vulnerabilityUrl?: string; severity: string }>): string {
  return `<ul class="vulnerability-list">${vulnerabilities.map((vulnerability) => {
    const label = escapeHtml(vulnerability.vulnerabilityId);
    const content = vulnerability.vulnerabilityUrl
      ? `<a class="vulnerability-link" href="${escapeHtml(vulnerability.vulnerabilityUrl)}">${label}</a>`
      : label;
    return `<li>${content}</li>`;
  }).join("")}</ul>`;
}

function renderTrees(trees: string[]): string {
  if (trees.length === 0) {
    return "No matching dependency tree found.";
  }
  return `<div class="tree-stack">${trees.map((tree) => renderTree(tree)).join("")}</div>`;
}

function renderTree(tree: string): string {
  const treeLines = tree.split("\n").filter((line) => line.length > 0);
  const lines = treeLines.map((line, index) => renderTreeLine(line, index === treeLines.length - 1)).join("");
  return `<div class="tree-box">${lines}</div>`;
}

function renderTreeLine(line: string, isTarget: boolean): string {
  const match = line.match(/^(\s*(?:\+\- |\\\- )?)(.+)$/);
  const prefix = match?.[1] ?? "";
  const payload = match?.[2] ?? line;
  const parts = payload.split(":");
  const cssClass = isTarget ? "tree-line is-target" : "tree-line";
  if (parts.length >= 3) {
    const version = parts.pop() ?? "";
    const packageName = parts.join(":");
    return `<div class="${cssClass}"><span class="tree-branch">${escapeHtml(prefix)}</span><span class="tree-package">${escapeHtml(packageName)}</span> <span class="tree-version">(${escapeHtml(version)})</span></div>`;
  }
  return `<div class="${cssClass}"><span class="tree-branch">${escapeHtml(prefix)}</span><span class="tree-package">${escapeHtml(payload)}</span></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
