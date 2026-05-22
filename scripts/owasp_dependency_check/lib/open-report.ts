import { spawn } from "node:child_process";

export function buildOpenReportCommand(targetPath: string, platform = process.platform): string[] {
  if (platform === "darwin") {
    return ["open", targetPath];
  }
  if (platform === "win32") {
    return ["cmd", "/c", "start", "", targetPath];
  }
  return ["xdg-open", targetPath];
}

export async function openReportInBrowser(targetPath: string, platform = process.platform): Promise<void> {
  const command = buildOpenReportCommand(targetPath, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
