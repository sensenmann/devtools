import type { BuiltinScriptRunner } from "./models.ts";
import {
  runEchoProject,
  runListDirectChildren,
  runMavenDependencyUpdate,
  runNodeAuditFix,
} from "./builtin-scripts.ts";

export const BUILTIN_SCRIPT_MODULES: Record<string, BuiltinScriptRunner> = {
  echoProject: runEchoProject,
  listDirectChildren: runListDirectChildren,
  mavenDependencyUpdate: runMavenDependencyUpdate,
  nodeDependencyUpdate: runNodeAuditFix,
};
