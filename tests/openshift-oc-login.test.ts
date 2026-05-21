import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadOpenshiftConfig, normalizeOcLoginCommand, resolveLocator } from "../scripts/openshift_oc_login/script.ts";

test("openshift config loader reads required values and keeps optional blanks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-openshift-config-"));
  fs.writeFileSync(
    path.join(root, "config.toml"),
    [
      'login_url = "https://example/login"',
      'command_url = "https://example/cli"',
      'username = "alice"',
      'password = ""',
      'username_selector = "id:user"',
      'password_selector = "id:password"',
      'submit_selector = "css:button[type=\\"submit\\"]"',
      'command_selector = "xpath://code"',
    ].join("\n"),
    "utf8",
  );

  const config = loadOpenshiftConfig(root);
  assert.equal(config.loginUrl, "https://example/login");
  assert.equal(config.commandUrl, "https://example/cli");
  assert.equal(config.username, "alice");
  assert.equal(config.password, "");
  assert.equal(config.commandSelector, "xpath://code");
});

test("openshift command normalization extracts a shell-ready oc login command", () => {
  const command = normalizeOcLoginCommand(`
    To log in, run:
    oc login --token=sha256~abc123 \\
      --server=https://api.example.internal:6443
  `);
  assert.equal(command, "oc login --token=sha256~abc123 --server=https://api.example.internal:6443");
});

test("openshift locator helper supports id, css, xpath, text, and role selectors", () => {
  const calls: string[] = [];
  const root = {
    locator: (value: string) => {
      calls.push(`locator:${value}`);
      return value;
    },
    getByText: (text: string, options: { exact: boolean }) => {
      calls.push(`text:${text}:${options.exact}`);
      return text;
    },
    getByRole: (role: string, options: { name: string }) => {
      calls.push(`role:${role}:${options.name}`);
      return role;
    },
  };

  resolveLocator(root, "id:inputUsername");
  resolveLocator(root, "css:button.submit");
  resolveLocator(root, "xpath://div[@id='x']");
  resolveLocator(root, "text:Log in");
  resolveLocator(root, "role:button:Log in");

  assert.deepEqual(calls, [
    "locator:#inputUsername",
    "locator:button.submit",
    "locator:xpath=//div[@id='x']",
    "text:Log in:true",
    "role:button:Log in",
  ]);
});
