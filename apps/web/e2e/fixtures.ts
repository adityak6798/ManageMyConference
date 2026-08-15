// @spec ENG-DEV-001

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { browserApiLogPath } from "../../../tools/browser-api-server.mjs";
import { resolveWorktreeEnvironment } from "../../../tools/worktree-env.mjs";

const environment = resolveWorktreeEnvironment();
const healthUrl = `http://127.0.0.1:${environment.apiPort}/health`;
let lastCompletedTest = "browser-suite setup";
const failureMarker = path.join(environment.instanceDir, "browser-runtime-failure.txt");

async function recordedRuntimeFailure(): Promise<string | undefined> {
  try {
    return await readFile(failureMarker, "utf8");
  } catch (error) {
    // ERROR-INTENT: ENOENT means this suite has recorded no runtime failure; all other errors surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function recordRuntimeFailure(message: string): Promise<void> {
  await writeFile(failureMarker, message, "utf8");
}

async function logTail(): Promise<string> {
  try {
    const text = await readFile(browserApiLogPath(environment), "utf8");
    return text.split("\n").slice(-20).join("\n").trim();
  } catch (error) {
    // ERROR-INTENT: the missing log is itself included in the infrastructure diagnosis.
    return `Could not read the API log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runtimeDiagnosis(): Promise<string | undefined> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) return undefined;
    return `health probe answered ${response.status}`;
  } catch (error) {
    // ERROR-INTENT: connection failures are returned as the runtime diagnosis and fail the test.
    return error instanceof Error ? error.message : String(error);
  }
}

export const test = base.extend<{ runtimeHealth: undefined }>({
  runtimeHealth: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture callbacks require the dependency argument.
    async ({}, use, testInfo) => {
      const priorFailure = await recordedRuntimeFailure();
      if (priorFailure) test.skip(true, priorFailure);

      const title = `${testInfo.file.split("/").at(-1)}: ${testInfo.title}`;
      const before = await runtimeDiagnosis();
      if (before) {
        const runtimeFailure =
          `BROWSER API RUNTIME STOPPED ANSWERING before ${title}; last completed test: ` +
          `${lastCompletedTest}; probe: ${before}; log: ${browserApiLogPath(environment)}`;
        await recordRuntimeFailure(runtimeFailure);
        throw new Error(`${runtimeFailure}\n\nAPI log tail:\n${await logTail()}`);
      }

      await use(undefined);

      const after = await runtimeDiagnosis();
      if (after) {
        const runtimeFailure =
          `BROWSER API RUNTIME STOPPED ANSWERING while running ${title}; last completed test: ` +
          `${lastCompletedTest}; probe: ${after}; log: ${browserApiLogPath(environment)}`;
        await recordRuntimeFailure(runtimeFailure);
        throw new Error(`${runtimeFailure}\n\nAPI log tail:\n${await logTail()}`);
      }
      lastCompletedTest = title;
    },
    { auto: true },
  ],
});

export type { Locator, Page } from "@playwright/test";
export { expect };
