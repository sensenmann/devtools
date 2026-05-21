import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "./models.ts";

interface ScriptStateFileShape {
  selectedVariants?: Record<string, string>;
}

export function loadSelectedVariants(config: AppConfig): Record<string, string> {
  if (!fs.existsSync(config.tui.scriptStateFile)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(config.tui.scriptStateFile, "utf8")) as ScriptStateFileShape;
  return { ...(raw.selectedVariants ?? {}) };
}

export function saveSelectedVariants(config: AppConfig, selectedVariants: Record<string, string>): void {
  fs.mkdirSync(path.dirname(config.tui.scriptStateFile), { recursive: true });
  const payload: ScriptStateFileShape = {
    selectedVariants: { ...selectedVariants },
  };
  fs.writeFileSync(config.tui.scriptStateFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
