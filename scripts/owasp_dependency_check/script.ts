import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { resolveExecutable, runSingleCommand } from "../../src/script-runtime.ts";
import { buildDependencyTreeCommand, buildOwaspCommand } from "./lib/command.ts";
import { loadOwaspDependencyCheckConfig } from "./lib/config.ts";
import { ensureDatabaseAvailable } from "./lib/database.ts";
import { openReportInBrowser } from "./lib/open-report.ts";
import { buildProjectSummary, loadProjectSummaries, prepareReportPaths, resetLatestReportDirectory, writeAggregatedIndex, writeProjectSummary } from "./lib/reporting.ts";

export async function owaspDependencyCheck(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const mvnPath = resolveExecutable("mvn");
  if (!mvnPath) {
    return { success: false, message: "mvn was not found on PATH." };
  }

  if (!context.project) {
    return { success: false, message: "OWASP Dependency Check requires a selected Maven project." };
  }

  const config = loadOwaspDependencyCheckConfig(context.script.directory);
  const databaseState = await ensureDatabaseAvailable(config, context);
  if (!databaseState.success) {
    return { success: false, message: databaseState.message };
  }

  const projectRoot = path.resolve(context.project.path);
  const reportPaths = prepareReportPaths(config.reportDir);
  if ((context.batchProjectIndex ?? 0) === 0) {
    resetLatestReportDirectory(reportPaths.latestDir);
  }
  const mode = context.args.mode === "quick" ? "quick" : "full";
  const command = buildOwaspCommand(mvnPath, projectRoot, config.cacheDir, mode);
  const runResult = await runSingleCommand(
    projectRoot,
    command,
    "OWASP Dependency Check",
    context.log,
    context.signal,
    context.outputMode ?? "capture",
  );
  await runSingleCommand(
    projectRoot,
    buildDependencyTreeCommand(mvnPath),
    "Maven dependency tree",
    context.log,
    context.signal,
    context.outputMode ?? "capture",
  );

  const summary = buildProjectSummary(projectRoot, runResult);
  writeProjectSummary(reportPaths.summariesDir, context.project.identity, summary);
  writeAggregatedIndex(reportPaths, loadProjectSummaries(reportPaths.summariesDir));

  process.stdout.write(
    `${summary.projectName}: ${summary.vulnerableDependencyCount} vulnerable dependenc${summary.vulnerableDependencyCount === 1 ? "y" : "ies"}, ${summary.vulnerabilityCount} vulnerabilit${summary.vulnerabilityCount === 1 ? "y" : "ies"}.\n`,
  );
  process.stdout.write(`Project report: ${summary.htmlReportPath}\n`);
  process.stdout.write(`Aggregated report: ${reportPaths.indexPath}\n`);

  const isLastProjectInBatch = (context.batchProjectIndex ?? 0) >= Math.max(0, (context.batchProjectCount ?? 1) - 1);
  if (config.openReport && isLastProjectInBatch) {
    try {
      await openReportInBrowser(reportPaths.indexPath);
      process.stdout.write("Opened aggregated report in the default browser.\n");
    } catch (error) {
      process.stdout.write(`Could not open aggregated report automatically: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (!runResult.success) {
    return {
      success: false,
      message: `${runResult.message} Aggregated report: ${reportPaths.indexPath}`,
    };
  }

  return {
    success: true,
    message: `OWASP Dependency Check completed. Aggregated report: ${reportPaths.indexPath}`,
  };
}
