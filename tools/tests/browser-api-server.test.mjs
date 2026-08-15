// @acceptance ACC-HARNESS
// @spec ENG-DEV-001 TST-005
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { browserApiCommand, browserApiLogPath } from "../browser-api-server.mjs";

test("browser API output has a checkout-local durable destination", () => {
  const log = browserApiLogPath({ instanceDir: "/tmp/greenroom-browser-instance" });
  assert.equal(log, path.join("/tmp/greenroom-browser-instance", "browser-api.log"));
});

test("browser API uses the platform npm executable", () => {
  assert.equal(browserApiCommand(), process.platform === "win32" ? "npm.cmd" : "npm");
});
