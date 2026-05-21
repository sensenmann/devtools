import fs from "node:fs";
import readline from "node:readline";

import { loadFavoriteProjectPaths, toggleFavoriteProject } from "./favorites.ts";
import { loadSelectedVariants, saveSelectedVariants } from "./script-state.ts";
import type { ExecutionResult, Project, ScriptDefinition, ScriptEntry } from "./models.ts";
import { isScriptGroup } from "./registry.ts";
import { DevtoolsService } from "./service.ts";

type FocusPane = "projects" | "scripts";

export async function runTui(service: DevtoolsService): Promise<void> {
  const state = {
    projects: service.refreshProjects(),
    filter: "",
    focusPane: "projects" as FocusPane,
    projectCursor: 0,
    scriptCursor: 0,
    projectScrollOffset: 0,
    scriptScrollOffset: 0,
    selectedProjectIds: [] as string[],
    favoriteProjectPaths: loadFavoriteProjectPaths(service.config),
    selectedVariants: loadSelectedVariants(service.config),
    logs: [] as string[],
    running: false,
    currentRunController: undefined as AbortController | undefined,
    awaitingResume: false,
    resumeResolver: undefined as (() => void) | undefined,
  };
  state.logs.push(`Refreshed top-level project cache (${state.projects.length} project(s)).`);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const cleanup = () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[0m\n");
  };

  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  renderFrame(service, state);

  await new Promise<void>((resolve) => {
    const onKeypress = async (input: string, key: readline.Key) => {
      if (state.awaitingResume) {
        state.awaitingResume = false;
        const resume = state.resumeResolver;
        state.resumeResolver = undefined;
        resume?.();
        return;
      }
      if (state.running) {
        if (key.ctrl && key.name === "c") {
          if (!state.currentRunController?.signal.aborted) {
            state.currentRunController?.abort();
          }
        }
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c") || isCommandKey(key, "q")) {
        process.stdin.off("keypress", onKeypress);
        cleanup();
        resolve();
        return;
      }
      if (key.name === "tab") {
        state.focusPane = state.focusPane === "projects" ? "scripts" : "projects";
        renderFrame(service, state);
        return;
      }
      if (isCommandKey(key, "r")) {
        state.projects = service.refreshProjects();
        state.logs.push(`Refreshed top-level project cache (${state.projects.length} project(s)).`);
        renderFrame(service, state);
        return;
      }
      if (state.focusPane === "projects") {
        handleProjectInput(state, input, key, service.config.tui.projectSort, service);
        renderFrame(service, state);
        return;
      }
      if (key.name === "up") {
        state.scriptCursor = Math.max(0, state.scriptCursor - 1);
        renderFrame(service, state);
        return;
      }
      if (key.name === "down") {
        state.scriptCursor = Math.min(getScripts(service, state).length - 1, state.scriptCursor + 1);
        renderFrame(service, state);
        return;
      }
      if (key.name === "left") {
        cycleScriptVariant(state, getScripts(service, state), service, -1);
        renderFrame(service, state);
        return;
      }
      if (key.name === "right") {
        cycleScriptVariant(state, getScripts(service, state), service, 1);
        renderFrame(service, state);
        return;
      }
      if (key.name === "return") {
        const selectedProjects = getSelectedProjects(state);
        const scripts = getScripts(service, state);
        const selectedScript = scripts[state.scriptCursor];
        if (!selectedScript || selectedProjects.length === 0) {
          state.logs.push("Select at least one project and one script.");
          renderFrame(service, state);
          return;
        }
        state.running = true;
        state.currentRunController = new AbortController();
        state.logs.push(`Ran ${selectedScript.scriptId} on ${selectedProjects.length} project(s).`);
        showRunView(selectedScript, selectedProjects.length);
        try {
          const results = await service.runScript(
            selectedScript.scriptId,
            selectedProjects,
            {},
            (message) => {
              process.stdout.write(`${message}\n`);
            },
            state.currentRunController.signal,
            "passthrough",
            buildScriptArgOverrides(state.selectedVariants, scripts),
          );
          replaceSummaryLogs(results, state.logs);
          process.stdout.write("\nPress any key to resume...");
          await waitForResume(state);
          process.stdout.write("\n");
        } finally {
          state.running = false;
          state.currentRunController = undefined;
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          renderFrame(service, state);
        }
      }
    };

    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

function handleProjectInput(
  state: {
    projects: Project[];
    filter: string;
    focusPane: FocusPane;
    projectCursor: number;
    scriptCursor: number;
    projectScrollOffset: number;
    scriptScrollOffset: number;
    selectedProjectIds: string[];
    favoriteProjectPaths: string[];
    selectedVariants: Record<string, string>;
    logs: string[];
    running: boolean;
  },
  input: string,
  key: readline.Key,
  projectSort: "alphabetical" | "modified",
  service: DevtoolsService,
): void {
  const filteredProjects = getFilteredProjects(state, projectSort);
  if (key.name === "up") {
    state.projectCursor = Math.max(0, state.projectCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.projectCursor = Math.min(filteredProjects.length - 1, state.projectCursor + 1);
    return;
  }
  if (key.name === "return" || input === " ") {
    const current = filteredProjects[state.projectCursor];
    if (!current) {
      return;
    }
    if (state.selectedProjectIds.includes(current.identity)) {
      state.selectedProjectIds = state.selectedProjectIds.filter((item) => item !== current.identity);
    } else {
      state.selectedProjectIds = [...state.selectedProjectIds, current.identity];
    }
    return;
  }
  if (isCommandKey(key, "f")) {
    const current = filteredProjects[state.projectCursor];
    if (!current) {
      return;
    }
    state.favoriteProjectPaths = toggleFavoriteProject(service.config, state.favoriteProjectPaths, current);
    return;
  }
  if (isCommandKey(key, "a")) {
    toggleAllFilteredProjects(state, filteredProjects);
    return;
  }
  if (key.name === "backspace") {
    state.filter = state.filter.slice(0, -1);
    state.projectCursor = 0;
    return;
  }
  if (typeof input === "string" && input.length === 1 && !key.ctrl && !key.meta) {
    state.filter += input;
    state.projectCursor = 0;
  }
}

function renderFrame(
  service: DevtoolsService,
  state: {
    projects: Project[];
    filter: string;
    focusPane: FocusPane;
    projectCursor: number;
    scriptCursor: number;
    projectScrollOffset: number;
    scriptScrollOffset: number;
    selectedProjectIds: string[];
    favoriteProjectPaths: string[];
    selectedVariants: Record<string, string>;
    logs: string[];
    running: boolean;
  },
): void {
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const innerWidth = width - 2;
  const gutter = 3;
  const leftWidth = Math.floor((innerWidth - gutter) * 0.56);
  const rightWidth = innerWidth - gutter - leftWidth;
  const filteredProjects = getFilteredProjects(state, service.config.tui.projectSort);
  const scripts = getScripts(service, state);
  const rowCount = service.config.tui.projectRows;
  state.projectCursor = Math.min(state.projectCursor, Math.max(0, filteredProjects.length - 1));
  state.scriptCursor = Math.min(state.scriptCursor, Math.max(0, scripts.length - 1));
  state.projectScrollOffset = clampScrollOffset(state.projectCursor, state.projectScrollOffset, filteredProjects.length, rowCount);
  state.scriptScrollOffset = clampScrollOffset(state.scriptCursor, state.scriptScrollOffset, scripts.length, rowCount);
  const visibleProjects = filteredProjects.slice(state.projectScrollOffset, state.projectScrollOffset + rowCount);
  const visibleScripts = scripts.slice(state.scriptScrollOffset, state.scriptScrollOffset + rowCount);
  const activeProjectRow = state.projectCursor - state.projectScrollOffset;
  const activeScriptRow = state.scriptCursor - state.scriptScrollOffset;

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(
    ` ${color("devtools", "cyan")}  filter: ${highlightInput(state.filter)}  focus: ${state.focusPane} `,
    width,
  ));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${renderKeyHelp()} `, width));
  lines.push(drawHorizontal("divider", width));
  lines.push(drawLine(`${pad(color("Projects", "cyan"), leftWidth)}${" ".repeat(gutter)}${pad(color("Scripts", "cyan"), rightWidth)}`, width));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const project = visibleProjects[index];
    const script = visibleScripts[index];
    const projectText = project
      ? `${state.selectedProjectIds.includes(project.identity) ? "[x]" : "[ ]"} ${state.favoriteProjectPaths.includes(project.path) ? "⭐️ " : ""}${project.name} [${project.projectTypes.join(",")}]`
      : "";
    const scriptText = script ? formatScriptEntry(script, state.selectedVariants) : "";
    lines.push(drawLine(
      `${highlight(projectText, pad(projectText, leftWidth), state.focusPane === "projects" && index === activeProjectRow)}${" ".repeat(gutter)}${highlight(scriptText, pad(scriptText, rightWidth), state.focusPane === "scripts" && index === activeScriptRow)}`,
      width,
    ));
  }
  lines.push(drawHorizontal("divider", width));
  for (const line of state.logs.slice(-service.config.tui.summaryRows)) {
    lines.push(drawLine(line, width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function getFilteredProjects(
  state: { projects: Project[]; filter: string; selectedProjectIds: string[]; favoriteProjectPaths: string[] },
  projectSort: "alphabetical" | "modified",
): Project[] {
  const lowered = state.filter.toLowerCase();
  return sortProjects(state.projects, projectSort, state.favoriteProjectPaths).filter((project) =>
    state.selectedProjectIds.includes(project.identity) ||
    lowered.length === 0 ||
    project.name.toLowerCase().includes(lowered) ||
    project.path.toLowerCase().includes(lowered),
  );
}

function sortProjects(
  projects: Project[],
  projectSort: "alphabetical" | "modified",
  favoriteProjectPaths: string[],
): Project[] {
  return [...projects].sort((left, right) => compareProjects(left, right, projectSort, favoriteProjectPaths));
}

function compareProjects(
  left: Project,
  right: Project,
  projectSort: "alphabetical" | "modified",
  favoriteProjectPaths: string[],
): number {
  const leftFavorite = favoriteProjectPaths.includes(left.path);
  const rightFavorite = favoriteProjectPaths.includes(right.path);
  if (leftFavorite !== rightFavorite) {
    return leftFavorite ? -1 : 1;
  }
  if (projectSort === "modified") {
    const modifiedDifference = getProjectModifiedTime(right) - getProjectModifiedTime(left);
    if (modifiedDifference !== 0) {
      return modifiedDifference;
    }
  }
  return compareAlphabetically(left, right);
}

function getProjectModifiedTime(project: Project): number {
  try {
    return fs.statSync(project.path).mtimeMs;
  } catch {
    return 0;
  }
}

function compareAlphabetically(left: Project, right: Project): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }
  return left.path.localeCompare(right.path);
}

function clampScrollOffset(cursor: number, currentOffset: number, itemCount: number, windowSize: number): number {
  const maxOffset = Math.max(0, itemCount - windowSize);
  if (cursor < currentOffset) {
    return cursor;
  }
  if (cursor >= currentOffset + windowSize) {
    return Math.min(maxOffset, cursor - windowSize + 1);
  }
  return Math.min(currentOffset, maxOffset);
}

function getSelectedProjects(state: { projects: Project[]; selectedProjectIds: string[] }): Project[] {
  return state.projects.filter((project) => state.selectedProjectIds.includes(project.identity));
}

function getScripts(
  service: DevtoolsService,
  state: { projects: Project[]; selectedProjectIds: string[] },
): ScriptEntry[] {
  const selected = getSelectedProjects(state);
  return service.listScripts(selected.length > 0 ? selected : undefined);
}

function replaceSummaryLogs(results: ExecutionResult[], logs: string[]): void {
  logs.length = 0;
  let failures = 0;
  for (const result of results) {
    logs.push(`[${result.success ? "OK" : "FAIL"}] ${result.project.path}`);
    if (result.message) {
      logs.push(result.message);
    }
    if (!result.success) {
      failures += 1;
    }
  }
  logs.push(`Finished with ${failures} failure(s).`);
}

function waitForResume(state: { awaitingResume: boolean; resumeResolver?: () => void }): Promise<void> {
  state.awaitingResume = true;
  return new Promise<void>((resolve) => {
    state.resumeResolver = resolve;
  });
}

function showRunView(script: ScriptEntry, projectCount: number): void {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h\x1b[0m");
  process.stdout.write(`${color("Running", "yellow")} ${script.scriptId} on ${projectCount} project(s)\n\n`);
}

function toggleAllFilteredProjects(
  state: {
    selectedProjectIds: string[];
  },
  filteredProjects: Project[],
): void {
  const filteredIds = filteredProjects.map((project) => project.identity);
  const allSelected = filteredIds.length > 0 && filteredIds.every((identity) => state.selectedProjectIds.includes(identity));
  if (allSelected) {
    state.selectedProjectIds = state.selectedProjectIds.filter((identity) => !filteredIds.includes(identity));
    return;
  }
  state.selectedProjectIds = Array.from(new Set([...state.selectedProjectIds, ...filteredIds]));
}

function pad(value: string, width: number): string {
  const visible = stripAnsi(value);
  if (visible.length >= width) {
    return truncate(value, width);
  }
  return `${value}${" ".repeat(width - visible.length)}`;
}

function truncate(value: string, width: number): string {
  const visible = stripAnsi(value);
  if (visible.length <= width) {
    return value;
  }
  return `${visible.slice(0, Math.max(0, width - 1))}…`;
}

function color(value: string, tone: "cyan" | "magenta" | "yellow"): string {
  const code = tone === "cyan" ? "36" : tone === "magenta" ? "35" : "33";
  return `\x1b[${code}m${value}\x1b[0m`;
}

function highlight(original: string, padded: string, active: boolean): string {
  if (!active || !original) {
    return padded;
  }
  return `\x1b[30;42m${padded}\x1b[0m`;
}

function highlightInput(value: string): string {
  if (value.length === 0) {
    return " ";
  }
  return `\x1b[30;103m ${value} \x1b[0m`;
}

function drawHorizontal(kind: "top" | "divider" | "bottom", width: number): string {
  const horizontal = "─".repeat(Math.max(0, width - 2));
  if (kind === "top") {
    return `┌${horizontal}┐`;
  }
  if (kind === "bottom") {
    return `└${horizontal}┘`;
  }
  return `├${horizontal}┤`;
}

function drawLine(value: string, width: number): string {
  return `│${pad(value, width - 2)}│`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderKeyHelp(): string {
  const segments = [
    formatKeybinding(["Tab"], "switch"),
    formatKeybinding(["Space"], "select"),
    formatKeybinding(["^A"], "all"),
    formatKeybinding(["^F"], "favorite"),
    formatKeybinding(["←/→"], "option"),
    formatKeybinding(["Enter"], "run"),
    formatKeybinding(["^R"], "refresh"),
    formatKeybinding(["^Q"], "quit"),
  ];
  return segments.join("  ");
}

function formatScriptEntry(script: ScriptEntry, selectedVariants: Record<string, string>): string {
  if (isScriptGroup(script)) {
    return `▸ ${script.name}`;
  }
  const variantSuffix = script.variant ? ` ${highlightVariantLabel(getSelectedVariantValue(script, selectedVariants))}` : "";
  if (script.group) {
    return `  ${script.name}${variantSuffix}`;
  }
  return `${script.name}${variantSuffix}`;
}

function highlightVariantLabel(value: string): string {
  return `\x1b[30;103m[${value}]\x1b[0m`;
}

function getSelectedVariantValue(script: ScriptDefinition, selectedVariants: Record<string, string>): string {
  return selectedVariants[script.scriptId] ?? script.variant?.defaultValue ?? "";
}

function cycleScriptVariant(
  state: { scriptCursor: number; selectedVariants: Record<string, string> },
  scripts: ScriptEntry[],
  service: DevtoolsService,
  direction: -1 | 1,
): void {
  const current = scripts[state.scriptCursor];
  if (!current || isScriptGroup(current) || !current.variant) {
    return;
  }
  const currentValue = getSelectedVariantValue(current, state.selectedVariants);
  const currentIndex = Math.max(0, current.variant.values.indexOf(currentValue));
  const nextIndex = (currentIndex + direction + current.variant.values.length) % current.variant.values.length;
  state.selectedVariants[current.scriptId] = current.variant.values[nextIndex]!;
  saveSelectedVariants(service.config, state.selectedVariants);
}

function buildScriptArgOverrides(
  selectedVariants: Record<string, string>,
  scripts: ScriptEntry[],
): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const script of scripts) {
    if (isScriptGroup(script) || !script.variant) {
      continue;
    }
    const selectedValue = getSelectedVariantValue(script, selectedVariants);
    overrides[script.scriptId] = {
      [script.variant.argKey]: script.variant.argValues[selectedValue],
    };
  }
  return overrides;
}

function formatKeybinding(keys: string[], action: string): string {
  return `${keys.map((key) => color(key, "cyan")).join("/")}${color(":", "yellow")} ${action}`;
}

function isCommandKey(key: readline.Key, name: string): boolean {
  return key.name === name && (Boolean(key.ctrl) || Boolean(key.meta));
}
