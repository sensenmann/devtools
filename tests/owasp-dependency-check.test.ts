import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultOdcCacheDir,
  defaultOdcReportDir,
  loadOwaspDependencyCheckConfig,
} from "../scripts/owasp_dependency_check/lib/config.ts";
import { isDatabaseCurrent } from "../scripts/owasp_dependency_check/lib/database.ts";
import { formatNetworkError } from "../scripts/owasp_dependency_check/lib/network.ts";
import { buildOpenReportCommand } from "../scripts/owasp_dependency_check/lib/open-report.ts";
import { parseDependencyTree, renderMatchingDependencyTrees } from "../scripts/owasp_dependency_check/lib/dependency-tree.ts";
import { parseDependencyCheckJson } from "../scripts/owasp_dependency_check/lib/reporting.ts";
import { generateAggregatedHtml } from "../scripts/owasp_dependency_check/templates/aggregated-html.ts";
import { buildOwaspCommand } from "../scripts/owasp_dependency_check/lib/command.ts";

test("owasp config loader resolves explicit overrides relative to the script directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-owasp-config-"));
  fs.writeFileSync(
    path.join(root, "config.toml"),
    [
      'db_url = "https://example.internal/odc/odc.v12n.mv.db"',
      'cache_dir = "./cache"',
      'report_dir = "./reports"',
      "ignore_ssl = true",
      "open_report = true",
    ].join("\n"),
    "utf8",
  );

  const config = loadOwaspDependencyCheckConfig(root);
  assert.equal(config.dbUrl, "https://example.internal/odc/odc.v12n.mv.db");
  assert.equal(config.cacheDir, path.join(root, "cache"));
  assert.equal(config.reportDir, path.join(root, "reports"));
  assert.equal(config.ignoreSsl, true);
  assert.equal(config.openReport, true);
});

test("owasp default cache and report directories resolve to a user cache area", () => {
  assert.ok(defaultOdcCacheDir().includes(`devtools${path.sep}odc`));
  assert.ok(defaultOdcReportDir().includes(`devtools${path.sep}odc-reports`));
});

test("owasp report opening defaults to enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-owasp-open-default-"));
  fs.writeFileSync(
    path.join(root, "config.toml"),
    'db_url = "https://example.internal/odc/odc.v12n.mv.db"\n',
    "utf8",
  );

  const config = loadOwaspDependencyCheckConfig(root);
  assert.equal(config.openReport, true);
});

test("owasp command supports quick/full mode and adds the suppression flag only when the file exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-owasp-command-"));
  const baseCommand = buildOwaspCommand("mvn", root, "/tmp/odc-cache", "full");
  assert.deepEqual(baseCommand.slice(0, 4), ["mvn", "clean", "install", "org.owasp:dependency-check-maven:12.2.2:aggregate"]);
  assert.ok(!baseCommand.some((part) => part.includes("suppressionFiles")));

  const quickCommand = buildOwaspCommand("mvn", root, "/tmp/odc-cache", "quick");
  assert.deepEqual(quickCommand.slice(0, 2), ["mvn", "org.owasp:dependency-check-maven:12.2.2:aggregate"]);
  assert.ok(!quickCommand.includes("clean"));
  assert.ok(!quickCommand.includes("install"));

  fs.writeFileSync(path.join(root, "dependency-check-suppressions.xml"), "<xml />", "utf8");
  const suppressedCommand = buildOwaspCommand("mvn", root, "/tmp/odc-cache", "full");
  assert.ok(suppressedCommand.includes("-DsuppressionFiles=./dependency-check-suppressions.xml"));
});

test("owasp database freshness prefers matching etag or last-modified", () => {
  assert.equal(isDatabaseCurrent({ etag: '"abc"' }, { etag: '"abc"' }), true);
  assert.equal(isDatabaseCurrent({ lastModified: "Thu, 22 May 2026 10:00:00 GMT" }, { lastModified: "Thu, 22 May 2026 10:00:00 GMT" }), true);
  assert.equal(isDatabaseCurrent({ etag: '"abc"' }, { etag: '"def"' }), false);
});

test("owasp network errors include ssl and proxy diagnostics", () => {
  const error = Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  const message = formatNetworkError("Database download", "https://example.internal/file", true, error);
  assert.match(message, /ignore_ssl=true/);
  assert.match(message, /HTTPS_PROXY=/);
  assert.match(message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
});

test("owasp report opener uses platform default browser commands", () => {
  assert.deepEqual(buildOpenReportCommand("/tmp/report.html", "darwin"), ["open", "/tmp/report.html"]);
  assert.deepEqual(buildOpenReportCommand("C:\\temp\\report.html", "win32"), ["cmd", "/c", "start", "", "C:\\temp\\report.html"]);
  assert.deepEqual(buildOpenReportCommand("/tmp/report.html", "linux"), ["xdg-open", "/tmp/report.html"]);
});

test("owasp JSON parsing extracts vulnerable dependencies and highest severity", () => {
  const parsed = parseDependencyCheckJson(JSON.stringify({
    dependencies: [
      {
        fileName: "commons-io-2.6.jar",
        vulnerabilities: [
          { name: "CVE-2026-1001", severity: "LOW" },
          { name: "CVE-2026-1002", severity: "HIGH" },
        ],
      },
      {
        packagePath: "pkg:maven/org.example/demo@1.0.0",
        vulnerabilities: [
          { name: "CVE-2026-1003", severity: "MEDIUM" },
        ],
      },
      {
        fileName: "safe.jar",
        vulnerabilities: [],
      },
    ],
  }));

  assert.equal(parsed.vulnerableDependencyCount, 2);
  assert.equal(parsed.vulnerabilityCount, 3);
  assert.equal(parsed.findings[0]?.highestSeverity, "HIGH");
  assert.equal(parsed.findings[0]?.vulnerabilities[0]?.vulnerabilityId, "CVE-2026-1002");
  assert.equal(parsed.findings[0]?.vulnerabilities[0]?.vulnerabilityUrl, "https://nvd.nist.gov/vuln/detail/CVE-2026-1002");
  assert.equal(parsed.findings[0]?.vulnerabilities[1]?.severity, "LOW");
  assert.ok(parsed.findings.some((finding) => /pkg:maven/.test(finding.dependency)));
});

test("owasp aggregated HTML includes project summary rows and report links", () => {
  const html = generateAggregatedHtml([
    {
      projectName: "alpha",
      projectPath: "/tmp/alpha",
      htmlReportPath: "/tmp/alpha/target/dependency-check/dependency-check-report.html",
      jsonReportPath: "/tmp/alpha/target/dependency-check/dependency-check-report.json",
      dependencyTreePath: "/tmp/alpha/target/dependency-check/dependency-tree.txt",
      success: true,
      message: "ok",
      vulnerableDependencyCount: 1,
      vulnerabilityCount: 2,
      findings: [
        {
          dependency: "pkg:maven/org.example/demo@1.0.0",
          highestSeverity: "CRITICAL",
          vulnerabilities: [
            {
              vulnerabilityId: "CVE-2026-1000",
              vulnerabilityUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1000",
              severity: "CRITICAL",
            },
            {
              vulnerabilityId: "CVE-2026-1001",
              vulnerabilityUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1001",
              severity: "HIGH",
            },
          ],
          dependencyTrees: ["org.example:app:1.0.0\n\\- org.example:demo:1.0.0"],
        },
      ],
    },
    {
      projectName: "beta",
      projectPath: "/tmp/beta",
      htmlReportPath: "/tmp/beta/target/dependency-check/dependency-check-report.html",
      jsonReportPath: "/tmp/beta/target/dependency-check/dependency-check-report.json",
      dependencyTreePath: "/tmp/beta/target/dependency-check/dependency-tree.txt",
      success: true,
      message: "ok",
      vulnerableDependencyCount: 0,
      vulnerabilityCount: 0,
      findings: [],
    },
  ]);

  assert.match(html, /OWASP Dependency Check Summary/);
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
  assert.match(html, /No vulnerable dependencies found/);
  assert.match(html, /<h3>alpha<\/h3>/);
  assert.match(html, /<section class="project-findings">[\s\S]*<h3>alpha<\/h3>[\s\S]*<th>Dependency<\/th>[\s\S]*<th>Severity<\/th>[\s\S]*<th>CVEs<\/th>[\s\S]*<th>Tree<\/th>/);
  assert.match(html, /CVE-2026-1000/);
  assert.match(html, /CVE-2026-1001/);
  assert.match(html, /https:\/\/nvd\.nist\.gov\/vuln\/detail\/CVE-2026-1000/);
  assert.match(html, /org\.example:demo/);
  assert.match(html, /\(1\.0\.0\)/);
  assert.doesNotMatch(html, /Show tree/);
  assert.doesNotMatch(html, /<details>/);
  assert.match(html, /tree-line is-target/);
  assert.match(html, /file:\/\/\/tmp\/alpha\/target\/dependency-check\/dependency-check-report\.html/);
});

test("owasp dependency trees render clean paths for matching package identifiers", () => {
  const root = parseDependencyTree([
    "[INFO] org.example:my-app:jar:1.0.0",
    "[INFO] +- org.springframework.boot:spring-boot-starter:jar:4.0.5:compile",
    "[INFO] |  \\- org.springframework.boot:spring-boot-starter-logging:jar:4.0.5:compile",
    "[INFO] |     +- org.apache.logging.log4j:log4j-to-slf4j:jar:2.25.3:compile",
    "[INFO] |     |  \\- org.apache.logging.log4j:log4j-api:jar:2.25.3:compile",
    "[INFO] |     \\- ch.qos.logback:logback-classic:jar:1.5.32:compile",
  ].join("\n"));

  const trees = renderMatchingDependencyTrees(root, "pkg:maven/org.apache.logging.log4j/log4j-api@2.25.3");
  assert.deepEqual(trees, [
    [
      "org.example:my-app:1.0.0",
      "+- org.springframework.boot:spring-boot-starter:4.0.5",
      "  +- org.springframework.boot:spring-boot-starter-logging:4.0.5",
      "    +- org.apache.logging.log4j:log4j-to-slf4j:2.25.3",
      "      \\- org.apache.logging.log4j:log4j-api:2.25.3",
    ].join("\n"),
  ]);
});
