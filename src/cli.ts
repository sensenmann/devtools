#!/usr/bin/env node
import { DevtoolsService } from "./service.ts";
import { isScriptGroup } from "./registry.ts";
import { runTui } from "./tui.ts";

interface ParsedArgs {
  config?: string;
  command: string;
  rest: string[];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const service = DevtoolsService.fromPath(parsed.config);

  switch (parsed.command) {
    case "projects":
      return handleProjects(service, parsed.rest);
    case "scripts":
      return handleScripts(service, parsed.rest);
    case "run":
      return handleRun(service, parsed.rest);
    case "refresh-cache":
      return handleRefreshCache(service);
    case "tui":
      return await handleTui(service);
    case "--help":
    case "-h":
    case "help":
    case "":
      printHelp();
      return 0;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let config: string | undefined;
  while (args.length > 0 && args[0]?.startsWith("--")) {
    if (args[0] === "--config") {
      args.shift();
      config = args.shift();
      continue;
    }
    if (args[0] === "--help" || args[0] === "-h") {
      return { config, command: "--help", rest: [] };
    }
    break;
  }
  const command = args.shift() ?? "";
  return { config, command, rest: args };
}

function handleProjects(service: DevtoolsService, args: string[]): number {
  const options = parseListArgs(args);
  const projects = service.listProjects({
    explicitPaths: options.paths,
    projectType: options.projectType,
    nameFilter: options.nameFilter,
    refresh: options.refresh,
  });
  for (const project of projects) {
    process.stdout.write(`${project.projectTypes.join(",").padEnd(12)} ${project.name.padEnd(30)} ${project.path}\n`);
  }
  return 0;
}

function handleScripts(service: DevtoolsService, args: string[]): number {
  const options = parseListArgs(args);
  const projects = options.paths?.length || options.refresh
    ? service.listProjects({
        explicitPaths: options.paths,
        refresh: options.refresh,
      })
    : undefined;
  for (const script of service.listScripts(projects)) {
    const indent = isScriptGroup(script) ? "" : script.group ? "  " : "";
    const label = isScriptGroup(script) ? `[group] ${script.name}` : script.name;
    const variantSuffix = !isScriptGroup(script) && script.variant ? ` [${script.variant.defaultValue}]` : "";
    process.stdout.write(`${script.scriptId.padEnd(30)} [${script.projectTypes.join(",")}] ${indent}${label}${variantSuffix} - ${script.description}\n`);
  }
  return 0;
}

async function handleRun(service: DevtoolsService, args: string[]): Promise<number> {
  const [scriptId, ...rest] = args;
  if (!scriptId) {
    throw new Error("Missing script id.");
  }
  const options = parseRunArgs(rest);
  const projects = service.listProjects({
    explicitPaths: options.paths,
    projectType: options.projectType,
    nameFilter: options.nameFilter,
    refresh: options.refresh,
  });
  if (projects.length === 0) {
    process.stdout.write("No matching projects found.\n");
    return 1;
  }
  const results = await service.runScript(scriptId, projects, options.scriptArgs, (message) => {
    process.stdout.write(`${message}\n`);
  });

  let failures = 0;
  for (const result of results) {
    process.stdout.write(`\n[${result.success ? "OK" : "FAIL"}] ${result.project.path}\n`);
    if (result.message) {
      process.stdout.write(`${result.message}\n`);
    }
    if (result.output.trim()) {
      process.stdout.write(`${result.output.trimEnd()}\n`);
    }
    if (result.error.trim()) {
      process.stdout.write(`${result.error.trimEnd()}\n`);
    }
    if (!result.success) {
      failures += 1;
    }
  }
  return failures > 0 ? 1 : 0;
}

function handleRefreshCache(service: DevtoolsService): number {
  const projects = service.refreshProjects();
  process.stdout.write(`Cached ${projects.length} top-level project(s).\n`);
  return 0;
}

async function handleTui(service: DevtoolsService): Promise<number> {
  await runTui(service);
  return 0;
}

function parseListArgs(args: string[]): {
  paths?: string[];
  projectType?: string;
  nameFilter?: string;
  refresh: boolean;
} {
  const paths: string[] = [];
  let projectType: string | undefined;
  let nameFilter: string | undefined;
  let refresh = false;
  const queue = [...args];
  while (queue.length > 0) {
    const current = queue.shift()!;
    switch (current) {
      case "--path":
        paths.push(queue.shift() ?? "");
        break;
      case "--type":
        projectType = queue.shift();
        break;
      case "--filter":
        nameFilter = queue.shift();
        break;
      case "--refresh":
        refresh = true;
        break;
      default:
        throw new Error(`Unknown option: ${current}`);
    }
  }
  return {
    paths: paths.length > 0 ? paths : undefined,
    projectType,
    nameFilter,
    refresh,
  };
}

function parseRunArgs(args: string[]): {
  paths?: string[];
  projectType?: string;
  nameFilter?: string;
  refresh: boolean;
  scriptArgs: Record<string, unknown>;
} {
  const listArgs = parseListArgs(args.filter((item, index, array) => {
    if (item === "--arg" || array[index - 1] === "--arg") {
      return false;
    }
    return true;
  }));
  const scriptArgs: Record<string, unknown> = {};
  const queue = [...args];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current !== "--arg") {
      if (current === "--path" || current === "--type" || current === "--filter") {
        queue.shift();
      }
      continue;
    }
    const raw = queue.shift() ?? "";
    const [key, ...valueParts] = raw.split("=");
    if (!key || valueParts.length === 0) {
      throw new Error(`Invalid --arg value: ${raw}`);
    }
    scriptArgs[key] = coerceValue(valueParts.join("="));
  }
  return { ...listArgs, scriptArgs };
}

function coerceValue(value: string): unknown {
  const lowered = value.toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: devtools [--config <path>] <command>",
      "",
      "Commands:",
      "  projects [--path <project>] [--type <type>] [--filter <text>] [--refresh]",
      "  scripts [--path <project>] [--refresh]",
      "  run <script-id> [--path <project>] [--type <type>] [--filter <text>] [--refresh] [--arg key=value]",
      "  refresh-cache",
      "  tui",
      "",
    ].join("\n"),
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
