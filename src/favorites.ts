import fs from "node:fs";
import path from "node:path";

import type { AppConfig, Project } from "./models.ts";

interface FavoritesFileShape {
  projects?: string[];
}

export function loadFavoriteProjectPaths(config: AppConfig): string[] {
  if (!fs.existsSync(config.tui.favoritesFile)) {
    return [];
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
  return favorites;
}

export function saveFavoriteProjectPaths(config: AppConfig, favoriteProjectPaths: string[]): void {
  fs.mkdirSync(path.dirname(config.tui.favoritesFile), { recursive: true });
  const payload: FavoritesFileShape = {
    projects: [...new Set(favoriteProjectPaths.map((projectPath) => path.resolve(projectPath)))],
  };
  fs.writeFileSync(config.tui.favoritesFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
  saveFavoriteProjectPaths(config, nextFavorites);
  return nextFavorites;
}
