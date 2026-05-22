import { spawn } from "node:child_process";

export async function openInBrowser(target: string, platform = process.platform): Promise<void> {
  const command = platform === "darwin"
    ? ["open", target]
    : platform === "win32"
      ? ["cmd", "/c", "start", "", target]
      : ["xdg-open", target];
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
