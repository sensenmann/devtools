import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.ts";

test("config resolves relative script and cache paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-config-"));
  const configPath = path.join(root, "devtools.toml");
  fs.writeFileSync(
    configPath,
    `
[discovery]
roots = ["~/Develop", "./projects"]
project_types = ["maven", "node"]

[scripts]
directory = "scripts"
`.trim(),
    "utf8",
  );

  const config = loadConfig(configPath);
  assert.equal(config.scripts.directory, path.resolve(root, "scripts"));
  assert.equal(config.discovery.cacheFile, path.resolve(root, ".devtools-project-cache.json"));
  assert.deepEqual(config.discovery.projectTypes, ["maven", "node"]);
});
