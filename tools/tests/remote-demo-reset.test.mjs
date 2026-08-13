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
      DEMO_TARGET.assetPath,
      "--remote",
      "--file",
      "seed/assets/speaker-portrait.png",
      "--content-type",
      "image/png",
    ],
  ]);
});

test("resource validation is independent of TOML table order", () => {
  const d1Start = config.indexOf("[[d1_databases]]");
  const r2Start = config.indexOf("[[r2_buckets]]");
  const d1Block = config.slice(d1Start, r2Start);
  const r2Block = config.slice(r2Start);
  assert.doesNotThrow(() => assertDemoConfig(`${config.slice(0, d1Start)}${r2Block}\n${d1Block}`));
});

test("D1 identity fields must belong to the same table block", () => {
  const splitIdentity = config.replace(
    `database_id = "${DEMO_TARGET.databaseId}"`,
    `database_id = "production-id"\n\n[[d1_databases]]\nbinding = "PRODUCTION"\ndatabase_name = "production"\ndatabase_id = "${DEMO_TARGET.databaseId}"`,
  );
  assert.throws(() => assertDemoConfig(splitIdentity), /exact demo D1 database/);
});

test("R2 binding and bucket name must belong to the same table block", () => {
  const splitIdentity = config.replace(
    `bucket_name = "${DEMO_TARGET.bucketName}"`,
    `bucket_name = "production-assets"\n\n[[r2_buckets]]\nbinding = "PRODUCTION"\nbucket_name = "${DEMO_TARGET.bucketName}"`,
  );
  assert.throws(() => assertDemoConfig(splitIdentity), /exact demo R2 bucket/);
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
