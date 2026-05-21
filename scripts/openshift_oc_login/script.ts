import path from "node:path";

import type { BuiltinScriptResponse, ScriptContext } from "../../src/models.ts";
import { loadScriptConfig, promptHidden, resolveExecutable, runShellCommand } from "../../src/script-runtime.ts";

interface OpenshiftConfig {
  login_url?: string;
  command_url?: string;
  username?: string;
  password?: string;
  username_selector?: string;
  password_selector?: string;
  submit_selector?: string;
  post_login_wait_selector?: string;
  command_reveal_selector?: string;
  command_selector?: string;
}

export async function openshiftOcLogin(context: ScriptContext): Promise<BuiltinScriptResponse> {
  const config = loadOpenshiftConfig(context.script.directory);
  const password = config.password.length > 0 ? config.password : await promptHidden("OpenShift password: ");
  const ocPath = resolveExecutable("oc");
  if (!ocPath) {
    return { success: false, message: "oc was not found on PATH." };
  }

  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({
    headless: false,
  });

  try {
    const page = await browser.newPage();
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
    await resolveLocator(page, config.usernameSelector).fill(config.username);
    await resolveLocator(page, config.passwordSelector).fill(password);
    if (config.submitSelector.length > 0) {
      await resolveLocator(page, config.submitSelector).click();
    } else {
      await resolveLocator(page, config.passwordSelector).press("Enter");
    }
    if (config.postLoginWaitSelector.length > 0) {
      await resolveLocator(page, config.postLoginWaitSelector).waitFor({ state: "visible" });
    } else {
      await page.waitForLoadState("networkidle");
    }
    if (config.commandUrl.length > 0) {
      await page.goto(config.commandUrl, { waitUntil: "domcontentloaded" });
    }
    if (config.commandRevealSelector.length > 0) {
      await resolveLocator(page, config.commandRevealSelector).click();
    }
    const commandLocator = resolveLocator(page, config.commandSelector);
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
    const installHint = /Executable doesn't exist|browserType\.launch/.test(message)
      ? " Run `npx playwright install chromium` once on this machine."
      : "";
    return {
      success: false,
      message: `OpenShift login failed: ${message}${installHint}`,
    };
  } finally {
    await browser.close();
  }
}

export function loadOpenshiftConfig(scriptDirectory: string): {
  loginUrl: string;
  commandUrl: string;
  username: string;
  password: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  postLoginWaitSelector: string;
  commandRevealSelector: string;
  commandSelector: string;
} {
  const raw = loadScriptConfig<OpenshiftConfig>(scriptDirectory);
  return {
    loginUrl: requireConfigValue(raw.login_url, "login_url"),
    commandUrl: String(raw.command_url ?? ""),
    username: requireConfigValue(raw.username, "username"),
    password: String(raw.password ?? ""),
    usernameSelector: requireConfigValue(raw.username_selector, "username_selector"),
    passwordSelector: requireConfigValue(raw.password_selector, "password_selector"),
    submitSelector: String(raw.submit_selector ?? ""),
    postLoginWaitSelector: String(raw.post_login_wait_selector ?? ""),
    commandRevealSelector: String(raw.command_reveal_selector ?? ""),
    commandSelector: requireConfigValue(raw.command_selector, "command_selector"),
  };
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

export function resolveLocator(root: {
  locator: (value: string) => unknown;
  getByRole?: (role: string, options: { name: string }) => unknown;
  getByText?: (text: string, options: { exact: boolean }) => unknown;
}, selector: string): any {
  if (selector.startsWith("id:")) {
    return root.locator(`#${escapeCssId(selector.slice(3))}`);
  }
  if (selector.startsWith("css:")) {
    return root.locator(selector.slice(4));
  }
  if (selector.startsWith("xpath:")) {
    return root.locator(`xpath=${selector.slice(6)}`);
  }
  if (selector.startsWith("text:")) {
    if (root.getByText) {
      return root.getByText(selector.slice(5), { exact: true });
    }
    return root.locator(`text=${selector.slice(5)}`);
  }
  if (selector.startsWith("role:")) {
    const [, role, ...nameParts] = selector.split(":");
    const name = nameParts.join(":");
    if (!role || !name) {
      throw new Error(`Invalid role selector: ${selector}`);
    }
    if (!root.getByRole) {
      throw new Error("Role selectors require Playwright getByRole support.");
    }
    return root.getByRole(role, { name });
  }
  throw new Error(`Unsupported selector format: ${selector}`);
}

function requireConfigValue(value: unknown, key: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`Missing required config value: ${key}`);
  }
  return normalized;
}

function escapeCssId(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}
