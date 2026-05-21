import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../src/cli.ts";

test("cli lists explicit projects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-cli-"));
  const project = path.join(root, "app");
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(project);
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname='app'", "utf8");
  const configPath = path.join(root, "devtools.toml");
  fs.writeFileSync(
    configPath,
    `
[discovery]
roots = ["${root.replaceAll("\\", "\\\\")}"]
project_types = ["python"]

[scripts]
directory = "${scriptsDir.replaceAll("\\", "\\\\")}"
`.trim(),
    "utf8",
  );
  let output = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(["--config", configPath, "projects", "--path", project]);
    assert.equal(code, 0);
    assert.match(output, /python/);
  } finally {
    process.stdout.write = original;
  }
});
