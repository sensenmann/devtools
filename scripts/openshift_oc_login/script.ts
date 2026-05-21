import fs from "node:fs";
import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { normalizePath } from "../../src/path-utils.ts";
import { loadScriptConfig, promptHidden, promptLine, resolveExecutable, runShellCommand } from "../../src/script-runtime.ts";
import { parseSimpleToml } from "../../src/toml.ts";

interface OpenshiftConfig {
  credentials_file?: string;
}

interface OcCredentialsConfig {
  login_url?: string;
  username?: string;
  password?: string;
}

export async function openshiftOcLogin(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const config = loadOpenshiftConfig(context.script.directory);
  const credentials = loadOcCredentials(config.credentialsFile);
  const username = credentials.username.length > 0 ? credentials.username : await promptLine("OpenShift username: ");
  const password = credentials.password.length > 0 ? credentials.password : await promptHidden("OpenShift password: ");
  const ocPath = resolveExecutable("oc");
  if (!ocPath) {
    return { success: false, message: "oc was not found on PATH." };
  }

  const playwright = await import("playwright");
  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;

  try {
    browser = await launchChromiumWithInstall(playwright, context);
    const page = await browser.newPage();
    await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator('[title="Log in with Developer"]').click();
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator('[type="submit"]').click();
    await page.waitForLoadState("domcontentloaded");
    await page.locator("form button[type='submit'], form input[type='submit']").first().click();
    const commandLocator = page.locator("pre").first();
    await commandLocator.waitFor({ state: "visible" });
    const rawCommand = await commandLocator.textContent();
    const command = normalizeOcLoginCommand(rawCommand ?? "");
    process.stdout.write(`${command}\n`);
    return await runShellCommand(
      process.cwd(),
      command,
      "OpenShift oc login",
      context.log,
      context.signal,
      context.outputMode ?? "capture",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `OpenShift login failed: ${message}`,
    };
  } finally {
    await browser?.close();
  }
}

export function loadOpenshiftConfig(scriptDirectory: string): {
  credentialsFile: string;
} {
  const raw = loadScriptConfig<OpenshiftConfig>(scriptDirectory, "config.toml");
  return {
    credentialsFile: requireConfigValue(raw.credentials_file, "credentials_file"),
  };
}

export function loadOcCredentials(credentialsFile: string): {
  loginUrl: string;
  username: string;
  password: string;
} {
  const resolvedPath = normalizePath(credentialsFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`OpenShift credentials file not found: ${resolvedPath}`);
  }
  const raw = parseSimpleToml(fs.readFileSync(resolvedPath, "utf8")) as OcCredentialsConfig;
  return {
    loginUrl: requireConfigValue(raw.login_url, "login_url"),
    username: String(raw.username ?? "").trim(),
    password: String(raw.password ?? ""),
  };
}

export function getDefaultOcCredentialsTemplate(): string {
  return [
    "# OpenShift credentials and login target.",
    'login_url = "https://oauth-openshift.apps.example.internal/oauth/token/request"',
    "",
    "# If username or password are empty, the script asks interactively.",
    'username = "your.username"',
    'password = ""',
    "",
  ].join("\n");
}

export function normalizeOcLoginCommand(input: string): string {
  const compact = input
    .replace(/\\\r?\n/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = compact.match(/oc\s+login\b.*$/);
  if (!match) {
    throw new Error("Could not find an oc login command in the page content.");
  }
  return match[0]!.trim();
}

export function findFirstPreCommand(html: string): string {
  const match = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
  if (!match) {
    throw new Error("Could not find a <pre> element containing the oc login command.");
  }
  return normalizeOcLoginCommand(decodeHtml(match[1] ?? ""));
}

function requireConfigValue(value: unknown, key: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`Missing required config value: ${key}`);
  }
  return normalized;
}

async function launchChromiumWithInstall(
  playwright: typeof import("playwright"),
  context: ScriptContext,
) {
  try {
    return await playwright.chromium.launch({ headless: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Executable doesn't exist|browserType\.launch|Failed to launch browser/i.test(message)) {
      throw error;
    }
    const installResult = await runShellCommand(
      path.resolve(context.script.directory),
      "npx playwright install chromium",
      "Playwright chromium install",
      context.log,
      context.signal,
      context.outputMode ?? "capture",
    );
    if (!installResult.success) {
      throw new Error(`Chromium install failed: ${installResult.message}`);
    }
    return await playwright.chromium.launch({ headless: false });
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
