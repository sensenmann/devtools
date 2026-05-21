import fs from "node:fs";
import readline from "node:readline";

import { loadFavoriteProjectPaths, loadFavoriteScriptIds, toggleFavoriteProject, toggleFavoriteScript } from "./favorites.ts";
import { isScriptGroup } from "./registry.ts";
import { loadSchedulerStatus } from "./scheduler-status.ts";
import { getLatestDueTime, getNextDueTime, POLL_INTERVAL_MS } from "./scheduler.ts";
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

type FocusPane = "projects" | "scripts" | "jobs";
type TuiMode = "main" | "run-confirm" | "cron-menu" | "cron-script-select" | "cron-schedule-edit" | "cron-job-list" | "cron-job-delete-confirm";
type CronMenuOption = "create" | "manage" | "back";
type CronJobFlowOrigin = "main" | "cron-menu" | "cron-job-list";
type ScheduleField = "type" | "weekday" | "hour" | "minute" | "enabled" | "save";
type DeleteConfirmOption = "yes" | "no";
type RunConfirmOption = "yes" | "no";

type MainJobEntry =
  | { kind: "create"; label: string }
  | { kind: "job"; job: ScheduledJob };

interface JobTableLayout {
  nameWidth: number;
  scheduleWidth: number;
  lastDueWidth: number;
  nextDueWidth: number;
  statusWidth: number;
}

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
  scriptFilter: string;
  projectFilter: string;
  focusPane: FocusPane;
  projectCursor: number;
  scriptCursor: number;
  projectScrollOffset: number;
  scriptScrollOffset: number;
  selectedProjectIds: string[];
  favoriteProjectPaths: string[];
  favoriteScriptIds: string[];
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
  deleteConfirmCursor: number;
  pendingDeleteJob?: ScheduledJob;
  deleteConfirmOrigin: "main" | "cron-job-list";
  runConfirmCursor: number;
  pendingRun?: {
    script: ScriptEntry;
    selectedProjects: Project[];
  };
}

export async function runTui(service: DevtoolsService): Promise<void> {
  const state: TuiState = {
    projects: service.refreshProjects(),
    scriptFilter: "",
    projectFilter: "",
    focusPane: "scripts",
    projectCursor: 0,
    scriptCursor: 0,
    projectScrollOffset: 0,
    scriptScrollOffset: 0,
    selectedProjectIds: [],
    favoriteProjectPaths: loadFavoriteProjectPaths(service.config),
    favoriteScriptIds: loadFavoriteScriptIds(service.config),
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
    cronJobFlowOrigin: "main",
    deleteConfirmCursor: 1,
    deleteConfirmOrigin: "main",
    runConfirmCursor: 1,
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
        case "run-confirm":
          handleRunConfirmKeypress(service, state, key);
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
        case "cron-job-delete-confirm":
          handleCronJobDeleteConfirmKeypress(service, state, input, key);
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
  if (key.name === "left") {
    state.focusPane = state.focusPane === "jobs" ? "projects" : state.focusPane === "projects" ? "scripts" : "scripts";
    return false;
  }
  if (key.name === "right") {
    state.focusPane = state.focusPane === "scripts" ? "projects" : state.focusPane === "projects" ? "jobs" : "jobs";
    return false;
  }
  if (isCommandKey(key, "r")) {
    state.projects = service.refreshProjects();
    state.scheduledJobs = service.listScheduledJobs();
    state.logs.push(`Refreshed top-level project cache (${state.projects.length} project(s)).`);
    return false;
  }
  const scripts = getScripts(service, state);
  state.scriptCursor = Math.min(state.scriptCursor, Math.max(0, scripts.length - 1));
  state.scriptScrollOffset = clampScrollOffset(state.scriptCursor, state.scriptScrollOffset, scripts.length, Math.max(1, service.config.tui.projectRows));
  if (state.focusPane === "projects") {
    handleProjectInput(service, state, input, key, service.config.tui.projectSort, scripts);
    return false;
  }
  if (state.focusPane === "jobs") {
    handleMainJobsInput(service, state, input, key);
    return false;
  }
  const pageSize = Math.max(1, service.config.tui.projectRows);
  if (key.name === "pageup") {
    state.scriptCursor = Math.max(0, state.scriptCursor - pageSize);
    return false;
  }
  if (key.name === "pagedown") {
    state.scriptCursor = Math.min(Math.max(0, scripts.length - 1), state.scriptCursor + pageSize);
    return false;
  }
  if (key.name === "backspace") {
    state.scriptFilter = state.scriptFilter.slice(0, -1);
    state.scriptCursor = 0;
    return false;
  }
  if (typeof input === "string" && input.length === 1 && !key.ctrl && !key.meta && !isControlCharacter(input)) {
    state.scriptFilter += input;
    state.scriptCursor = 0;
    return false;
  }
  if (key.name === "up") {
    state.scriptCursor = Math.max(0, state.scriptCursor - 1);
    return false;
  }
  if (key.name === "down") {
    state.scriptCursor = Math.min(scripts.length - 1, state.scriptCursor + 1);
    return false;
  }
  if (isCommandKey(key, "f")) {
    const current = scripts[state.scriptCursor];
    if (!current) {
      return false;
    }
    state.favoriteScriptIds = toggleFavoriteScript(service.config, state.favoriteScriptIds, current);
    return false;
  }
  if (key.name === "tab") {
    cycleScriptVariant(state.selectedVariants, scripts, state.scriptCursor, service, 1);
    return false;
  }
  if (key.name === "return") {
    requestRunConfirmation(service, state, scripts);
  }
  return false;
}

function handleProjectInput(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
  projectSort: "alphabetical" | "modified",
  scripts: ScriptEntry[],
): void {
  const selectedScript = scripts[state.scriptCursor];
  const filteredProjects = getFilteredProjectsForScript(service, state, projectSort, selectedScript);
  const pageSize = Math.max(1, service.config.tui.projectRows);
  if (key.name === "up") {
    state.projectCursor = Math.max(0, state.projectCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.projectCursor = Math.min(filteredProjects.length - 1, state.projectCursor + 1);
    return;
  }
  if (key.name === "pageup") {
    state.projectCursor = Math.max(0, state.projectCursor - pageSize);
    return;
  }
  if (key.name === "pagedown") {
    state.projectCursor = Math.min(Math.max(0, filteredProjects.length - 1), state.projectCursor + pageSize);
    return;
  }
  if (key.name === "return") {
    requestRunConfirmation(service, state, scripts);
    return;
  }
  if (input === " ") {
    const current = filteredProjects[state.projectCursor];
    if (!current) {
      return;
    }
    if (state.selectedProjectIds.includes(current.identity)) {
      state.selectedProjectIds = state.selectedProjectIds.filter((item) => item !== current.identity);
    } else {
      state.selectedProjectIds = [...state.selectedProjectIds, current.identity];
    }
    state.projectCursor = Math.min(filteredProjects.length - 1, state.projectCursor + 1);
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
    state.projectFilter = state.projectFilter.slice(0, -1);
    state.projectCursor = 0;
    return;
  }
  if (typeof input === "string" && input.length === 1 && !key.ctrl && !key.meta && !isControlCharacter(input)) {
    state.projectFilter += input;
    state.projectCursor = 0;
  }
}

function handleMainJobsInput(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const jobs = getMainJobEntries(state);
  const pageSize = Math.max(1, service.config.tui.projectRows);
  if (key.name === "up") {
    state.cronJobCursor = Math.max(0, state.cronJobCursor - 1);
    return;
  }
  if (key.name === "down") {
    state.cronJobCursor = Math.min(Math.max(0, jobs.length - 1), state.cronJobCursor + 1);
    return;
  }
  if (key.name === "pageup") {
    state.cronJobCursor = Math.max(0, state.cronJobCursor - pageSize);
    return;
  }
  if (key.name === "pagedown") {
    state.cronJobCursor = Math.min(Math.max(0, jobs.length - 1), state.cronJobCursor + pageSize);
    return;
  }
  const current = jobs[state.cronJobCursor];
  if (!current) {
    return;
  }
  if (key.name === "return") {
    if (current.kind === "create") {
      openCreateScheduledJob(state);
      return;
    }
    openEditScheduledJob(state, current.job);
    return;
  }
  if (isCommandKey(key, "c") || input === "c" || input === "C") {
    openCreateScheduledJob(state);
    return;
  }
  if (key.name === "space" && current.kind === "job") {
    current.job.enabled = !current.job.enabled;
    service.saveScheduledJob(current.job);
    state.scheduledJobs = service.listScheduledJobs();
    return;
  }
  if (isCommandKey(key, "e") || input === "e" || input === "E") {
    if (current.kind === "create") {
      openCreateScheduledJob(state);
      return;
    }
    openEditScheduledJob(state, current.job);
    return;
  }
  if ((isCommandKey(key, "d") || input === "d" || input === "D") && current.kind === "job") {
    state.pendingDeleteJob = current.job;
    state.deleteConfirmCursor = 1;
    state.deleteConfirmOrigin = "main";
    state.mode = "cron-job-delete-confirm";
  }
}

function handleRunConfirmKeypress(
  service: DevtoolsService,
  state: TuiState,
  key: readline.Key,
): void {
  const pendingRun = state.pendingRun;
  if (!pendingRun) {
    state.mode = "main";
    return;
  }
  const options: RunConfirmOption[] = ["yes", "no"];
  if (key.name === "escape") {
    state.pendingRun = undefined;
    state.runConfirmCursor = 1;
    state.mode = "main";
    return;
  }
  if (key.name === "left" || key.name === "up") {
    state.runConfirmCursor = Math.max(0, state.runConfirmCursor - 1);
    return;
  }
  if (key.name === "right" || key.name === "down") {
    state.runConfirmCursor = Math.min(options.length - 1, state.runConfirmCursor + 1);
    return;
  }
  if (key.name !== "return") {
    return;
  }
  const selectedOption = options[state.runConfirmCursor];
  const runRequest = pendingRun;
  state.pendingRun = undefined;
  state.runConfirmCursor = 1;
  state.mode = "main";
  if (selectedOption === "yes") {
    const scripts = getScripts(service, state);
    void runSelectedScript(service, state, scripts, runRequest.script, runRequest.selectedProjects);
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
  const scripts = getDraftScripts(service, state.favoriteScriptIds, draft);
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
  if (key.name === "tab") {
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
  if (key.name === "tab") {
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
    state.mode = state.cronJobFlowOrigin === "main" ? "main" : "cron-job-list";
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
    state.pendingDeleteJob = current;
    state.deleteConfirmCursor = 1;
    state.deleteConfirmOrigin = "cron-job-list";
    state.mode = "cron-job-delete-confirm";
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

function handleCronJobDeleteConfirmKeypress(
  service: DevtoolsService,
  state: TuiState,
  input: string | undefined,
  key: readline.Key,
): void {
  const pendingDeleteJob = state.pendingDeleteJob;
  if (!pendingDeleteJob) {
    state.mode = "cron-job-list";
    return;
  }
  const options: DeleteConfirmOption[] = ["yes", "no"];
  if (key.name === "escape" || isJobsKey(input, key)) {
    state.pendingDeleteJob = undefined;
    state.deleteConfirmCursor = 1;
    state.mode = state.deleteConfirmOrigin;
    return;
  }
  if (key.name === "left" || key.name === "up") {
    state.deleteConfirmCursor = Math.max(0, state.deleteConfirmCursor - 1);
    return;
  }
  if (key.name === "right" || key.name === "down") {
    state.deleteConfirmCursor = Math.min(options.length - 1, state.deleteConfirmCursor + 1);
    return;
  }
  if (key.name !== "return") {
    return;
  }

  const selectedOption = options[state.deleteConfirmCursor];
  if (selectedOption === "yes") {
    service.deleteScheduledJob(pendingDeleteJob.jobId);
    state.scheduledJobs = service.listScheduledJobs();
    state.logs = [`Deleted scheduled job: ${pendingDeleteJob.name}`];
    state.cronJobCursor = Math.min(state.cronJobCursor, Math.max(0, state.scheduledJobs.length - 1));
  }
  state.pendingDeleteJob = undefined;
  state.deleteConfirmCursor = 1;
  state.mode = state.deleteConfirmOrigin;
}

function renderFrame(service: DevtoolsService, state: TuiState): void {
  switch (state.mode) {
    case "main":
      renderMainFrame(service, state);
      return;
    case "run-confirm":
      renderRunConfirmFrame(service, state);
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
    case "cron-job-delete-confirm":
      renderCronJobDeleteConfirmFrame(service, state);
      return;
  }
}

function renderMainFrame(service: DevtoolsService, state: TuiState): void {
  const columns = process.stdout.columns ?? 120;
  const configuredWidth = service.config.tui.width;
  const width = Math.max(60, configuredWidth ? Math.min(columns, configuredWidth) : Math.max(100, columns));
  const innerWidth = width - 2;
  const paneGap = "   ";
  const jobSeparator = color(" │ ", "gray");
  const contentWidth = innerWidth - stripAnsi(paneGap).length - stripAnsi(jobSeparator).length;
  const paneWidths = resolveMainPaneWidths(
    contentWidth,
    service.config.tui.scriptsPercent,
    service.config.tui.projectsPercent,
    service.config.tui.jobsPercent,
  );
  const scriptsWidth = paneWidths.scripts;
  const projectsWidth = paneWidths.projects;
  const jobsWidth = paneWidths.jobs;
  const scripts = getScripts(service, state);
  const jobs = getMainJobEntries(state);
  const rowCount = service.config.tui.projectRows;
  state.scriptCursor = Math.min(state.scriptCursor, Math.max(0, scripts.length - 1));
  state.cronJobCursor = Math.min(state.cronJobCursor, Math.max(0, jobs.length - 1));
  state.scriptScrollOffset = clampScrollOffset(state.scriptCursor, state.scriptScrollOffset, scripts.length, rowCount);
  state.cronJobScrollOffset = clampScrollOffset(state.cronJobCursor, state.cronJobScrollOffset, jobs.length, rowCount);
  const selectedScript = scripts[state.scriptCursor];
  const filteredProjects = getFilteredProjectsForScript(service, state, service.config.tui.projectSort, selectedScript);
  state.projectCursor = Math.min(state.projectCursor, Math.max(0, filteredProjects.length - 1));
  state.projectScrollOffset = clampScrollOffset(state.projectCursor, state.projectScrollOffset, filteredProjects.length, rowCount);
  const visibleProjects = filteredProjects.slice(state.projectScrollOffset, state.projectScrollOffset + rowCount);
  const visibleScripts = scripts.slice(state.scriptScrollOffset, state.scriptScrollOffset + rowCount);
  const visibleJobs = jobs.slice(state.cronJobScrollOffset, state.cronJobScrollOffset + rowCount);
  const jobTableLayout = buildJobTableLayout(visibleJobs, new Date(), jobsWidth);
  const activeProjectRow = state.projectCursor - state.projectScrollOffset;
  const activeScriptRow = state.scriptCursor - state.scriptScrollOffset;
  const activeJobRow = state.cronJobCursor - state.cronJobScrollOffset;
  const showGlobalProjectsHint = !!selectedScript && !isScriptGroup(selectedScript) && selectedScript.scope === "global";

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("devtools", "cyan")}  focus: ${state.focusPane} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${renderMainKeyHelp(state.focusPane)} `, width));
  lines.push(drawHorizontal("divider", width));
  lines.push(drawLine(
    `${pad(formatPaneTitle("Scripts", state.scriptFilter), scriptsWidth)}${paneGap}${pad(formatPaneTitle("Projects", state.projectFilter), projectsWidth)}${jobSeparator}${pad(color("Jobs", "cyan"), jobsWidth)}`,
    width,
  ));
  lines.push(drawHorizontal("divider", width));
  lines.push(drawLine(
    `${pad("", scriptsWidth)}${paneGap}${pad("", projectsWidth)}${jobSeparator}${pad(formatJobTableHeader(jobTableLayout), jobsWidth)}`,
    width,
  ));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const script = visibleScripts[index];
    const project = visibleProjects[index];
    const job = visibleJobs[index];
    const scriptText = script ? formatScriptEntry(script, state.selectedVariants, state.favoriteScriptIds) : "";
    const projectText = project
      ? `${state.selectedProjectIds.includes(project.identity) ? "[x]" : "[ ]"} ${state.favoriteProjectPaths.includes(project.path) ? "⭐️ " : ""}${project.name} [${project.projectTypes.join(",")}]`
      : showGlobalProjectsHint && index === 0
        ? color("<Globales Script>", "gray")
        : "";
    const jobText = job ? formatMainJobEntry(job, new Date(), jobTableLayout) : "";
    lines.push(drawLine(
      `${highlightWithSelectionState(scriptText, pad(scriptText, scriptsWidth), state.focusPane === "scripts" && index === activeScriptRow, state.focusPane !== "scripts" && index === activeScriptRow)}${paneGap}${highlightWithSelectionState(projectText, pad(projectText, projectsWidth), state.focusPane === "projects" && index === activeProjectRow, Boolean(project) && state.selectedProjectIds.includes(project.identity) && !(state.focusPane === "projects" && index === activeProjectRow))}${jobSeparator}${highlight(jobText, pad(jobText, jobsWidth), state.focusPane === "jobs" && index === activeJobRow)}`,
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

function resolveMainPaneWidths(
  availableWidth: number,
  scriptsPercent = 42,
  projectsPercent = 28,
  jobsPercent = 30,
): { scripts: number; projects: number; jobs: number } {
  const safeAvailable = Math.max(24, availableWidth);
  const total = Math.max(1, scriptsPercent + projectsPercent + jobsPercent);
  const scripts = Math.max(12, Math.floor(safeAvailable * (scriptsPercent / total)));
  const projects = Math.max(12, Math.floor(safeAvailable * (projectsPercent / total)));
  const jobs = Math.max(12, safeAvailable - scripts - projects);

  if (scripts + projects + jobs === safeAvailable) {
    return { scripts, projects, jobs };
  }

  const adjustedJobs = Math.max(12, safeAvailable - scripts - projects);
  const adjustedProjects = Math.max(12, safeAvailable - scripts - adjustedJobs);
  return {
    scripts: Math.max(12, safeAvailable - adjustedProjects - adjustedJobs),
    projects: adjustedProjects,
    jobs: adjustedJobs,
  };
}

function renderRunConfirmFrame(service: DevtoolsService, state: TuiState): void {
  const pendingRun = state.pendingRun;
  if (!pendingRun) {
    renderMainFrame(service, state);
    return;
  }
  const options: Array<{ label: string; key: RunConfirmOption }> = [
    { label: "Yes", key: "yes" },
    { label: "No", key: "no" },
  ];
  const projectCount = pendingRun.selectedProjects.length;
  const scopeText = !isScriptGroup(pendingRun.script) && pendingRun.script.scope === "global"
    ? color("0", "cyan")
    : color(String(projectCount), "cyan");
  renderSimpleMenu(
    service,
    "Confirm Run",
    `Executing ${color(pendingRun.script.name, "yellow")} on ${scopeText} project(s)?`,
    options.map((option) => option.label),
    state.runConfirmCursor,
    ` ${color("keys:", "yellow")} ${formatKeybinding(["Enter"], "confirm")}  ${formatKeybinding(["←/→"], "choose")}  ${formatKeybinding(["Esc"], "cancel")} `,
  );
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
  const scripts = getDraftScripts(service, state.favoriteScriptIds, draft);
  state.cronScriptCursor = Math.min(state.cronScriptCursor, Math.max(0, scripts.length - 1));
  state.cronScriptScrollOffset = clampScrollOffset(state.cronScriptCursor, state.cronScriptScrollOffset, scripts.length, rowCount);
  const visibleScripts = scripts.slice(state.cronScriptScrollOffset, state.cronScriptScrollOffset + rowCount);
  const activeRow = state.cronScriptCursor - state.cronScriptScrollOffset;
  const projectSummary = buildDraftProjectSummary(draft);

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("Scheduled Job", "magenta")}  ${projectSummary} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["Space"], "toggle")}  ${formatKeybinding(["Tab"], "option")}  ${formatKeybinding(["Enter"], "next")}  ${formatKeybinding(["^J"], "back")} `, width));
  lines.push(drawHorizontal("divider", width));
  lines.push(drawLine(` ${color("Scripts & Groups", "cyan")} `, width));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const script = visibleScripts[index];
    const text = script
      ? `${draft.selectedScriptIds.includes(script.scriptId) ? "[x]" : "[ ]"} ${formatScriptEntry(script, draft.selectedVariants, state.favoriteScriptIds)}`
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
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["Tab"], "change")}  ${formatKeybinding(["Enter"], "save")}  ${formatKeybinding(["^J"], "back")} `, width));
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
  const schedulerStatus = loadSchedulerStatus(service.config);

  const lines: string[] = [];
  lines.push(drawHorizontal("top", width));
  lines.push(drawLine(` ${color("Scheduled Jobs", "magenta")}  total: ${jobs.length} `, width));
  lines.push(drawLine(` ${formatSchedulerStatusLine(schedulerStatus.lastHeartbeatAt)} `, width));
  lines.push(drawLine(` ${color("keys:", "yellow")} ${formatKeybinding(["Enter"], "edit")}  ${formatKeybinding(["Space"], "toggle enabled")}  ${formatKeybinding(["Backspace"], "delete")}  ${formatKeybinding(["^J"], "back")} `, width));
  lines.push(drawHorizontal("divider", width));
  for (let index = 0; index < rowCount; index += 1) {
    const job = visibleJobs[index];
    const text = job ? formatScheduledJob(job, new Date()) : "";
    lines.push(drawLine(highlight(text, pad(text, width - 2), index === activeRow), width));
  }
  lines.push(drawHorizontal("bottom", width));
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

function renderCronJobDeleteConfirmFrame(service: DevtoolsService, state: TuiState): void {
  const pendingDeleteJob = state.pendingDeleteJob;
  if (!pendingDeleteJob) {
    renderCronJobListFrame(service, state);
    return;
  }
  const options: Array<{ label: string; key: DeleteConfirmOption }> = [
    { label: "Yes, delete it", key: "yes" },
    { label: "No, keep it", key: "no" },
  ];
  state.deleteConfirmCursor = Math.min(state.deleteConfirmCursor, Math.max(0, options.length - 1));
  renderSimpleMenu(
    service,
    "Delete Scheduled Job",
    pendingDeleteJob.name,
    options.map((option) => option.label),
    state.deleteConfirmCursor,
    ` ${color("keys:", "yellow")} ${formatKeybinding(["Enter"], "confirm")}  ${formatKeybinding(["←/→"], "choose")}  ${formatKeybinding(["^J"], "cancel")} `,
  );
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
  state: Pick<TuiState, "projects" | "projectFilter" | "selectedProjectIds" | "favoriteProjectPaths">,
  projectSort: "alphabetical" | "modified",
): Project[] {
  const lowered = state.projectFilter.toLowerCase();
  return sortProjects(state.projects, projectSort, state.favoriteProjectPaths).filter((project) =>
    state.selectedProjectIds.includes(project.identity) ||
    lowered.length === 0 ||
    project.name.toLowerCase().includes(lowered) ||
    project.path.toLowerCase().includes(lowered),
  );
}

function getFilteredProjectsForScript(
  service: DevtoolsService,
  state: Pick<TuiState, "projects" | "projectFilter" | "selectedProjectIds" | "favoriteProjectPaths">,
  projectSort: "alphabetical" | "modified",
  script: ScriptEntry | undefined,
): Project[] {
  if (!script) {
    return [];
  }
  if (!isScriptGroup(script) && script.scope === "global") {
    return [];
  }
  return getFilteredProjects(
    {
      ...state,
      projects: state.projects.filter((project) => script.projectTypes.some((projectType) => project.projectTypes.includes(projectType))),
    },
    projectSort,
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

export function sortScriptEntriesForFavorites(scripts: ScriptEntry[], favoriteScriptIds: string[]): ScriptEntry[] {
  const blocks: Array<{ entries: ScriptEntry[]; favorite: boolean; index: number }> = [];

  for (let index = 0; index < scripts.length;) {
    const current = scripts[index]!;
    const entries: ScriptEntry[] = [current];
    index += 1;

    if (isScriptGroup(current)) {
      while (index < scripts.length) {
        const next = scripts[index]!;
        if (isScriptGroup(next) || next.group !== current.name) {
          break;
        }
        entries.push(next);
        index += 1;
      }
    }

    blocks.push({
      entries,
      favorite: entries.some((entry) => favoriteScriptIds.includes(entry.scriptId)),
      index: blocks.length,
    });
  }

  return blocks
    .sort((left, right) => {
      if (left.favorite !== right.favorite) {
        return left.favorite ? -1 : 1;
      }
      return left.index - right.index;
    })
    .flatMap((block) => block.entries);
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

function getMainJobEntries(state: Pick<TuiState, "projects" | "selectedProjectIds" | "scheduledJobs">): MainJobEntry[] {
  const entries: MainJobEntry[] = [];
  if (getSelectedProjects(state).length > 0) {
    entries.push({ kind: "create", label: "+ Create from current selection" });
  }
  entries.push(...state.scheduledJobs.map((job) => ({ kind: "job", job })));
  return entries;
}

function getScripts(
  service: DevtoolsService,
  state: Pick<TuiState, "favoriteScriptIds" | "scriptFilter">,
): ScriptEntry[] {
  return filterScriptEntries(
    sortScriptEntriesForFavorites(service.listScripts(), state.favoriteScriptIds),
    state.scriptFilter,
  );
}

function filterScriptEntries(scripts: ScriptEntry[], filter: string): ScriptEntry[] {
  const lowered = filter.trim().toLowerCase();
  if (lowered.length === 0) {
    return scripts;
  }

  const filtered: ScriptEntry[] = [];
  for (let index = 0; index < scripts.length;) {
    const current = scripts[index]!;
    if (!isScriptGroup(current)) {
      if (matchesScriptFilter(current, lowered)) {
        filtered.push(current);
      }
      index += 1;
      continue;
    }

    const children: ScriptEntry[] = [];
    index += 1;
    while (index < scripts.length) {
      const next = scripts[index]!;
      if (isScriptGroup(next) || next.group !== current.name) {
        break;
      }
      children.push(next);
      index += 1;
    }

    const groupMatches = matchesScriptFilter(current, lowered);
    const matchingChildren = children.filter((child) => matchesScriptFilter(child, lowered));
    if (!groupMatches && matchingChildren.length === 0) {
      continue;
    }
    filtered.push(current, ...(groupMatches ? children : matchingChildren));
  }

  return filtered;
}

function matchesScriptFilter(script: ScriptEntry, loweredFilter: string): boolean {
  return script.name.toLowerCase().includes(loweredFilter) || script.scriptId.toLowerCase().includes(loweredFilter);
}

function getDraftScripts(service: DevtoolsService, favoriteScriptIds: string[], draft: ScheduledJobDraft): ScriptEntry[] {
  const projects = service.listProjects({ explicitPaths: draft.projectPaths, refresh: true });
  return sortScriptEntriesForFavorites(service.listScripts(projects), favoriteScriptIds);
}

function replaceSummaryLogs(results: ExecutionResult[], logs: string[]): void {
  logs.length = 0;
  let failures = 0;
  for (const result of results) {
    logs.push(`[${result.success ? "OK" : "FAIL"}] ${result.project?.path ?? "global"}`);
    if (result.message) {
      logs.push(result.message);
    }
    if (!result.success) {
      failures += 1;
    }
  }
  logs.push(`Finished with ${failures} failure(s).`);
}

function requestRunConfirmation(
  service: DevtoolsService,
  state: TuiState,
  scripts: ScriptEntry[],
): void {
  const selectedProjects = getSelectedProjects(state);
  const selectedScript = scripts[state.scriptCursor];
  const isGlobalScript = !selectedScript || isScriptGroup(selectedScript) ? false : selectedScript.scope === "global";
  if (!selectedScript || (!isGlobalScript && selectedProjects.length === 0)) {
    state.logs.push(isGlobalScript ? "Select a script." : "Select at least one project and one script.");
    return;
  }
  if (!service.config.tui.confirmRun) {
    void runSelectedScript(service, state, scripts, selectedScript, selectedProjects);
    return;
  }
  state.pendingRun = {
    script: selectedScript,
    selectedProjects,
  };
  state.runConfirmCursor = 1;
  state.mode = "run-confirm";
}

function openCreateScheduledJob(state: TuiState): void {
  const selectedProjects = getSelectedProjects(state);
  if (selectedProjects.length === 0) {
    state.logs.push("Select at least one project before creating a scheduled job.");
    return;
  }
  state.jobDraft = {
    projectPaths: selectedProjects.map((project) => project.path),
    selectedScriptIds: [],
    selectedVariants: { ...state.selectedVariants },
    schedule: { kind: "hourly" },
    enabled: true,
  };
  state.cronJobFlowOrigin = "main";
  state.cronScriptCursor = 0;
  state.cronScriptScrollOffset = 0;
  state.mode = "cron-script-select";
}

function openEditScheduledJob(state: TuiState, job: ScheduledJob): void {
  state.jobDraft = {
    sourceJob: job,
    projectPaths: [...job.projectPaths],
    selectedScriptIds: [...job.selectedScriptIds],
    selectedVariants: { ...job.selectedVariants },
    schedule: cloneSchedule(job.schedule),
    enabled: job.enabled,
  };
  state.cronJobFlowOrigin = "main";
  state.cronScriptCursor = 0;
  state.cronScriptScrollOffset = 0;
  state.mode = "cron-script-select";
}

function waitForResume(state: Pick<TuiState, "awaitingResume" | "resumeResolver">): Promise<void> {
  state.awaitingResume = true;
  return new Promise<void>((resolve) => {
    state.resumeResolver = resolve;
  });
}

function showRunView(script: ScriptEntry, projectCount: number): void {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h\x1b[0m");
  const scopeLabel = !isScriptGroup(script) && script.scope === "global"
    ? "global"
    : `${projectCount} project(s)`;
  process.stdout.write(`${color("Running", "yellow")} ${script.scriptId} on ${scopeLabel}\n\n`);
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

function color(value: string, tone: "cyan" | "magenta" | "yellow" | "gray"): string {
  const code = tone === "cyan" ? "36" : tone === "magenta" ? "35" : tone === "yellow" ? "33" : "90";
  return `\x1b[${code}m${value}\x1b[0m`;
}

function highlight(original: string, padded: string, active: boolean): string {
  if (!active || !original) {
    return padded;
  }
  return `\x1b[30;103m${padded}\x1b[0m`;
}

function highlightWithSelectionState(original: string, padded: string, active: boolean, selected: boolean): string {
  if (active) {
    return highlight(original, padded, true);
  }
  if (!selected || !original) {
    return padded;
  }
  return `\x1b[30;47m${padded}\x1b[0m`;
}

function highlightInput(value: string): string {
  if (value.length === 0) {
    return " ";
  }
  return `\x1b[30;103m ${value} \x1b[0m`;
}

function formatPaneTitle(label: string, filter: string): string {
  if (filter.length === 0) {
    return color(label, "cyan");
  }
  return `${color(label, "cyan")}  filter: ${highlightInput(filter)}`;
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

function renderMainKeyHelp(focusPane: FocusPane): string {
  const segments = ["←/→: pane", renderWordShortcut("Reload project list", "R")];
  if (focusPane === "scripts") {
    segments.unshift(renderWordShortcut("Favorite", "F"));
    segments.push("Tab: option", "Enter: run");
  } else if (focusPane === "projects") {
    segments.unshift(renderWordShortcut("Select All", "A"), renderWordShortcut("Favorite", "F"));
    segments.push("Space: toggle", "Enter: run");
  } else {
    segments.unshift(renderWordShortcut("Create Job", "C"));
    segments.push(renderWordShortcut("Edit Job", "E"), renderWordShortcut("Delete Job", "D"), "Space: toggle enabled");
  }
  segments.push(renderWordShortcut("Quit", "Q"));
  return segments.join(color(" | ", "yellow"));
}

function formatMainJobEntry(entry: MainJobEntry, now: Date, layout: JobTableLayout): string {
  if (entry.kind === "create") {
    return formatJobTableCells(
      [color(entry.label, "cyan"), "", "", "", ""],
      layout,
    );
  }
  return formatScheduledJobTableRow(entry.job, now, layout);
}

function formatScriptEntry(
  script: ScriptEntry,
  selectedVariants: Record<string, string>,
  favoriteScriptIds: string[] = [],
): string {
  const favoritePrefix = favoriteScriptIds.includes(script.scriptId) ? "⭐️ " : "";
  if (isScriptGroup(script)) {
    return `${favoritePrefix}▸ ${script.name}`;
  }
  const variantSuffix = script.variant ? ` ${highlightVariantLabel(getSelectedVariantValue(script, selectedVariants))}` : "";
  if (script.group) {
    return `${favoritePrefix}  ${script.name}${variantSuffix}`;
  }
  return `${favoritePrefix}${script.name}${variantSuffix}`;
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

async function runSelectedScript(
  service: DevtoolsService,
  state: TuiState,
  scripts: ScriptEntry[],
  selectedScriptOverride?: ScriptEntry,
  selectedProjectsOverride?: Project[],
): Promise<void> {
  const selectedProjects = selectedProjectsOverride ?? getSelectedProjects(state);
  const selectedScript = selectedScriptOverride ?? scripts[state.scriptCursor];
  const isGlobalScript = !selectedScript || isScriptGroup(selectedScript) ? false : selectedScript.scope === "global";
  if (!selectedScript || (!isGlobalScript && selectedProjects.length === 0)) {
    state.logs.push(isGlobalScript ? "Select a script." : "Select at least one project and one script.");
    return;
  }
  state.running = true;
  state.currentRunController = new AbortController();
  const projectCount = isGlobalScript ? 0 : selectedProjects.length;
  state.logs.push(`Ran ${selectedScript.scriptId} on ${isGlobalScript ? "global" : `${projectCount} project(s)`}.`);
  showRunView(selectedScript, projectCount);
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

function formatScheduledJob(job: ScheduledJob, now: Date): string {
  const status = job.enabled ? "enabled" : "disabled";
  const lastRun = job.lastRunStatus ? ` | ${job.lastRunStatus}` : "";
  const lastDue = formatShortDateTime(getLatestDueTime(job.schedule, now));
  const nextDue = formatShortDateTime(getNextDueTime(job.schedule, now));
  return `${job.name} [${status}] | last due ${lastDue} | next due ${nextDue}${lastRun}`;
}

function formatScheduledJobTableRow(job: ScheduledJob, now: Date, layout: JobTableLayout): string {
  const schedule = formatScheduleSummary(job.schedule);
  const lastDue = formatShortDateTime(getLatestDueTime(job.schedule, now));
  const nextDue = formatShortDateTime(getNextDueTime(job.schedule, now));
  const status = job.lastRunStatus ?? (job.enabled ? "enabled" : "disabled");

  return formatJobTableCells(
    [
      `${job.enabled ? "[x]" : "[ ]"} ${job.name}`,
      schedule,
      lastDue,
      nextDue,
      status,
    ],
    layout,
  );
}

function formatJobTableHeader(layout: JobTableLayout): string {
  return color(
    formatJobTableCells(["Name", "Schedule", "Last due", "Next due", "Status"], layout),
    "gray",
  );
}

function formatJobTableCells(values: [string, string, string, string, string], layout: JobTableLayout): string {
  return [
    pad(values[0], layout.nameWidth),
    pad(values[1], layout.scheduleWidth),
    pad(values[2], layout.lastDueWidth),
    pad(values[3], layout.nextDueWidth),
    pad(values[4], layout.statusWidth),
  ].join(" | ");
}

function buildJobTableLayout(entries: MainJobEntry[], now: Date, totalWidth: number): JobTableLayout {
  const rows: Array<[string, string, string, string, string]> = [
    ["Name", "Schedule", "Last due", "Next due", "Status"],
  ];

  for (const entry of entries) {
    if (entry.kind === "create") {
      rows.push([entry.label, "", "", "", ""]);
      continue;
    }
    rows.push([
      `${entry.job.enabled ? "[x]" : "[ ]"} ${entry.job.name}`,
      formatScheduleSummary(entry.job.schedule),
      formatShortDateTime(getLatestDueTime(entry.job.schedule, now)),
      formatShortDateTime(getNextDueTime(entry.job.schedule, now)),
      entry.job.lastRunStatus ?? (entry.job.enabled ? "enabled" : "disabled"),
    ]);
  }

  const separatorWidth = 12;
  const maxContentWidth = Math.max(24, totalWidth - separatorWidth);
  let widths: JobTableLayout = {
    nameWidth: 10,
    scheduleWidth: 8,
    lastDueWidth: 8,
    nextDueWidth: 8,
    statusWidth: 7,
  };

  for (const row of rows) {
    widths = {
      nameWidth: Math.max(widths.nameWidth, stripAnsi(row[0]).length),
      scheduleWidth: Math.max(widths.scheduleWidth, stripAnsi(row[1]).length),
      lastDueWidth: Math.max(widths.lastDueWidth, stripAnsi(row[2]).length),
      nextDueWidth: Math.max(widths.nextDueWidth, stripAnsi(row[3]).length),
      statusWidth: Math.max(widths.statusWidth, stripAnsi(row[4]).length),
    };
  }

  let used = widths.nameWidth + widths.scheduleWidth + widths.lastDueWidth + widths.nextDueWidth + widths.statusWidth;
  if (used <= maxContentWidth) {
    return widths;
  }

  const minWidths: JobTableLayout = {
    nameWidth: 10,
    scheduleWidth: 8,
    lastDueWidth: 8,
    nextDueWidth: 8,
    statusWidth: 7,
  };
  const order: Array<keyof JobTableLayout> = ["nameWidth", "scheduleWidth", "statusWidth", "lastDueWidth", "nextDueWidth"];
  while (used > maxContentWidth) {
    let reduced = false;
    for (const key of order) {
      if (widths[key] > minWidths[key] && used > maxContentWidth) {
        widths[key] -= 1;
        used -= 1;
        reduced = true;
      }
    }
    if (!reduced) {
      break;
    }
  }

  return widths;
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

function formatSchedulerStatusLine(lastHeartbeatAt?: string): string {
  if (!lastHeartbeatAt) {
    return `${color("runner", "yellow")}: idle`;
  }
  const lastHeartbeat = new Date(lastHeartbeatAt);
  const active = Date.now() - lastHeartbeat.getTime() <= POLL_INTERVAL_MS * 2 + 5_000;
  return `${color("runner", "yellow")}: ${active ? color("active", "cyan") : "idle"}  last beat ${formatShortDateTime(lastHeartbeat)}`;
}

function formatShortDateTime(date: Date | null | undefined): string {
  if (!date) {
    return "-";
  }
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function renderWordShortcut(label: string, letter: string): string {
  const index = label.toLowerCase().indexOf(letter.toLowerCase());
  if (index === -1) {
    return label;
  }
  const prefix = label.slice(0, index);
  const highlighted = `\x1b[4;36m${label[index]}\x1b[0m`;
  const suffix = label.slice(index + 1);
  return `${prefix}${highlighted}${suffix}`;
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
