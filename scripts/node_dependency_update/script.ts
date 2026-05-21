import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { findProjectFileDirs, resolveExecutable, runCommandAcrossDirs } from "../../src/script-runtime.ts";

export async function nodeDependencyUpdate(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const npmPath = resolveExecutable("npm");
  if (!npmPath) {
    return { success: false, message: "npm was not found on PATH." };
  }

  const projectRoot = path.resolve(context.project.path);
  const packageDirs = findProjectFileDirs(projectRoot, "package.json");
  if (packageDirs.length === 0) {
    return { success: false, message: "No package.json files found below the selected project." };
  }

  const registry = String(context.args.registry ?? "https://registry.npmjs.org");
  const force = Boolean(context.args.force ?? false);
  const command = [npmPath, "audit", "fix"];
  if (force) {
    command.push("--force");
  }
  command.push(`--registry=${registry}`);

  return await runCommandAcrossDirs(
    projectRoot,
    packageDirs,
    command,
    "npm audit fix",
    context.log,
    context.signal,
    context.outputMode ?? "capture",
  );
}
