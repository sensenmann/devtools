import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { findProjectFileDirs, resolveExecutable, runCommandAcrossDirs } from "../../src/script-runtime.ts";

export async function mavenCleanInstall(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const mvnPath = resolveExecutable("mvn");
  if (!mvnPath) {
    return { success: false, message: "mvn was not found on PATH." };
  }

  const projectRoot = path.resolve(context.project.path);
  const pomDirs = findProjectFileDirs(projectRoot, "pom.xml");
  if (pomDirs.length === 0) {
    return { success: false, message: "No pom.xml files found below the selected project." };
  }

  return await runCommandAcrossDirs(
    projectRoot,
    pomDirs,
    [mvnPath, "clean", "install", "-f", "pom.xml"],
    "maven clean install",
    context.log,
    context.signal,
    context.outputMode ?? "capture",
  );
}
