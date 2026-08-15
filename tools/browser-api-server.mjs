// @spec ENG-DEV-001
/**
 * Run the browser suite's API without routing workerd's stdout through Playwright.
 *
 * GAP-017's named crash is workerd receiving EPIPE while writing request logs to the pipe held
 * by Playwright's webServer capture. The product still owes those logs to operators, so the
 * harness writes them to a durable file instead of suppressing them.
 */
import { execFileSync, spawn } from "node:child_process";
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

export function processTreePids(rootPid, processTable) {
  const children = new Map();
  for (const line of processTable.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const result = [];
  const visit = (pid) => {
    for (const child of children.get(pid) ?? []) {
      visit(child);
      result.push(child);
    }
  };
  visit(rootPid);
  return result;
}

export function terminateProcessTree(
  rootPid,
  { signal = "SIGTERM", processTable, kill = process.kill, platform = process.platform } = {},
) {
  const resolvedProcessTable =
    processTable ??
    (platform === "win32" ? "" : execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }));
  for (const pid of [...processTreePids(rootPid, resolvedProcessTable), rootPid]) {
    try {
      kill(pid, signal);
    } catch (error) {
      // ERROR-INTENT: a descendant can exit between `ps` and `kill`; only ESRCH is already done.
      if (error?.code !== "ESRCH") throw error;
    }
  }
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
    terminateProcessTree(child.pid, { signal });
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
