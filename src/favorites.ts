import fs from "node:fs";
import path from "node:path";

import type { AppConfig, Project, ScriptEntry } from "./models.ts";

interface FavoritesFileShape {
  projects?: string[];
  scripts?: string[];
}

export function loadFavoriteProjectPaths(config: AppConfig): string[] {
  return loadUniqueResolvedPaths(config).projects;
}

export function loadFavoriteScriptIds(config: AppConfig): string[] {
  if (!fs.existsSync(config.tui.favoritesFile)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(config.tui.favoritesFile, "utf8")) as FavoritesFileShape;
  return [...new Set((raw.scripts ?? []).map((scriptId) => String(scriptId)))];
}

export function saveFavorites(
  config: AppConfig,
  favoriteProjectPaths: string[],
  favoriteScriptIds: string[],
): void {
  fs.mkdirSync(path.dirname(config.tui.favoritesFile), { recursive: true });
  const payload: FavoritesFileShape = {
    projects: [...new Set(favoriteProjectPaths.map((projectPath) => path.resolve(projectPath)))],
    scripts: [...new Set(favoriteScriptIds.map((scriptId) => String(scriptId)))],
  };
  fs.writeFileSync(config.tui.favoritesFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function saveFavoriteProjectPaths(config: AppConfig, favoriteProjectPaths: string[]): void {
  saveFavorites(config, favoriteProjectPaths, loadFavoriteScriptIds(config));
}

export function toggleFavoriteProject(
  config: AppConfig,
  favoriteProjectPaths: string[],
  project: Project,
): string[] {
  const resolvedPath = path.resolve(project.path);
  const nextFavorites = favoriteProjectPaths.includes(resolvedPath)
    ? favoriteProjectPaths.filter((item) => item !== resolvedPath)
    : [...favoriteProjectPaths, resolvedPath];
  saveFavorites(config, nextFavorites, loadFavoriteScriptIds(config));
  return nextFavorites;
}

export function toggleFavoriteScript(
  config: AppConfig,
  favoriteScriptIds: string[],
  script: ScriptEntry,
): string[] {
  const nextFavorites = favoriteScriptIds.includes(script.scriptId)
    ? favoriteScriptIds.filter((item) => item !== script.scriptId)
    : [...favoriteScriptIds, script.scriptId];
  saveFavorites(config, loadFavoriteProjectPaths(config), nextFavorites);
  return nextFavorites;
}

function loadUniqueResolvedPaths(config: AppConfig): { projects: string[] } {
  if (!fs.existsSync(config.tui.favoritesFile)) {
    return { projects: [] };
  }
  const raw = JSON.parse(fs.readFileSync(config.tui.favoritesFile, "utf8")) as FavoritesFileShape;
  const seen = new Set<string>();
  const favorites: string[] = [];
  for (const item of raw.projects ?? []) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    favorites.push(resolved);
  }
  return { projects: favorites };
}
