import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { resolveExecutable } from "../../src/script-runtime.ts";
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

  const session = await startCompareServer({
    projectPaths: mvnProjects.map((project) => project.path),
    mode,
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
