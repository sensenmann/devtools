import fs from "node:fs";
import http from "node:http";
import type net from "node:net";

import { resolveExecutable } from "../../src/script-runtime.ts";
import { enrichReport, renderReportPage } from "./lib/report-html.ts";
import { adoptHighestVersion, analyzeProjects, analyzeProjectsForPathsWithProgress as analyzeCompareProjectsWithProgress, buildCompareReport, removeOverride, type ProjectPomAnalysis } from "./lib/pom.ts";
import { SERVER_IDLE_TIMEOUT_MS } from "./lib/constants.ts";
import { openInBrowser } from "./lib/open-browser.ts";

interface ServerState {
  projectPaths: string[];
}

export interface CompareServerSession {
  url: string;
  close: () => Promise<void>;
  closed: Promise<void>;
}

interface StartCompareServerOptions {
  projectPaths: string[];
  mode?: "fast" | "deep";
  enableDependencyUpdates?: boolean;
  defaultRepoBaseUrl?: string;
  repoOverrides?: Array<{ pattern: string; baseUrl: string }>;
  signal?: AbortSignal;
  openBrowser?: boolean;
  onStarted?: (url: string) => void;
}

export async function startCompareServer(options: StartCompareServerOptions): Promise<CompareServerSession> {
  const mvnPath = resolveExecutable("mvn");
  if (!mvnPath) {
    throw new Error("mvn was not found on PATH.");
  }

  const probeWriter = createProbeWriter();
  const actionLogger = createActionLogger(probeWriter);
  let lastAccess = Date.now();
  const mode = options.mode ?? "deep";
  const enableDependencyUpdates = options.enableDependencyUpdates !== false;
  let analyses = await loadReportAnalyses(options.projectPaths, mvnPath, mode, enableDependencyUpdates, probeWriter);
  let report = enrichReport({
    ...buildCompareReport(analyses),
    enableDependencyUpdates,
    repoDefaultBaseUrl: options.defaultRepoBaseUrl,
    repoOverrides: options.repoOverrides ?? [],
  });
  let interval: NodeJS.Timeout | undefined;
  let resolved = false;
  let closedResolve: (() => void) | undefined;
  const sockets = new Set<net.Socket>();
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const server = http.createServer(async (request, response) => {
    lastAccess = Date.now();
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderReportPage());
        return;
      }
      if (request.method === "GET" && request.url === "/api/report") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(report));
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/api/actions/")) {
        const body = await readJsonBody(request);
        let changedProjectPaths: string[] = [];
        if (request.url === "/api/actions/adopt-highest") {
          const row = report.rows.find((entry) => entry.rowId === body.rowId);
          const source = row?.cells.find((cell) => cell.isHighest && cell.present);
          const explicitTargets = Array.isArray(body.targetProjectPaths) ? body.targetProjectPaths.map(String) : [];
          const targets = explicitTargets.length > 0
            ? explicitTargets
            : body.allProjects
            ? (row?.cells.filter((cell) => cell.present && cell.projectPath !== source?.projectPath).map((cell) => cell.projectPath) ?? [])
            : body.targetProjectPath ? [String(body.targetProjectPath)] : [];
          actionLogger(`[action] adopt-highest ${String(body.rowId)}`);
          if (source?.projectPath) {
            actionLogger(`[source] ${source.projectPath}`);
          }
          for (const target of targets) {
            actionLogger(`[target] ${target}`);
          }
          await adoptHighestVersion(String(body.rowId), source?.projectPath, targets, mvnPath, actionLogger);
          changedProjectPaths = targets;
        } else if (request.url === "/api/actions/remove-override") {
          const row = report.rows.find((entry) => entry.rowId === body.rowId);
          const explicitTargets = Array.isArray(body.targetProjectPaths) ? body.targetProjectPaths.map(String) : [];
          const targets = explicitTargets.length > 0
            ? explicitTargets
            : body.allProjects
            ? (row?.cells.filter((cell) => cell.removeOverrideAvailable).map((cell) => cell.projectPath) ?? [])
            : body.targetProjectPath ? [String(body.targetProjectPath)] : [];
          actionLogger(`[action] remove-override ${String(body.rowId)}`);
          for (const target of targets) {
            actionLogger(`[target] ${target}`);
          }
          await removeOverride(String(body.rowId), targets, mvnPath, actionLogger);
          changedProjectPaths = targets;
        } else if (request.url === "/api/actions/reload-all") {
          actionLogger(`[action] reload-all ${options.projectPaths.length} project(s)`);
          for (const projectPath of options.projectPaths) {
            actionLogger(`[reload] ${projectPath}`);
          }
          analyses = await loadReportAnalyses(options.projectPaths, mvnPath, mode, enableDependencyUpdates, probeWriter);
          report = enrichReport({
            ...buildCompareReport(analyses),
            enableDependencyUpdates,
            repoDefaultBaseUrl: options.defaultRepoBaseUrl,
            repoOverrides: options.repoOverrides ?? [],
          });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            report,
            partialUpdate: false,
            changedProjectPaths: options.projectPaths,
          }));
          return;
        } else {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Unknown action." }));
          return;
        }
        if (changedProjectPaths.length > 0) {
          actionLogger(`[refresh] reloading ${changedProjectPaths.length} changed project(s)`);
          for (const projectPath of changedProjectPaths) {
            actionLogger(`[refresh] ${projectPath}`);
          }
          analyses = await refreshChangedProjects(analyses, changedProjectPaths, mvnPath, mode, enableDependencyUpdates, probeWriter);
          report = enrichReport({
            ...buildCompareReport(analyses),
            enableDependencyUpdates,
            repoDefaultBaseUrl: options.defaultRepoBaseUrl,
            repoOverrides: options.repoOverrides ?? [],
          });
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          report,
          partialUpdate: true,
          changedProjectPaths,
        }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Not found." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  const close = async () => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    if (!server.listening) {
      if (!resolved) {
        resolved = true;
        closedResolve?.();
      }
      return;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!resolved) {
      resolved = true;
      closedResolve?.();
    }
  };

  options.signal?.addEventListener("abort", () => {
    void close();
  }, { once: true });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine server address."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });

  options.onStarted?.(url);
  if (options.openBrowser !== false) {
    try {
      await openInBrowser(url);
    } catch {
      // Browser opening is best effort.
    }
  }

  interval = setInterval(() => {
    if (Date.now() - lastAccess < SERVER_IDLE_TIMEOUT_MS) {
      return;
    }
    void close();
  }, 30_000);
  interval.unref?.();

  return {
    url,
    close,
    closed,
  };
}

async function loadReportAnalyses(
  projectPaths: string[],
  mvnPath: string,
  mode: "fast" | "deep",
  includeDependencyUpdates: boolean,
  updateProbeLine: (message?: string) => void,
) {
  const analyses = await analyzeCompareProjectsWithProgress(projectPaths, mvnPath, mode, includeDependencyUpdates, (progress) => {
    const scope = progress.stage === "update"
      ? progress.propertyName
      : progress.propertyCount > 0
      ? `${progress.propertyIndex + 1}/${progress.propertyCount} ${progress.propertyName}`
      : mode === "fast"
        ? "provider baseline"
        : "no version properties";
    updateProbeLine(`[probe:${mode}] ${progress.projectIndex + 1}/${progress.projectCount} ${progress.projectName} :: ${scope}`);
  });
  updateProbeLine();
  return analyses;
}

async function refreshChangedProjects(
  currentAnalyses: ProjectPomAnalysis[],
  changedProjectPaths: string[],
  mvnPath: string,
  mode: "fast" | "deep",
  includeDependencyUpdates: boolean,
  updateProbeLine: (message?: string) => void,
): Promise<ProjectPomAnalysis[]> {
  const changedPaths = [...new Set(changedProjectPaths)];
  const changedProjects = currentAnalyses
    .map((analysis) => analysis.project)
    .filter((project) => changedPaths.includes(project.path));
  if (changedProjects.length === 0) {
    return currentAnalyses;
  }
  const refreshed = await analyzeProjects(changedProjects, mvnPath, mode, includeDependencyUpdates, undefined, undefined, "capture", (progress) => {
    const scope = progress.stage === "update"
      ? progress.propertyName
      : progress.propertyCount > 0
        ? `${progress.propertyIndex + 1}/${progress.propertyCount} ${progress.propertyName}`
        : mode === "fast"
          ? "provider baseline"
          : "no version properties";
    updateProbeLine(`[refresh:${mode}] ${progress.projectIndex + 1}/${progress.projectCount} ${progress.projectName} :: ${scope}`);
  });
  updateProbeLine();
  const refreshedByPath = new Map(refreshed.map((analysis) => [analysis.project.path, analysis]));
  return currentAnalyses.map((analysis) => refreshedByPath.get(analysis.project.path) ?? analysis);
}

function createProbeWriter(): (message?: string) => void {
  let active = false;
  return (message?: string) => {
    if (!process.stdout.isTTY) {
      return;
    }
    if (!message) {
      if (active) {
        process.stdout.write("\r\x1b[2K");
        active = false;
      }
      return;
    }
    active = true;
    process.stdout.write(`\r\x1b[2K${message}`);
  };
}

function createActionLogger(clearProbeLine: (message?: string) => void): (message: string) => void {
  return (message: string) => {
    clearProbeLine();
    process.stdout.write(`${message}\n`);
  };
}

async function main(): Promise<void> {
  const statePath = parseStatePath(process.argv.slice(2));
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as ServerState;
  const session = await startCompareServer({
    projectPaths: state.projectPaths,
    onStarted: (url) => {
      process.stdout.write(`Maven dependency compare server: ${url}\n`);
    },
  });
  await session.closed;
}

function parseStatePath(args: string[]): string {
  const index = args.indexOf("--state");
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    throw new Error("Missing --state argument.");
  }
  return value;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
