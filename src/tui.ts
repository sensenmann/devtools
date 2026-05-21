import readline from "node:readline";

import type { ExecutionResult, Project, ScriptDefinition } from "./models.ts";
import { DevtoolsService } from "./service.ts";

type FocusPane = "projects" | "scripts";

export async function runTui(service: DevtoolsService): Promise<void> {
  const state = {
    projects: service.refreshProjects(),
    filter: "",
    focusPane: "projects" as FocusPane,
    projectCursor: 0,
    scriptCursor: 0,
    selectedProjectIds: [] as string[],
    logs: [] as string[],
    running: false,
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
      if (state.running) {
        if (key.name === "escape" || input === "q") {
          process.stdin.off("keypress", onKeypress);
          cleanup();
          resolve();
        }
        return;
      }
      if (key.name === "escape" || input === "q" || (key.ctrl && key.name === "c")) {
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
      if (input === "r") {
        state.projects = service.refreshProjects();
        state.logs.push(`Refreshed top-level project cache (${state.projects.length} project(s)).`);
        renderFrame(service, state);
        return;
      }
      if (state.focusPane === "projects") {
        handleProjectInput(state, input, key);
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
        state.logs.push(`Running ${selectedScript.scriptId} on ${selectedProjects.length} project(s).`);
        renderFrame(service, state);
        const results = await service.runScript(selectedScript.scriptId, selectedProjects, {}, (message) => {
          state.logs.push(message);
          renderFrame(service, state);
        });
        appendResultLogs(results, state.logs);
        state.running = false;
        renderFrame(service, state);
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
    selectedProjectIds: string[];
    logs: string[];
    running: boolean;
  },
  input: string,
  key: readline.Key,
): void {
  const filteredProjects = getFilteredProjects(state);
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
  if (key.name === "backspace") {
    state.filter = state.filter.slice(0, -1);
    state.projectCursor = 0;
    return;
  }
  if (input.length === 1 && !key.ctrl && !key.meta) {
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
    selectedProjectIds: string[];
    logs: string[];
    running: boolean;
  },
): void {
  const columns = process.stdout.columns ?? 120;
  const width = Math.max(100, columns);
  const leftWidth = Math.floor(width * 0.56);
  const rightWidth = width - leftWidth - 1;
  const filteredProjects = getFilteredProjects(state);
  const scripts = getScripts(service, state);
  state.projectCursor = Math.min(state.projectCursor, Math.max(0, filteredProjects.length - 1));
  state.scriptCursor = Math.min(state.scriptCursor, Math.max(0, scripts.length - 1));

  const lines: string[] = [];
  lines.push(color(`devtools  filter: ${state.filter || " "}  focus: ${state.focusPane}  keys: tab switch, arrows move, space select, enter run, r refresh, q quit`, "cyan"));
  lines.push("");
  lines.push(`${pad("Projects", leftWidth)} ${pad("Scripts", rightWidth)}`);
  const rowCount = 18;
  for (let index = 0; index < rowCount; index += 1) {
    const project = filteredProjects[index];
    const script = scripts[index];
    const projectText = project
      ? `${state.selectedProjectIds.includes(project.identity) ? "[x]" : "[ ]"} ${project.name} [${project.projectTypes.join(",")}]`
      : "";
    const scriptText = script ? `${script.name} [${script.projectTypes.join(",")}]` : "";
    lines.push(`${highlight(projectText, pad(projectText, leftWidth), state.focusPane === "projects" && index === state.projectCursor)} ${highlight(scriptText, pad(scriptText, rightWidth), state.focusPane === "scripts" && index === state.scriptCursor)}`);
  }
  lines.push("");
  lines.push(color("Run log", "magenta"));
  for (const line of state.logs.slice(-12)) {
    lines.push(truncate(line, width));
  }
  if (state.running) {
    lines.push(color("Running...", "yellow"));
  }
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function getFilteredProjects(state: { projects: Project[]; filter: string }): Project[] {
  const lowered = state.filter.toLowerCase();
  return state.projects.filter((project) =>
    lowered.length === 0 ||
    project.name.toLowerCase().includes(lowered) ||
    project.path.toLowerCase().includes(lowered),
  );
}

function getSelectedProjects(state: { projects: Project[]; selectedProjectIds: string[] }): Project[] {
  return state.projects.filter((project) => state.selectedProjectIds.includes(project.identity));
}

function getScripts(
  service: DevtoolsService,
  state: { projects: Project[]; selectedProjectIds: string[] },
): ScriptDefinition[] {
  const selected = getSelectedProjects(state);
  return service.listScripts(selected.length > 0 ? selected : undefined);
}

function appendResultLogs(results: ExecutionResult[], logs: string[]): void {
  let failures = 0;
  for (const result of results) {
    logs.push(`[${result.success ? "OK" : "FAIL"}] ${result.project.path}`);
    if (result.message) {
      logs.push(result.message);
    }
    if (result.output.trim()) {
      logs.push(...result.output.trim().split(/\r?\n/));
    }
    if (result.error.trim()) {
      logs.push(...result.error.trim().split(/\r?\n/));
    }
    if (!result.success) {
      failures += 1;
    }
  }
  logs.push(`Finished with ${failures} failure(s).`);
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`;
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
