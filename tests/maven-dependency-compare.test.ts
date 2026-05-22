import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { buildCompareReport, selectEffectiveProjectRoot } from "../scripts/maven_dependency_compare/lib/pom.ts";
import { parseXmlDocument, serializeXmlDocument } from "../scripts/maven_dependency_compare/lib/xml.ts";
import { compareVersions } from "../scripts/maven_dependency_compare/lib/version.ts";
import { renderReportPage } from "../scripts/maven_dependency_compare/lib/report-html.ts";
import { startCompareServer } from "../scripts/maven_dependency_compare/server.ts";

test("maven dependency compare serializes simple XML mutations", () => {
  const document = parseXmlDocument(`
    <project>
      <properties>
        <demo.version>1.2.3</demo.version>
      </properties>
    </project>
  `);
  const serialized = serializeXmlDocument(document);
  assert.match(serialized, /<demo\.version>1\.2\.3<\/demo\.version>/);
});

test("maven dependency compare version ordering prefers higher patch versions", () => {
  assert.ok(compareVersions("2.25.4", "2.25.3") > 0);
  assert.ok(compareVersions("3.0.0", "2.99.9") > 0);
  assert.equal(compareVersions("2.25.4", "2.25.4"), 0);
});

test("maven dependency compare report highlights outdated and highest cells", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.0.0",
          effectiveVersion: "1.0.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
    {
      project: {
        name: "beta",
        path: "/tmp/beta",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "beta:/tmp/beta",
      },
      pomPath: "/tmp/beta/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.1.0",
          effectiveVersion: "1.1.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
  ]);

  const row = report.rows[0]!;
  assert.equal(row.highestVersion, "1.1.0");
  assert.equal(row.cells[0]?.isOutdated, true);
  assert.equal(row.cells[1]?.isHighest, true);
  assert.equal(row.cells[0]?.adoptHighestAvailable, true);
  assert.equal(row.cells[1]?.adoptHighestAvailable, false);
  assert.equal(row.cells[0]?.displayVersion, "1.0.0");
});

test("maven dependency compare uses resolved property values for display and comparison", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["direct:org.mapstruct:mapstruct", {
          rowId: "direct:org.mapstruct:mapstruct",
          kind: "direct",
          groupId: "org.mapstruct",
          artifactId: "mapstruct",
          dependencyLabel: "org.mapstruct:mapstruct",
          rawVersion: "${org.mapstruct.version}",
          effectiveVersion: "${org.mapstruct.version}",
          propertyName: "org.mapstruct.version",
          propertyValue: "1.6.3",
          hasLocalPropertyOverride: true,
        }],
      ]),
    },
    {
      project: {
        name: "beta",
        path: "/tmp/beta",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "beta:/tmp/beta",
      },
      pomPath: "/tmp/beta/pom.xml",
      rows: new Map([
        ["direct:org.mapstruct:mapstruct", {
          rowId: "direct:org.mapstruct:mapstruct",
          kind: "direct",
          groupId: "org.mapstruct",
          artifactId: "mapstruct",
          dependencyLabel: "org.mapstruct:mapstruct",
          rawVersion: "1.6.2",
          effectiveVersion: "1.6.2",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
  ]);

  const row = report.rows[0]!;
  assert.equal(row.highestVersion, "1.6.3");
  assert.equal(row.cells[0]?.displayVersion, "1.6.3");
  assert.equal(row.cells[0]?.isHighest, true);
  assert.equal(row.cells[1]?.isOutdated, true);
});

test("maven dependency compare surfaces newer external dependency updates when no selected project uses them yet", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.0.0",
          effectiveVersion: "1.0.0",
          availableUpdateVersion: "2.0.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
    {
      project: {
        name: "beta",
        path: "/tmp/beta",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "beta:/tmp/beta",
      },
      pomPath: "/tmp/beta/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.1.0",
          effectiveVersion: "1.1.0",
          availableUpdateVersion: "2.0.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
  ]);

  const row = report.rows[0]!;
  assert.equal(row.availableUpdateVersion, "2.0.0");
  assert.equal(row.cells[0]?.showAvailableUpdateVersion, true);
  assert.equal(row.cells[1]?.showAvailableUpdateVersion, true);
});

test("maven dependency compare hides external dependency updates when a selected project already uses that version", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.0.0",
          effectiveVersion: "1.0.0",
          availableUpdateVersion: "1.2.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
    {
      project: {
        name: "beta",
        path: "/tmp/beta",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "beta:/tmp/beta",
      },
      pomPath: "/tmp/beta/pom.xml",
      rows: new Map([
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.2.0",
          effectiveVersion: "1.2.0",
          availableUpdateVersion: "1.2.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
  ]);

  const row = report.rows[0]!;
  assert.equal(row.availableUpdateVersion, undefined);
  assert.equal(row.cells[0]?.showAvailableUpdateVersion, false);
  assert.equal(row.cells[1]?.showAvailableUpdateVersion, false);
});

test("maven dependency compare sorts override rows before managed and direct rows", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["override:log4j2.version", {
          rowId: "override:log4j2.version",
          kind: "override",
          groupId: "__override__",
          artifactId: "log4j2.version",
          dependencyLabel: "$log4j2.version",
          rawVersion: "2.25.3",
          effectiveVersion: "2.25.3",
          propertyName: "log4j2.version",
          propertyValue: "2.25.3",
          providerVersion: "2.25.2",
          hasLocalPropertyOverride: true,
          overrideTargets: [{
            rowId: "managed:org.apache.logging.log4j:log4j-api",
            kind: "managed",
            groupId: "org.apache.logging.log4j",
            artifactId: "log4j-api",
            dependencyLabel: "org.apache.logging.log4j:log4j-api",
            providerVersion: "2.25.2",
          }],
        }],
        ["managed:org.example:demo", {
          rowId: "managed:org.example:demo",
          kind: "managed",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.0.0",
          effectiveVersion: "1.0.0",
          hasLocalPropertyOverride: false,
        }],
        ["direct:org.example:demo", {
          rowId: "direct:org.example:demo",
          kind: "direct",
          groupId: "org.example",
          artifactId: "demo",
          dependencyLabel: "org.example:demo",
          rawVersion: "1.0.0",
          effectiveVersion: "1.0.0",
          hasLocalPropertyOverride: false,
        }],
      ]),
    },
  ]);

  assert.deepEqual(report.rows.map((row) => row.kind), ["override", "managed", "direct"]);
  assert.equal(report.rows[0]?.label, "$log4j2.version");
  assert.equal(report.rows[0]?.cells[0]?.removeOverrideAvailable, true);
});

test("maven dependency compare marks missing override properties as warnings in other projects", () => {
  const report = buildCompareReport([
    {
      project: {
        name: "alpha",
        path: "/tmp/alpha",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "alpha:/tmp/alpha",
      },
      pomPath: "/tmp/alpha/pom.xml",
      rows: new Map([
        ["override:tomcat.version", {
          rowId: "override:tomcat.version",
          kind: "override",
          groupId: "__override__",
          artifactId: "tomcat.version",
          dependencyLabel: "$tomcat.version",
          rawVersion: "11.0.21",
          effectiveVersion: "11.0.21",
          propertyName: "tomcat.version",
          propertyValue: "11.0.21",
          providerVersion: "10.1.54",
          hasLocalPropertyOverride: true,
          overrideTargets: [{
            rowId: "managed:org.apache.tomcat.embed:tomcat-embed-core",
            kind: "managed",
            groupId: "org.apache.tomcat.embed",
            artifactId: "tomcat-embed-core",
            dependencyLabel: "org.apache.tomcat.embed:tomcat-embed-core",
            providerVersion: "10.1.54",
          }],
        }],
      ]),
    },
    {
      project: {
        name: "beta",
        path: "/tmp/beta",
        projectType: "maven",
        marker: "pom.xml",
        projectTypes: ["maven"],
        identity: "beta:/tmp/beta",
      },
      pomPath: "/tmp/beta/pom.xml",
      rows: new Map(),
    },
  ]);
  const row = report.rows[0]!;
  assert.equal(row.cells[1]?.present, false);
  assert.equal(row.cells[1]?.isMissingOverrideWarning, true);
});

test("maven dependency compare selects the matching project from reactor effective pom output", () => {
  const root = parseXmlDocument(`
    <projects>
      <project>
        <groupId>org.example</groupId>
        <artifactId>aggregator</artifactId>
      </project>
      <project>
        <groupId>org.example</groupId>
        <artifactId>target-module</artifactId>
      </project>
    </projects>
  `);
  const selected = selectEffectiveProjectRoot(root, {
    groupId: "org.example",
    artifactId: "target-module",
  });
  assert.match(serializeXmlDocument(selected), /<artifactId>target-module<\/artifactId>/);
});

test("maven dependency compare report page contains interactive hooks", () => {
  const html = renderReportPage();
  assert.match(html, /Maven Dependency Compare/);
  assert.match(html, /\/api\/report/);
  assert.match(html, /Show only differences/);
  assert.match(html, /Hide Version Updates/);
  assert.match(html, /bootstrap@5\.3\.3/);
  assert.match(html, /statusModal/);
  assert.match(html, /Adopt highest for all/);
  assert.match(html, /Remove override for all/);
  assert.match(html, /Version konnte nicht aufgelöst werden/);
  assert.match(html, /wird aber erst bei echter Verwendung wirksam/);
  assert.match(html, /lokale Property, die parent-\/BOM-gebündelte Versionen effektiv überschreibt/);
  assert.match(html, /remove-project-btn/);
  assert.match(html, /hideProject/);
  assert.match(html, /targetProjectPaths/);
  assert.match(html, /property fehlt/);
  assert.match(html, /Adopt property/);
  assert.match(html, /Adopt properties for all/);
  assert.match(html, /version-link/);
  assert.match(html, /dependency-link/);
  assert.match(html, /badge-update/);
  assert.match(html, /mvnrepository\.com\/artifact/);
});

test("maven dependency compare server exposes a local url and closes cleanly", async () => {
  const session = await startCompareServer({
    projectPaths: [],
    openBrowser: false,
  });
  assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await session.close();
  await session.closed;
});

test("maven dependency compare server closes promptly even with keep-alive clients", async () => {
  const session = await startCompareServer({
    projectPaths: [],
    openBrowser: false,
  });
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    const request = http.get(session.url, { agent }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
  });
  await session.close();
  await session.closed;
  agent.destroy();
});
