import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { resolveExecutable } from "../../src/script-runtime.ts";
import { loadCompareConfig } from "./config.ts";
import { findChildVersionPropertyWarnings } from "./lib/pom.ts";
import { startCompareServer } from "./server.ts";

export async function mavenDependencyCompare(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const mvnProjects = (context.selectedProjects ?? []).filter((project) => project.projectTypes.includes("maven"));
  if (mvnProjects.length < 2) {
    return { success: false, message: "Maven dependency compare requires at least two selected Maven projects." };
  }
  const mode = context.args.mode === "fast" ? "fast" : "deep";
  const mvnPath = resolveExecutable("mvn");
  if (!mvnPath) {
    return { success: false, message: "mvn was not found on PATH." };
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const config = loadCompareConfig(scriptDirectory);
  const childVersionPropertyWarnings = findChildVersionPropertyWarnings(mvnProjects);
  if (childVersionPropertyWarnings.length > 0) {
    emitChildVersionPropertyWarnings(childVersionPropertyWarnings, context);
  }

  const session = await startCompareServer({
    projectPaths: mvnProjects.map((project) => project.path),
    mode,
    enableDependencyUpdates: config.enableDependencyUpdates,
    defaultRepoBaseUrl: config.defaultRepoBaseUrl,
    repoOverrides: config.repoOverrides,
    signal: context.signal,
    onStarted: (url) => {
      context.log?.(`[server] ${url}`);
      process.stdout.write(`Maven dependency compare server: ${url}\n`);
      process.stdout.write("Press Ctrl+C to stop the server.\n");
    },
  });
  await session.closed;

  return {
    success: true,
    message: `Stopped dependency compare server for ${mvnProjects.length} projects.`,
  };
}

function emitChildVersionPropertyWarnings(
  warnings: ReturnType<typeof findChildVersionPropertyWarnings>,
  context: ScriptContext,
): void {
  const separator = "\x1b[33m" + "!".repeat(88) + "\x1b[0m";
  process.stdout.write(`${separator}\n`);
  process.stdout.write("\x1b[1;31mWARNING: Child POMs define *.version properties.\x1b[0m\n");
  process.stdout.write("\x1b[33mThese properties are not compared as cross-project overrides. Only root/parent POM version properties participate in Override rows.\x1b[0m\n");
  for (const warning of warnings) {
    const propertyList = warning.propertyNames.join(", ");
    const line = ` - ${warning.projectName} :: ${warning.modulePath} :: ${warning.pomPath} :: ${propertyList}`;
    process.stdout.write(`${line}\n`);
    context.log?.(`[warning] child version properties ignored for override compare: ${warning.modulePath} :: ${propertyList}`);
  }
  process.stdout.write(`${separator}\n`);
}
