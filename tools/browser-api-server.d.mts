import type { ChildProcess } from "node:child_process";
import type { WorktreeEnvironment } from "./worktree-env.mjs";

export function browserApiLogPath(environment?: WorktreeEnvironment): string;
export function browserApiCommand(): string;
export function processTreePids(rootPid: number, processTable: string): number[];
export function terminateProcessTree(
  rootPid: number,
  options?: {
    signal?: NodeJS.Signals;
    processTable?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    platform?: NodeJS.Platform;
  },
): void;
export function runBrowserApi(options?: { root?: string }): {
  child: ChildProcess;
  logPath: string;
};
