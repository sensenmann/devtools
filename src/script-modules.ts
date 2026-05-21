import type { BuiltinScriptRunner } from "./models.ts";
import {
  runEchoProject,
  runGitPull,
  runMavenCleanInstall,
  runListDirectChildren,
  runMavenDependencyUpdate,
  runNodeAuditFix,
} from "./builtin-scripts.ts";

export const BUILTIN_SCRIPT_MODULES: Record<string, BuiltinScriptRunner> = {
  echoProject: runEchoProject,
  gitPull: runGitPull,
  listDirectChildren: runListDirectChildren,
  mavenCleanInstall: runMavenCleanInstall,
  mavenDependencyUpdate: runMavenDependencyUpdate,
  nodeDependencyUpdate: runNodeAuditFix,
};
