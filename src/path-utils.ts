import path from "node:path";

export function normalizePath(value: string): string {
  return path.resolve(expandHome(value));
}

export function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", value.slice(2));
  }
  return value;
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function pathIdentity(name: string, absolutePath: string): string {
  return `${name}:${absolutePath}`;
}

