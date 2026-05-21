import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFavoriteProjectPaths, loadFavoriteScriptIds, toggleFavoriteProject, toggleFavoriteScript } from "../src/favorites.ts";
import type { AppConfig, Project, ScriptEntry } from "../src/models.ts";

test("favorites toggle persists project paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-favorites-"));
  const config: AppConfig = {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["node"],
      cacheFile: path.join(root, ".cache.json"),
    },
    scripts: {
      directory: path.join(root, "scripts"),
    },
    tui: {
      favoritesFile: path.join(root, ".favorites.json"),
      scriptStateFile: path.join(root, ".script-state.json"),
      scheduledJobsFile: path.join(root, ".scheduled-jobs.json"),
      projectRows: 10,
      summaryRows: 6,
      projectSort: "alphabetical",
    },
  };
  const project: Project = {
    name: "frontend",
    path: path.join(root, "frontend"),
    projectType: "node",
    marker: "package.json",
    projectTypes: ["node"],
    identity: `frontend:${path.join(root, "frontend")}`,
  };

  const once = toggleFavoriteProject(config, [], project);
  assert.deepEqual(once, [project.path]);
  assert.deepEqual(loadFavoriteProjectPaths(config), [project.path]);

  const twice = toggleFavoriteProject(config, once, project);
  assert.deepEqual(twice, []);
  assert.deepEqual(loadFavoriteProjectPaths(config), []);
});

test("favorites persist script ids alongside project paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-script-favorites-"));
  const config: AppConfig = {
    configPath: path.join(root, "devtools.toml"),
    discovery: {
      roots: [root],
      includePatterns: [],
      excludePatterns: [],
      projectTypes: ["node"],
      cacheFile: path.join(root, ".cache.json"),
    },
    scripts: {
      directory: path.join(root, "scripts"),
    },
    tui: {
      favoritesFile: path.join(root, ".favorites.json"),
      scriptStateFile: path.join(root, ".script-state.json"),
      scheduledJobsFile: path.join(root, ".scheduled-jobs.json"),
      projectRows: 10,
      summaryRows: 6,
      projectSort: "alphabetical",
    },
  };
  const project: Project = {
    name: "frontend",
    path: path.join(root, "frontend"),
    projectType: "node",
    marker: "package.json",
    projectTypes: ["node"],
    identity: `frontend:${path.join(root, "frontend")}`,
  };
  const script: ScriptEntry = {
    scriptId: "group_git_update",
    name: "Git Update",
    description: "",
    projectTypes: ["node"],
    childScriptIds: ["git_pull"],
    kind: "group",
  };

  const favoriteProjects = toggleFavoriteProject(config, [], project);
  const favoriteScripts = toggleFavoriteScript(config, [], script);

  assert.deepEqual(loadFavoriteProjectPaths(config), [project.path]);
  assert.deepEqual(loadFavoriteScriptIds(config), ["group_git_update"]);

  const clearedScripts = toggleFavoriteScript(config, favoriteScripts, script);
  assert.deepEqual(clearedScripts, []);
  assert.deepEqual(loadFavoriteProjectPaths(config), [project.path]);
  assert.deepEqual(loadFavoriteScriptIds(config), []);

  const clearedProjects = toggleFavoriteProject(config, favoriteProjects, project);
  assert.deepEqual(clearedProjects, []);
});
