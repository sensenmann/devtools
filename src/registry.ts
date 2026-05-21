import fs from "node:fs";
import path from "node:path";

import type { AppConfig, Project, ProjectType, ScriptDefinition, ScriptEntry, ScriptGroupDefinition } from "./models.ts";
import { parseSimpleToml } from "./toml.ts";

const MANIFEST_NAME = "manifest.toml";

interface RawManifest {
  id?: string;
  name?: string;
  description?: string;
  project_types?: ProjectType[];
  entry?: string;
  default_args?: Record<string, unknown>;
  group?: string;
  variant_key?: string;
  variant_values?: string[];
  variant_default?: string;
  variant_arg_values?: Record<string, unknown>;
}

export function loadScripts(config: AppConfig): ScriptDefinition[] {
  const scriptsDir = config.scripts.directory;
  if (!fs.existsSync(scriptsDir)) {
    return [];
  }
  const entries = fs.readdirSync(scriptsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const scripts: ScriptDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(scriptsDir, entry.name);
    const manifestPath = path.join(directory, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    scripts.push(loadManifest(directory, manifestPath));
  }
  return scripts;
}

export function applicableScripts(scripts: ScriptDefinition[], projects: Project[]): ScriptDefinition[] {
  if (projects.length === 0) {
    return scripts;
  }
  return scripts.filter((script) =>
    projects.some((project) => script.projectTypes.some((value) => project.projectTypes.includes(value))),
  );
}

export function buildScriptEntries(scripts: ScriptDefinition[]): ScriptEntry[] {
  const grouped = new Map<string, ScriptDefinition[]>();
  const ungrouped: ScriptDefinition[] = [];
  for (const script of scripts) {
    if (!script.group) {
      ungrouped.push(script);
      continue;
    }
    const bucket = grouped.get(script.group) ?? [];
    bucket.push(script);
    grouped.set(script.group, bucket);
  }

  const entries: ScriptEntry[] = [];
  for (const [groupName, groupScripts] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const sortedScripts = [...groupScripts].sort((left, right) => left.name.localeCompare(right.name));
    entries.push(buildGroupEntry(groupName, sortedScripts));
    entries.push(...sortedScripts);
  }
  entries.push(...ungrouped.sort((left, right) => left.name.localeCompare(right.name)));
  return entries;
}

export function getScriptById(scripts: ScriptDefinition[], scriptId: string): ScriptDefinition | undefined {
  return scripts.find((script) => script.scriptId === scriptId);
}

export function getScriptEntryById(scripts: ScriptDefinition[], scriptId: string): ScriptEntry | undefined {
  return buildScriptEntries(scripts).find((entry) => entry.scriptId === scriptId);
}

export function expandScriptEntry(entry: ScriptEntry, scripts: ScriptDefinition[]): ScriptDefinition[] {
  if (!isScriptGroup(entry)) {
    return [entry];
  }
  return entry.childScriptIds
    .map((childScriptId) => getScriptById(scripts, childScriptId))
    .filter((script): script is ScriptDefinition => Boolean(script));
}

function loadManifest(directory: string, manifestPath: string): ScriptDefinition {
  const raw = parseSimpleToml(fs.readFileSync(manifestPath, "utf8")) as RawManifest;
  const missing = ["id", "name", "description", "project_types", "entry"].filter((key) => !(key in raw));
  if (missing.length > 0) {
    throw new Error(`Missing fields in ${manifestPath}: ${missing.join(", ")}`);
  }
  return {
    scriptId: String(raw.id),
    name: String(raw.name),
    description: String(raw.description),
    projectTypes: [...(raw.project_types ?? [])],
    entry: String(raw.entry),
    directory,
    manifestPath,
    defaultArgs: { ...(raw.default_args ?? {}) },
    group: raw.group ? String(raw.group) : undefined,
    variant: buildVariantDefinition(raw),
  };
}

function buildVariantDefinition(raw: RawManifest) {
  if (!raw.variant_key || !raw.variant_values?.length || !raw.variant_default) {
    return undefined;
  }
  return {
    argKey: String(raw.variant_key),
    values: [...raw.variant_values],
    defaultValue: String(raw.variant_default),
    argValues: { ...(raw.variant_arg_values ?? {}) },
  };
}

function buildGroupEntry(groupName: string, scripts: ScriptDefinition[]): ScriptGroupDefinition {
  const projectTypes = [...new Set(scripts.flatMap((script) => script.projectTypes))].sort((left, right) => left.localeCompare(right));
  return {
    scriptId: `group_${slugify(groupName)}`,
    name: groupName,
    description: `Run all scripts in ${groupName}.`,
    projectTypes,
    childScriptIds: scripts.map((script) => script.scriptId),
    kind: "group",
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isScriptGroup(entry: ScriptEntry): entry is ScriptGroupDefinition {
  return "kind" in entry && entry.kind === "group";
}
