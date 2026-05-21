import test from "node:test";
import assert from "node:assert/strict";

import { sortScriptEntriesForFavorites } from "../src/tui.ts";
import type { ScriptEntry } from "../src/models.ts";

test("script favorites keep grouped scripts inside their group block", () => {
  const entries: ScriptEntry[] = [
    {
      scriptId: "group_dependency_update",
      name: "Dependency Update",
      description: "",
      projectTypes: ["maven", "node"],
      childScriptIds: ["maven_dependency_update", "node_dependency_update"],
      kind: "group",
    },
    {
      scriptId: "maven_dependency_update",
      name: "Maven dependency update",
      description: "",
      projectTypes: ["maven"],
      entry: "mavenDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Dependency Update",
    },
    {
      scriptId: "node_dependency_update",
      name: "Node dependency update",
      description: "",
      projectTypes: ["node"],
      entry: "nodeDependencyUpdate",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Dependency Update",
    },
    {
      scriptId: "maven_clean_install",
      name: "Maven clean install",
      description: "",
      projectTypes: ["maven"],
      entry: "mavenCleanInstall",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
  ];

  const sorted = sortScriptEntriesForFavorites(entries, ["node_dependency_update"]);
  assert.deepEqual(sorted.map((entry) => entry.scriptId), [
    "group_dependency_update",
    "maven_dependency_update",
    "node_dependency_update",
    "maven_clean_install",
  ]);
});

test("favorite groups move the whole group block to the top", () => {
  const entries: ScriptEntry[] = [
    {
      scriptId: "maven_clean_install",
      name: "Maven clean install",
      description: "",
      projectTypes: ["maven"],
      entry: "mavenCleanInstall",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
    },
    {
      scriptId: "group_git_update",
      name: "Git Update",
      description: "",
      projectTypes: ["maven", "node", "python"],
      childScriptIds: ["git_pull", "git_pull_develop"],
      kind: "group",
    },
    {
      scriptId: "git_pull",
      name: "Git pull",
      description: "",
      projectTypes: ["maven", "node", "python"],
      entry: "gitPull",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Git Update",
    },
    {
      scriptId: "git_pull_develop",
      name: "Git merge develop",
      description: "",
      projectTypes: ["maven", "node", "python"],
      entry: "gitPullDevelop",
      directory: "",
      manifestPath: "",
      defaultArgs: {},
      group: "Git Update",
    },
  ];

  const sorted = sortScriptEntriesForFavorites(entries, ["group_git_update"]);
  assert.deepEqual(sorted.map((entry) => entry.scriptId), [
    "group_git_update",
    "git_pull",
    "git_pull_develop",
    "maven_clean_install",
  ]);
});
