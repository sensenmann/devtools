import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectProjectTypesRecursive, discoverExplicitProjects, discoverProjects, rebuildProjectCache } from "../src/discovery.ts";
import type { AppConfig } from "../src/models.ts";

function makeConfig(root: string): AppConfig {
  return {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["maven", "node", "python"],
      cacheFile: path.join(root, ".cache.json"),
    },
    scripts: {
      directory: path.join(root, "scripts"),
    },
  };
}

test("discovery detects top-level projects and recursive capabilities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-discovery-"));
  fs.mkdirSync(path.join(root, "java-app"));
  fs.writeFileSync(path.join(root, "java-app", "pom.xml"), "<project />", "utf8");
  fs.mkdirSync(path.join(root, "web-app"));
  fs.writeFileSync(path.join(root, "web-app", "package.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "py-app"));
  fs.writeFileSync(path.join(root, "py-app", "pyproject.toml"), "[project]\nname='x'", "utf8");
  fs.mkdirSync(path.join(root, "container", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "container", "nested", "package.json"), "{}", "utf8");

  const projects = rebuildProjectCache(makeConfig(root));
  assert.deepEqual(projects.map((item) => item.projectType), ["node", "maven", "python", "node"]);
});

test("discovery detects multiple capabilities in one top-level project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-mixed-"));
  fs.mkdirSync(path.join(root, "mixed", "ui"), { recursive: true });
  fs.writeFileSync(path.join(root, "mixed", "pom.xml"), "<project/>", "utf8");
  fs.writeFileSync(path.join(root, "mixed", "ui", "package.json"), "{}", "utf8");

  const projects = rebuildProjectCache(makeConfig(root));
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0]?.projectTypes, ["maven", "node"]);
});

test("discovery loads explicit projects and ignores unknown paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-explicit-"));
  fs.mkdirSync(path.join(root, "plain"));
  fs.mkdirSync(path.join(root, "py-app"));
  fs.writeFileSync(path.join(root, "py-app", "pyproject.toml"), "[project]\nname='x'", "utf8");
  const projects = discoverExplicitProjects(makeConfig(root), [path.join(root, "plain"), path.join(root, "py-app")]);
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0]?.projectTypes, ["python"]);
});

test("discovery uses cache and revalidates paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-cache-"));
  fs.mkdirSync(path.join(root, "py-app"));
  fs.writeFileSync(path.join(root, "py-app", "pyproject.toml"), "[project]\nname='x'", "utf8");
  const config = makeConfig(root);
  rebuildProjectCache(config);
  fs.unlinkSync(path.join(root, "py-app", "pyproject.toml"));
  assert.equal(discoverProjects(config, undefined, false).length, 0);
});

test("discovery detects recursive types directly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-recursive-"));
  fs.mkdirSync(path.join(root, "app", "frontend"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "frontend", "package.json"), "{}", "utf8");
  assert.deepEqual(detectProjectTypesRecursive(path.join(root, "app"), ["maven", "node", "python"]), ["node"]);
});
