// @acceptance ACC-INTEGRATION
// @spec ENG-CI-001 PRD-INT-001
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  deploymentCommands,
  deploymentSecrets,
  main,
  WEBHOOK_WRAPPING_KEY_VERSION,
} from "../deploy.mjs";

const environment = {
  WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
  WEBHOOK_WRAPPING_KEYS: JSON.stringify({
    [WEBHOOK_WRAPPING_KEY_VERSION]: Buffer.alloc(32, 7).toString("base64"),
  }),
};

test("deployment validates and separates the two Workers' secrets", () => {
  assert.deepEqual(deploymentSecrets(environment), {
    egress: {
      WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
      WEBHOOK_EGRESS_TOKEN_PREVIOUS: null,
    },
    api: {
      WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
      WEBHOOK_WRAPPING_KEYS: environment.WEBHOOK_WRAPPING_KEYS,
    },
  });
  assert.throws(
    () => deploymentSecrets({ ...environment, WEBHOOK_EGRESS_TOKEN: "short" }),
    /bearer-safe secret/,
  );
  assert.throws(
    () => deploymentSecrets({ ...environment, WEBHOOK_WRAPPING_KEYS: "{}" }),
    /base64 32-byte v1 key/,
  );
  assert.throws(
    () =>
      deploymentSecrets({
        ...environment,
        WEBHOOK_WRAPPING_KEYS: JSON.stringify({
          v1: Buffer.alloc(32, 7).toString("base64"),
          previous: "malformed",
        }),
      }),
    /every WEBHOOK_WRAPPING_KEYS entry/,
  );
  assert.deepEqual(
    deploymentSecrets({ ...environment, WEBHOOK_EGRESS_TOKEN_PREVIOUS: "b".repeat(32) }).egress,
    {
      WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
      WEBHOOK_EGRESS_TOKEN_PREVIOUS: "b".repeat(32),
    },
  );
});

test("deployment builds the Container in CI before activating the API configuration", () => {
  const commands = deploymentCommands("/private/deploy").map(([command, args]) =>
    [command, ...args].join(" "),
  );
  assert.match(commands[0], /migrate:remote.*@greenroom\/api/);
  assert.match(commands[1], /build.*@greenroom\/web/);
  assert.match(commands[2], /secrets:reconcile.*@greenroom\/webhook-egress.*webhook-egress\.json/);
  assert.match(commands[3], /deploy.*@greenroom\/webhook-egress/);
  assert.match(commands[4], /deploy.*@greenroom\/api.*api-webhooks\.json/);
});

test("the pinned Wrangler bulk boundary supports explicit null deletion", () => {
  const result = spawnSync(
    "npm",
    ["run", "secrets:reconcile", "--workspace", "@greenroom/webhook-egress", "--", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Set a key to null in the JSON file to delete it/);
});

test("deployment writes secret files only for the command window and removes them afterwards", () => {
  const observed = [];
  const environments = [];
  let directory;
  main(environment, (_command, args, receivedEnvironment) => {
    environments.push(receivedEnvironment);
    const reconcileAt = args.indexOf("secrets:reconcile");
    if (reconcileAt >= 0) {
      const secretPath = args.at(-1);
      directory = new URL(`file://${secretPath}`).pathname.replace(/\/[^/]+$/, "");
      observed.push(JSON.parse(readFileSync(secretPath, "utf8")));
      return;
    }
    const secretAt = args.indexOf("--secrets-file");
    if (secretAt < 0) return;
    const secretPath = args[secretAt + 1];
    directory = new URL(`file://${secretPath}`).pathname.replace(/\/[^/]+$/, "");
    observed.push(JSON.parse(readFileSync(secretPath, "utf8")));
  });
  assert.deepEqual(observed, [
    {
      WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
      WEBHOOK_EGRESS_TOKEN_PREVIOUS: null,
    },
    {
      WEBHOOK_EGRESS_TOKEN: "a".repeat(32),
      WEBHOOK_WRAPPING_KEYS: environment.WEBHOOK_WRAPPING_KEYS,
    },
  ]);
  assert.equal(existsSync(directory), false);
  assert.ok(environments.length > 0);
  assert.ok(environments.every((receivedEnvironment) => receivedEnvironment === environment));
});
