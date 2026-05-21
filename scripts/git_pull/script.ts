import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { resolveExecutable, runCommandAcrossDirs } from "../../src/script-runtime.ts";

export async function gitPull(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const gitPath = resolveExecutable("git");
  if (!gitPath) {
    return { success: false, message: "git was not found on PATH." };
  }

  const projectRoot = path.resolve(context.project.path);
  return await runCommandAcrossDirs(
    projectRoot,
    [projectRoot],
    [gitPath, "pull"],
    "git pull",
    context.log,
    context.signal,
    context.outputMode ?? "capture",
  );
}
