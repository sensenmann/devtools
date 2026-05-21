import fs from "node:fs";
import readline from "node:readline";

import { loadFavoriteProjectPaths, toggleFavoriteProject } from "./favorites.ts";
import { isScriptGroup } from "./registry.ts";
import { loadSelectedVariants, saveSelectedVariants } from "./script-state.ts";
import type {
  ExecutionResult,
  Project,
  ScheduledJob,
  ScheduleDefinition,
  ScheduledWeekday,
  ScriptDefinition,
  ScriptEntry,
} from "./models.ts";
import { DevtoolsService } from "./service.ts";

type FocusPane = "projects" | "scripts";
type TuiMode = "main" | "cron-menu" | "cron-script-select" | "cron-schedule-edit" | "cron-job-list";
type CronMenuOption = "create" | "manage" | "back";
type CronJobFlowOrigin = "cron-menu" | "cron-job-list";
type ScheduleField = "type" | "weekday" | "hour" | "minute" | "enabled" | "save";

interface ScheduledJobDraft {
  sourceJob?: ScheduledJob;
  projectPaths: string[];
  selectedScriptIds: string[];
  selectedVariants: Record<string, string>;
  schedule: ScheduleDefinition;
  enabled: boolean;
}

interface TuiState {
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
  currentRunController?: AbortController;
  awaitingResume: boolean;
  resumeResolver?: () => void;
  mode: TuiMode;
  cronMenuCursor: number;
  cronJobCursor: number;
  cronJobScrollOffset: number;
  cronScriptCursor: number;
  cronScriptScrollOffset: number;
  cronScheduleFieldCursor: number;
  scheduledJobs: ScheduledJob[];
  jobDraft?: ScheduledJobDraft;
  cronJobFlowOrigin: CronJobFlowOrigin;
}

export async function runTui(service: DevtoolsService): Promise<void> {
  const state: TuiState = {
    projects: service.refreshProjects(),
    filter: "",
    focusPane: "projects",
    projectCursor: 0,
    scriptCursor: 0,
    projectScrollOffset: 0,
    scriptScrollOffset: 0,
    selectedProjectIds: [],
    favoriteProjectPaths: loadFavoriteProjectPaths(service.config),
    selectedVariants: loadSelectedVariants(service.config),
    logs: [],
    running: false,
    awaitingResume: false,
    mode: "main",
    cronMenuCursor: 0,
    cronJobCursor: 0,
    cronJobScrollOffset: 0,
    cronScriptCursor: 0,
    cronScriptScrollOffset: 0,
    cronScheduleFieldCursor: 0,
    scheduledJobs: service.listScheduledJobs(),
    cronJobFlowOrigin: "cron-menu",
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
    const onKeypress = async (input: string | undefined, key: readline.Key) => {
      if (state.awaitingResume) {
        state.awaitingResume = false;
        const resume = state.resumeResolver;
        state.resumeResolver = undefined;
        resume?.();
        return;
      }
      if (state.running) {
        if (key.ctrl && key.name === "c" && !state.currentRunController?.signal.aborted) {
          state.currentRunController?.abort();
        }
        return;
      }
      if (key.ctrl && key.name === "c") {
        process.stdin.off("keypress", onKeypress);
        cleanup();
        resolve();
        return;
      }
      if (isCommandKey(key, "q")) {
        process.stdin.off("keypress", onKeypress);
        cleanup();
        resolve();
        return;
      }

      switch (state.mode) {
        case "main":
          if (handleMainKeypress(service, state, input, key)) {
            process.stdin.off("keypress", onKeypress);
            cleanup();
            resolve();
            return;
          }
          break;
        case "cron-menu":
          handleCronMenuKeypress(service, state, input, key);
          break;
        case "cron-script-select":
          handleCronScriptSelectionKeypress(service, state, input, key);
          break;
        case "cron-schedule-edit":
          handleCronScheduleEditKeypress(service, state, input, key);
          break;
        case "cron-job-list":
          handleCronJobListKeypress(service, state, input, key);
          break;
      }

      renderFrame(service, state);
    };

    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

function handleMainKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): boolean {
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.mode = "cron-menu";
    state.cronMenuCursor = 0;
    state.scheduledJobs = service.listScheduledJobs();
    return false;
  }
  if (key.name === "tab") {
    state.focusPane = state.focusPane === "projects" ? "scripts" : "projects";
    return false;
  }
  if (isCommandKey(key, "r")) {
    state.projects = service.refreshProjects();
    state.logs.push(`Refreshed top-level project cache (${state.projects.length} project(s)).`);
    return false;
  }
  if (state.focusPane === "projects") {
    handleProjectInput(state, input, key, service.config.tui.projectSort, service);
    return false;
  }
  const scripts = getScripts(service, state);
  if (key.name === "up") {
    state.scriptCursor = Math.max(0, state.scriptCursor - 1);
    return false;
  }
  if (key.name === "down") {
    state.scriptCursor = Math.min(scripts.length - 1, state.scriptCursor + 1);
    return false;
  }
  if (key.name === "left") {
    cycleScriptVariant(state.selectedVariants, scripts, state.scriptCursor, service, -1);
    return false;
  }
  if (key.name === "right") {
    cycleScriptVariant(state.selectedVariants, scripts, state.scriptCursor, service, 1);
    return false;
  }
  if (key.name === "return") {
    void runSelectedScript(service, state, scripts);
  }
  return false;
}

function handleProjectInput(
  state: TuiState,
  input: string | undefined,
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
  if (typeof input === "string" && input.length === 1 && !key.ctrl && !key.meta && !isControlCharacter(input)) {
    state.filter += input;
    state.projectCursor = 0;
  }
}

function handleCronMenuKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const options = getCronMenuOptions(state);
  state.cronMenuCursor = Math.min(state.cronMenuCursor, Math.max(0, options.length - 1));
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.mode = "main";
    return;
  }
  if (key.name === "up") {
    state.cronMenuCursor = Math.max(0, state.cronMenuCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.cronMenuCursor = Math.min(options.length - 1, state.cronMenuCursor + 1);
    return;
  }
  if (key.name !== "return") {
    return;
  }

  const selectedOption = options[state.cronMenuCursor];
  if (selectedOption === "back") {
    state.mode = "main";
    return;
  }
  if (selectedOption === "manage") {
    state.mode = "cron-job-list";
    state.scheduledJobs = service.listScheduledJobs();
    state.cronJobCursor = 0;
    state.cronJobScrollOffset = 0;
    return;
  }
  const selectedProjects = getSelectedProjects(state);
  if (selectedProjects.length === 0) {
    state.logs.push("Select at least one project before creating a scheduled job.");
    state.mode = "main";
    return;
  }
  state.jobDraft = {
    projectPaths: selectedProjects.map((project) => project.path),
    selectedScriptIds: [],
    selectedVariants: { ...state.selectedVariants },
    schedule: { kind: "hourly" },
    enabled: true,
  };
  state.cronJobFlowOrigin = "cron-menu";
  state.cronScriptCursor = 0;
  state.cronScriptScrollOffset = 0;
  state.mode = "cron-script-select";
}

function handleCronScriptSelectionKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const draft = state.jobDraft;
  if (!draft) {
    state.mode = "main";
    return;
  }
  const scripts = getDraftScripts(service, draft);
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.mode = state.cronJobFlowOrigin;
    return;
  }
  if (key.name === "up") {
    state.cronScriptCursor = Math.max(0, state.cronScriptCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.cronScriptCursor = Math.min(scripts.length - 1, state.cronScriptCursor + 1);
    return;
  }
  if (key.name === "left") {
    cycleDraftScriptVariant(draft, scripts, state.cronScriptCursor, -1);
    return;
  }
  if (key.name === "right") {
    cycleDraftScriptVariant(draft, scripts, state.cronScriptCursor, 1);
    return;
  }
  if (key.name === "return") {
    if (draft.selectedScriptIds.length === 0) {
      return;
    }
    state.cronScheduleFieldCursor = 0;
    state.mode = "cron-schedule-edit";
    return;
  }
  if (key.name === "space") {
    const current = scripts[state.cronScriptCursor];
    if (!current) {
      return;
    }
    if (draft.selectedScriptIds.includes(current.scriptId)) {
      draft.selectedScriptIds = draft.selectedScriptIds.filter((scriptId) => scriptId !== current.scriptId);
    } else {
      draft.selectedScriptIds = [...draft.selectedScriptIds, current.scriptId];
    }
  }
}

function handleCronScheduleEditKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const draft = state.jobDraft;
  if (!draft) {
    state.mode = "main";
    return;
  }
  const fields = getScheduleFields(draft.schedule);
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.mode = "cron-script-select";
    return;
  }
  if (key.name === "up") {
    state.cronScheduleFieldCursor = Math.max(0, state.cronScheduleFieldCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.cronScheduleFieldCursor = Math.min(fields.length - 1, state.cronScheduleFieldCursor + 1);
    return;
  }

  const field = fields[state.cronScheduleFieldCursor];
  if (!field) {
    return;
  }
  if (key.name === "left") {
    mutateScheduleField(draft, field, -1);
    return;
  }
  if (key.name === "right") {
    mutateScheduleField(draft, field, 1);
    return;
  }
  if (key.name === "space" && field === "enabled") {
    draft.enabled = !draft.enabled;
    return;
  }
  if (key.name === "return") {
    if (field === "enabled") {
      draft.enabled = !draft.enabled;
      return;
    }
    if (field !== "save") {
      return;
    }
    const savedJob = saveScheduledJobDraft(service, draft);
    state.scheduledJobs = service.listScheduledJobs();
    state.logs = [`Saved scheduled job: ${savedJob.name}`];
    state.mode = "cron-job-list";
    state.cronJobCursor = Math.max(0, state.scheduledJobs.findIndex((job) => job.jobId === savedJob.jobId));
    state.cronJobScrollOffset = 0;
    state.jobDraft = undefined;
  }
}

function handleCronJobListKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const jobs = state.scheduledJobs;
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.mode = "main";
    return;
  }
  if (key.name === "up") {
    state.cronJobCursor = Math.max(0, state.cronJobCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.cronJobCursor = Math.min(jobs.length - 1, state.cronJobCursor + 1);
    return;
  }
  const current = jobs[state.cronJobCursor];
  if (!current) {
    return;
  }
  if (key.name === "space") {
    current.enabled = !current.enabled;
    service.saveScheduledJob(current);
    state.scheduledJobs = service.listScheduledJobs();
    return;
  }
  if (key.name === "backspace" || key.name === "delete") {
    service.deleteScheduledJob(current.jobId);
    state.scheduledJobs = service.listScheduledJobs();
    state.logs = [`Deleted scheduled job: ${current.name}`];
    state.cronJobCursor = Math.min(state.cronJobCursor, Math.max(0, state.scheduledJobs.length - 1));
    return;
  }
  if (key.name === "return") {
    state.jobDraft = {
      sourceJob: current,
      projectPaths: [...current.projectPaths],
      selectedScriptIds: [...current.selectedScriptIds],
      selectedVariants: { ...current.selectedVariants },
      schedule: cloneSchedule(current.schedule),
      enabled: current.enabled,
    };
    state.cronJobFlowOrigin = "cron-job-list";
    state.cronScriptCursor = 0;
    state.cronScriptScrollOffset = 0;
    state.mode = "cron-script-select";
  }
}

function renderFrame(service: DevtoolsService, state: TuiState): void {
  switch (state.mode) {
    case "main":
      renderMainFrame(service, state);
      return;
    case "cron-menu":
      renderCronMenuFrame(service, state);
      return;
    case "cron-script-select":
      renderCronScriptSelectionFrame(service, state);
      return;
    case "cron-schedule-edit":
      renderCronScheduleEditFrame(service, state);
      return;
    case "cron-job-list":
      renderCronJobListFrame(service, state);
      return;
  }
}

function renderMainFrame(service: DevtoolsService, state: TuiState): void {
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
  lines.push(drawLine(` ${color("devtools", "cyan")}  filter: ${highlightInput(state.filter)}  focus: ${state.focusPane} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${renderMainKeyHelp()} `, width));
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

function renderCronMenuFrame(service: DevtoolsService, state: TuiState): void {
  const options = [
    ...(
      getSelectedProjects(state).length > 0
        ? [{ key: "create", label: "Create From Current Selection", description: "Use the currently selected projects as the job target." }]
        : []
    ),
    { key: "manage", label: "Manage Existing Jobs", description: "List, edit, enable/disable and delete saved jobs." },
    { key: "back", label: "Back", description: "Return to the main screen." },
  ] satisfies Array<{ key: CronMenuOption; label: string; description: string }>;
  const selectedProjects = getSelectedProjects(state);
  state.cronMenuCursor = Math.min(state.cronMenuCursor, Math.max(0, options.length - 1));
  renderSimpleMenu(
    service,
    "Scheduled Jobs",
    `selected projects: ${selectedProjects.length}`,
    options.map((option) => `${option.label} - ${option.description}`),
    state.cronMenuCursor,
    ` ${color("keys:", "yellow")} ${formatKeybinding(["Enter"], "choose")}  ${formatKeybinding(["^J"], "back")}  ${formatKeybinding(["^C"], "quit")}  ${formatKeybinding(["^Q"], "quit")} `,
  );
}

function renderCronScriptSelectionFrame(service: DevtoolsService, state: TuiState): void {
  const draft = state.jobDraft;
  if (!draft) {
    renderMainFrame(service, state);
    return;
  }
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const rowCount = service.config.tui.projectRows;
  const scripts = getDraftScripts(service, draft);
  state.cronScriptCursor = Math.min(state.cronScriptCursor, Math.max(0, scripts.length - 1));
  state.cronScriptScrollOffset = clampScrollOffset(state.cronScriptCursor, state.cronScriptScrollOffset, scripts.length, rowCount);
  const visibleScripts = scripts.slice(state.cronScriptScrollOffset, state.cronScriptScrollOffset + rowCount);
  const activeRow = state.cronScriptCursor - state.cronScriptScrollOffset;
  const projectSummary = buildDraftProjectSummary(draft);

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("Scheduled Job", "magenta")}  ${projectSummary} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["Space"], "toggle")}  ${formatKeybinding(["←/→"], "option")}  ${formatKeybinding(["Enter"], "next")}  ${formatKeybinding(["^J"], "back")} `, width));
  lines.push(drawHorizontal("divider", width));
  lines.push(drawLine(` ${color("Scripts & Groups", "cyan")} `, width));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const script = visibleScripts[index];
    const text = script
      ? `${draft.selectedScriptIds.includes(script.scriptId) ? "[x]" : "[ ]"} ${formatScriptEntry(script, draft.selectedVariants)}`
      : "";
    lines.push(drawLine(highlight(text, pad(text, width - 2), index === activeRow), width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function renderCronScheduleEditFrame(service: DevtoolsService, state: TuiState): void {
  const draft = state.jobDraft;
  if (!draft) {
    renderMainFrame(service, state);
    return;
  }
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const fields = getScheduleFields(draft.schedule);

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("Schedule", "magenta")}  ${buildDraftProjectSummary(draft)}  scripts: ${draft.selectedScriptIds.length} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["←/→"], "change")}  ${formatKeybinding(["Enter"], "save")}  ${formatKeybinding(["^J"], "back")} `, width));
  lines.push(drawHorizontal("divider", width));
  for (const [index, field] of fields.entries()) {
    const text = formatScheduleField(field, draft);
    lines.push(drawLine(highlight(text, pad(text, width - 2), index === state.cronScheduleFieldCursor), width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function renderCronJobListFrame(service: DevtoolsService, state: TuiState): void {
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const rowCount = service.config.tui.projectRows;
  const jobs = state.scheduledJobs;
  state.cronJobCursor = Math.min(state.cronJobCursor, Math.max(0, jobs.length - 1));
  state.cronJobScrollOffset = clampScrollOffset(state.cronJobCursor, state.cronJobScrollOffset, jobs.length, rowCount);
  const visibleJobs = jobs.slice(state.cronJobScrollOffset, state.cronJobScrollOffset + rowCount);
  const activeRow = state.cronJobCursor - state.cronJobScrollOffset;

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("Scheduled Jobs", "magenta")}  total: ${jobs.length} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["Enter"], "edit")}  ${formatKeybinding(["Space"], "toggle enabled")}  ${formatKeybinding(["Backspace"], "delete")}  ${formatKeybinding(["^J"], "back")} `, width));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const job = visibleJobs[index];
    const text = job ? formatScheduledJob(job) : "";
    lines.push(drawLine(highlight(text, pad(text, width - 2), index === activeRow), width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function renderSimpleMenu(
  service: DevtoolsService,
  title: string,
  subtitle: string,
  items: string[],
  cursor: number,
  helpText: string,
): void {
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color(title, "magenta")}  ${subtitle} `, width));
  lines.push(drawLine(helpText, width));
  lines.push(drawHorizontal("divider", width));
  for (const [index, item] of items.entries()) {
    lines.push(drawLine(highlight(item, pad(item, width - 2), index === cursor), width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function getFilteredProjects(
  state: Pick<TuiState, "projects" | "filter" | "selectedProjectIds" | "favoriteProjectPaths">,
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

function getSelectedProjects(state: Pick<TuiState, "projects" | "selectedProjectIds">): Project[] {
  return state.projects.filter((project) => state.selectedProjectIds.includes(project.identity));
}

function getScripts(service: DevtoolsService, state: Pick<TuiState, "projects" | "selectedProjectIds">): ScriptEntry[] {
  const selected = getSelectedProjects(state);
  return service.listScripts(selected.length > 0 ? selected : undefined);
}

function getDraftScripts(service: DevtoolsService, draft: ScheduledJobDraft): ScriptEntry[] {
  const projects = service.listProjects({ explicitPaths: draft.projectPaths, refresh: true });
  return service.listScripts(projects);
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

function waitForResume(state: Pick<TuiState, "awaitingResume" | "resumeResolver">): Promise<void> {
  state.awaitingResume = true;
  return new Promise<void>((resolve) => {
    state.resumeResolver = resolve;
  });
}

function showRunView(script: ScriptEntry, projectCount: number): void {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h\x1b[0m");
  process.stdout.write(`${color("Running", "yellow")} ${script.scriptId} on ${projectCount} project(s)\n\n`);
}

function toggleAllFilteredProjects(state: Pick<TuiState, "selectedProjectIds">, filteredProjects: Project[]): void {
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

function highlightVariantLabel(value: string): string {
  return `\x1b[30;103m[${value}]\x1b[0m`;
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

function renderMainKeyHelp(): string {
  const segments = [
    formatKeybinding(["Tab"], "switch"),
    formatKeybinding(["Space"], "select"),
    formatKeybinding(["^A"], "all"),
    formatKeybinding(["^F"], "favorite"),
    formatKeybinding(["←/→"], "option"),
    formatKeybinding(["Enter"], "run"),
    formatKeybinding(["^R"], "refresh"),
    formatKeybinding(["^J"], "jobs"),
    formatKeybinding(["^C"], "quit"),
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

function getSelectedVariantValue(script: ScriptDefinition, selectedVariants: Record<string, string>): string {
  return selectedVariants[script.scriptId] ?? script.variant?.defaultValue ?? "";
}

function cycleScriptVariant(
  selectedVariants: Record<string, string>,
  scripts: ScriptEntry[],
  cursor: number,
  service: DevtoolsService,
  direction: -1 | 1,
): void {
  const current = scripts[cursor];
  if (!current || isScriptGroup(current) || !current.variant) {
    return;
  }
  const currentValue = getSelectedVariantValue(current, selectedVariants);
  const currentIndex = Math.max(0, current.variant.values.indexOf(currentValue));
  const nextIndex = (currentIndex + direction + current.variant.values.length) % current.variant.values.length;
  selectedVariants[current.scriptId] = current.variant.values[nextIndex]!;
  saveSelectedVariants(service.config, selectedVariants);
}

function cycleDraftScriptVariant(
  draft: ScheduledJobDraft,
  scripts: ScriptEntry[],
  cursor: number,
  direction: -1 | 1,
): void {
  const current = scripts[cursor];
  if (!current || isScriptGroup(current) || !current.variant) {
    return;
  }
  const currentValue = getSelectedVariantValue(current, draft.selectedVariants);
  const currentIndex = Math.max(0, current.variant.values.indexOf(currentValue));
  const nextIndex = (currentIndex + direction + current.variant.values.length) % current.variant.values.length;
  draft.selectedVariants[current.scriptId] = current.variant.values[nextIndex]!;
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

async function runSelectedScript(service: DevtoolsService, state: TuiState, scripts: ScriptEntry[]): Promise<void> {
  const selectedProjects = getSelectedProjects(state);
  const selectedScript = scripts[state.scriptCursor];
  if (!selectedScript || selectedProjects.length === 0) {
    state.logs.push("Select at least one project and one script.");
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
  }
}

function getScheduleFields(schedule: ScheduleDefinition): ScheduleField[] {
  const fields: ScheduleField[] = ["type"];
  if (schedule.kind === "weekly") {
    fields.push("weekday");
  }
  if (schedule.kind === "daily" || schedule.kind === "weekly") {
    fields.push("hour", "minute");
  }
  fields.push("enabled", "save");
  return fields;
}

function mutateScheduleField(draft: ScheduledJobDraft, field: ScheduleField, direction: -1 | 1): void {
  if (field === "type") {
    const kinds: ScheduleDefinition["kind"][] = ["hourly", "daily", "weekly"];
    const currentIndex = kinds.indexOf(draft.schedule.kind);
    const nextKind = kinds[(currentIndex + direction + kinds.length) % kinds.length]!;
    if (nextKind === "hourly") {
      draft.schedule = { kind: "hourly" };
    } else if (nextKind === "daily") {
      draft.schedule = { kind: "daily", time: getScheduleTime(draft.schedule) };
    } else {
      draft.schedule = { kind: "weekly", weekday: getScheduleWeekday(draft.schedule), time: getScheduleTime(draft.schedule) };
    }
    return;
  }
  if (field === "weekday" && draft.schedule.kind === "weekly") {
    const weekdays: ScheduledWeekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const currentIndex = weekdays.indexOf(draft.schedule.weekday);
    draft.schedule.weekday = weekdays[(currentIndex + direction + weekdays.length) % weekdays.length]!;
    return;
  }
  if (field === "hour" || field === "minute") {
    const [hour, minute] = getScheduleTime(draft.schedule).split(":").map((part) => Number(part));
    const nextHour = field === "hour" ? wrapNumber(hour + direction, 0, 23) : hour;
    const nextMinute = field === "minute" ? wrapNumber(minute + direction, 0, 59) : minute;
    const nextTime = `${String(nextHour).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}`;
    if (draft.schedule.kind === "daily") {
      draft.schedule.time = nextTime;
    }
    if (draft.schedule.kind === "weekly") {
      draft.schedule.time = nextTime;
    }
    return;
  }
  if (field === "enabled") {
    draft.enabled = !draft.enabled;
  }
}

function saveScheduledJobDraft(service: DevtoolsService, draft: ScheduledJobDraft): ScheduledJob {
  const projects = service.listProjects({ explicitPaths: draft.projectPaths, refresh: true });
  const scripts = service.listScripts(projects);
  const name = buildScheduledJobName(draft, scripts, projects);
  if (draft.sourceJob) {
    return service.saveScheduledJob({
      ...draft.sourceJob,
      name,
      enabled: draft.enabled,
      projectPaths: [...draft.projectPaths],
      selectedScriptIds: [...draft.selectedScriptIds],
      selectedVariants: { ...draft.selectedVariants },
      schedule: cloneSchedule(draft.schedule),
    });
  }
  return service.createScheduledJob({
    name,
    enabled: draft.enabled,
    projectPaths: [...draft.projectPaths],
    selectedScriptIds: [...draft.selectedScriptIds],
    selectedVariants: { ...draft.selectedVariants },
    schedule: cloneSchedule(draft.schedule),
  });
}

function buildScheduledJobName(draft: ScheduledJobDraft, scripts: ScriptEntry[], projects: Project[]): string {
  const firstScript = scripts.find((script) => draft.selectedScriptIds.includes(script.scriptId));
  const scriptLabel = firstScript ? firstScript.name : "Scheduled job";
  return `${scriptLabel} (${projects.length} project(s), ${formatScheduleSummary(draft.schedule)})`;
}

function buildDraftProjectSummary(draft: ScheduledJobDraft): string {
  return `${draft.projectPaths.length} project(s)`;
}

function formatScheduleField(field: ScheduleField, draft: ScheduledJobDraft): string {
  switch (field) {
    case "type":
      return `Type: ${highlightVariantLabel(draft.schedule.kind)}`;
    case "weekday":
      return `Weekday: ${highlightVariantLabel(getScheduleWeekday(draft.schedule))}`;
    case "hour":
      return `Hour: ${highlightVariantLabel(getScheduleTime(draft.schedule).slice(0, 2))}`;
    case "minute":
      return `Minute: ${highlightVariantLabel(getScheduleTime(draft.schedule).slice(3, 5))}`;
    case "enabled":
      return `Enabled: ${highlightVariantLabel(draft.enabled ? "yes" : "no")}`;
    case "save":
      return "Save scheduled job";
  }
}

function getScheduleTime(schedule: ScheduleDefinition): string {
  if (schedule.kind === "hourly") {
    return "00:00";
  }
  return schedule.time;
}

function getScheduleWeekday(schedule: ScheduleDefinition): ScheduledWeekday {
  if (schedule.kind !== "weekly") {
    return "monday";
  }
  return schedule.weekday;
}

function wrapNumber(value: number, min: number, max: number): number {
  if (value < min) {
    return max;
  }
  if (value > max) {
    return min;
  }
  return value;
}

function formatScheduledJob(job: ScheduledJob): string {
  const status = job.enabled ? "enabled" : "disabled";
  const lastRun = job.lastRunStatus ? ` | ${job.lastRunStatus}` : "";
  return `${job.name} [${status}] | ${job.projectPaths.length} project(s) | ${job.selectedScriptIds.length} script(s) | ${formatScheduleSummary(job.schedule)}${lastRun}`;
}

function formatScheduleSummary(schedule: ScheduleDefinition): string {
  if (schedule.kind === "hourly") {
    return "hourly";
  }
  if (schedule.kind === "daily") {
    return `daily ${schedule.time}`;
  }
  return `weekly ${schedule.weekday} ${schedule.time}`;
}

function cloneSchedule(schedule: ScheduleDefinition): ScheduleDefinition {
  if (schedule.kind === "hourly") {
    return { kind: "hourly" };
  }
  if (schedule.kind === "daily") {
    return { kind: "daily", time: schedule.time };
  }
  return { kind: "weekly", weekday: schedule.weekday, time: schedule.time };
}

function formatKeybinding(keys: string[], action: string): string {
  return `${keys.map((key) => color(key, "cyan")).join("/")}${color(":", "yellow")} ${action}`;
}

function isCommandKey(key: readline.Key, name: string): boolean {
  return key.name === name && (Boolean(key.ctrl) || Boolean(key.meta));
}

function isJobsKey(input: string | undefined, key: readline.Key): boolean {
  return isCommandKey(key, "j") || input === "\n";
}

function isControlCharacter(input: string): boolean {
  return input.charCodeAt(0) < 32 || input.charCodeAt(0) === 127;
}

function getCronMenuOptions(state: Pick<TuiState, "projects" | "selectedProjectIds">): CronMenuOption[] {
  const options: CronMenuOption[] = [];
  if (getSelectedProjects(state).length > 0) {
    options.push("create");
  }
  options.push("manage", "back");
  return options;
}
