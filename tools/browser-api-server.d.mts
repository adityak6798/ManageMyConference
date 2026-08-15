import type { ChildProcess } from "node:child_process";
import type { WorktreeEnvironment } from "./worktree-env.mjs";

export function browserApiLogPath(environment?: WorktreeEnvironment): string;
export function browserApiCommand(): string;
export function runBrowserApi(options?: { root?: string }): {
  child: ChildProcess;
  logPath: string;
};
