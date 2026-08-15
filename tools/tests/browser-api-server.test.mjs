// @acceptance ACC-HARNESS
// @spec ENG-DEV-001 TST-005
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  browserApiCommand,
  browserApiLogPath,
  processTreePids,
  terminateProcessTree,
} from "../browser-api-server.mjs";

test("browser API output has a checkout-local durable destination", () => {
  const log = browserApiLogPath({ instanceDir: "/tmp/greenroom-browser-instance" });
  assert.equal(log, path.join("/tmp/greenroom-browser-instance", "browser-api.log"));
});

test("browser API uses the platform npm executable", () => {
  assert.equal(browserApiCommand(), process.platform === "win32" ? "npm.cmd" : "npm");
});

const processTable = `
  100 1
  110 100
  120 110
  130 100
  900 1
`;

test("browser API resolves every descendant without crossing into another process tree", () => {
  assert.deepEqual(processTreePids(100, processTable), [120, 110, 130]);
});

test("browser API terminates descendants before their supervisor", () => {
  const killed = [];
  terminateProcessTree(100, {
    signal: "SIGTERM",
    processTable,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      return true;
    },
  });
  assert.deepEqual(killed, [
    [120, "SIGTERM"],
    [110, "SIGTERM"],
    [130, "SIGTERM"],
    [100, "SIGTERM"],
  ]);
});

test("browser API avoids POSIX process discovery on Windows", () => {
  const killed = [];
  terminateProcessTree(100, {
    platform: "win32",
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      return false;
    },
  });
  assert.deepEqual(killed, [[100, "SIGTERM"]]);
});
