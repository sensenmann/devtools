import fs from "node:fs";
import path from "node:path";

import type { AppConfig, Project, ProjectType, ScriptDefinition } from "./models.ts";
import { parseSimpleToml } from "./toml.ts";

const MANIFEST_NAME = "manifest.toml";

interface RawManifest {
  id?: string;
  name?: string;
  description?: string;
  project_types?: ProjectType[];
  entry?: string;
  default_args?: Record<string, unknown>;
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
    projects.every((project) => script.projectTypes.some((value) => project.projectTypes.includes(value))),
  );
}

export function getScriptById(scripts: ScriptDefinition[], scriptId: string): ScriptDefinition | undefined {
  return scripts.find((script) => script.scriptId === scriptId);
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
  };
}
