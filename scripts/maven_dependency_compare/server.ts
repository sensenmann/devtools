import fs from "node:fs";
import http from "node:http";
import type net from "node:net";

import { resolveExecutable } from "../../src/script-runtime.ts";
import { enrichReport, renderReportPage } from "./lib/report-html.ts";
import { adoptHighestVersion, analyzeProjectsForPathsWithProgress as analyzeCompareProjectsWithProgress, buildCompareReport, removeOverride } from "./lib/pom.ts";
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
  let lastAccess = Date.now();
  let report = enrichReport(buildCompareReport(await loadReportAnalyses(options.projectPaths, mvnPath, options.mode ?? "deep", probeWriter)));
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
        if (request.url === "/api/actions/adopt-highest") {
          const row = report.rows.find((entry) => entry.rowId === body.rowId);
          const source = row?.cells.find((cell) => cell.isHighest && cell.present);
          const explicitTargets = Array.isArray(body.targetProjectPaths) ? body.targetProjectPaths.map(String) : [];
          const targets = explicitTargets.length > 0
            ? explicitTargets
            : body.allProjects
            ? (row?.cells.filter((cell) => cell.present && cell.projectPath !== source?.projectPath).map((cell) => cell.projectPath) ?? [])
            : body.targetProjectPath ? [String(body.targetProjectPath)] : [];
          await adoptHighestVersion(String(body.rowId), source?.projectPath, targets, mvnPath);
        } else if (request.url === "/api/actions/remove-override") {
          const row = report.rows.find((entry) => entry.rowId === body.rowId);
          const explicitTargets = Array.isArray(body.targetProjectPaths) ? body.targetProjectPaths.map(String) : [];
          const targets = explicitTargets.length > 0
            ? explicitTargets
            : body.allProjects
            ? (row?.cells.filter((cell) => cell.removeOverrideAvailable).map((cell) => cell.projectPath) ?? [])
            : body.targetProjectPath ? [String(body.targetProjectPath)] : [];
          await removeOverride(String(body.rowId), targets, mvnPath);
        } else {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Unknown action." }));
          return;
        }
        report = enrichReport(buildCompareReport(await loadReportAnalyses(options.projectPaths, mvnPath, options.mode ?? "deep", probeWriter)));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(report));
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
  updateProbeLine: (message?: string) => void,
) {
  const analyses = await analyzeCompareProjectsWithProgress(projectPaths, mvnPath, mode, (progress) => {
    const scope = progress.propertyCount > 0
      ? `${progress.propertyIndex + 1}/${progress.propertyCount} ${progress.propertyName}`
      : mode === "fast"
        ? "provider baseline"
        : "no version properties";
    updateProbeLine(`[probe:${mode}] ${progress.projectIndex + 1}/${progress.projectCount} ${progress.projectName} :: ${scope}`);
  });
  updateProbeLine();
  return analyses;
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
