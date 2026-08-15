// @spec ENG-DEV-001
/**
 * Run the browser suite's API without routing workerd's stdout through Playwright.
 *
 * GAP-017's named crash is workerd receiving EPIPE while writing request logs to the pipe held
 * by Playwright's webServer capture. The product still owes those logs to operators, so the
 * harness writes them to a durable file instead of suppressing them.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorktreeEnvironment } from "./worktree-env.mjs";

export function browserApiLogPath(environment = resolveWorktreeEnvironment()) {
  return path.join(environment.instanceDir, "browser-api.log");
}

export function browserApiCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function runBrowserApi({ root = resolveWorktreeEnvironment().root } = {}) {
  const environment = resolveWorktreeEnvironment(process.env, root);
  const logPath = browserApiLogPath(environment);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, "w");
  const child = spawn(browserApiCommand(), ["run", "dev", "--workspace", "@greenroom/api"], {
    cwd: root,
    env: { ...process.env, GREENROOM_API_PORT: String(environment.apiPort) },
    stdio: ["ignore", log, log],
  });

  const forward = (signal) => {
    if (child.killed) return;
    child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    closeSync(log);
    process.stderr.write(
      `Browser API process could not start: ${error.message}\nLog: ${logPath}\n`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    closeSync(log);
    if (signal)
      process.stderr.write(`Browser API process exited from ${signal}. Log: ${logPath}\n`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return { child, logPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBrowserApi();
