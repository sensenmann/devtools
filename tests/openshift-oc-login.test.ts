import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findFirstPreCommand,
  getDefaultOcCredentialsTemplate,
  loadOcCredentials,
  loadOpenshiftConfig,
  normalizeOcLoginCommand,
} from "../scripts/openshift_oc_login/script.ts";

test("openshift config loader reads required values and keeps optional blanks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-openshift-config-"));
  fs.writeFileSync(
    path.join(root, "config.toml"),
    ['credentials_file = "~/.oc-credentials.toml"'].join("\n"),
    "utf8",
  );

  const config = loadOpenshiftConfig(root);
  assert.equal(config.credentialsFile, "~/.oc-credentials.toml");
});

test("openshift credentials loader fails when the file is missing", () => {
  assert.throws(() => loadOcCredentials("/definitely/missing/oc-credentials.toml"), /credentials file not found/i);
});

test("openshift credentials loader reads login target and optional credentials from a separate file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-oc-creds-"));
  const credentialsFile = path.join(root, "oc-credentials.toml");
  fs.writeFileSync(
    credentialsFile,
    [
      'login_url = "https://example/login"',
      'username = "alice"',
      'password = "secret"',
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(loadOcCredentials(credentialsFile), {
    loginUrl: "https://example/login",
    username: "alice",
    password: "secret",
  });
});

test("openshift credentials template documents the expected file format", () => {
  const template = getDefaultOcCredentialsTemplate();
  assert.match(template, /login_url/);
  assert.match(template, /username/);
  assert.match(template, /password/);
});

test("openshift command normalization extracts a shell-ready oc login command", () => {
  const command = normalizeOcLoginCommand(`
    To log in, run:
    oc login --token=sha256~abc123 \\
      --server=https://api.example.internal:6443
  `);
  assert.equal(command, "oc login --token=sha256~abc123 --server=https://api.example.internal:6443");
});

test("openshift command extraction reads the first pre element", () => {
  const command = findFirstPreCommand(`
    <html>
      <body>
        <pre>
          oc login --token=sha256~abc123 --server=https://api.example.internal:6443
        </pre>
        <pre>ignored</pre>
      </body>
    </html>
  `);

  assert.equal(command, "oc login --token=sha256~abc123 --server=https://api.example.internal:6443");
});
