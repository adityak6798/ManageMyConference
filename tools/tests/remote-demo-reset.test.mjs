// @acceptance ACC-DEMO-SMOKE
// @spec ENG-CI-001
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertDemoConfig, DEMO_TARGET, remoteResetCommands } from "../remote-demo-reset.mjs";

const config = readFileSync(new URL("../../apps/api/wrangler.toml", import.meta.url), "utf8");

test("the remote reset is pinned to the checked-in disposable demo resources", () => {
  assert.doesNotThrow(() => assertDemoConfig(config));
  assert.deepEqual(remoteResetCommands(), [
    ["d1", "migrations", "apply", "DB", "--remote"],
    ["d1", "execute", "DB", "--remote", "--file", "seed/reset.sql", "--yes"],
    [
      "r2",
      "object",
      "put",
      `manage-my-conf/${DEMO_TARGET.assetKey}`,
      "--remote",
      "--file",
      "seed/assets/speaker-portrait.png",
      "--content-type",
      "image/png",
    ],
  ]);
});

for (const [label, changed] of [
  [
    "production authentication",
    config.replace('ENVIRONMENT = "development"', 'ENVIRONMENT = "production"'),
  ],
  ["disabled demo mode", config.replace('DEMO_MODE = "true"', 'DEMO_MODE = "false"')],
  ["another Worker", config.replace('name = "project-greenroom-api"', 'name = "production"')],
  ["another database", config.replace(DEMO_TARGET.databaseId, "production-database-id")],
  [
    "another bucket",
    config.replace('bucket_name = "manage-my-conf"', 'bucket_name = "production-assets"'),
  ],
])
  test(`the remote reset refuses ${label}`, () => {
    assert.throws(() => assertDemoConfig(changed), /Refusing remote reset/);
  });
