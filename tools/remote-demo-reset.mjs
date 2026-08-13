// @spec ENG-CI-001
/** Restore the one public demo deployment without weakening the local reset boundary. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TOOLS_ROOT, "..");
const API_ROOT = path.join(REPOSITORY_ROOT, "apps", "api");
const CONFIG_PATH = path.join(API_ROOT, "wrangler.toml");

export const DEMO_TARGET = Object.freeze({
  worker: "project-greenroom-api",
  databaseBinding: "DB",
  databaseName: "manage-my-conf",
  databaseId: "5aa5ed70-b4f8-443a-a3a4-f3a4e41cce7b",
  bucketBinding: "ASSETS",
  bucketName: "manage-my-conf",
  assetPath:
    "manage-my-conf/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/90000000-0000-4000-8000-000000000001",
});

function quotedValue(text, key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(text)?.[1];
}

/**
 * Refuse before authenticating if this checkout no longer describes the disposable demo.
 * Exact resource identities make copying this command into a production config fail closed.
 */
export function assertDemoConfig(text) {
  const expected = [
    ["name", DEMO_TARGET.worker],
    ["ENVIRONMENT", "development"],
    ["DEMO_MODE", "true"],
    ["binding", DEMO_TARGET.databaseBinding],
    ["database_name", DEMO_TARGET.databaseName],
    ["database_id", DEMO_TARGET.databaseId],
    ["bucket_name", DEMO_TARGET.bucketName],
  ];
  for (const [key, value] of expected) {
    if (quotedValue(text, key) !== value)
      throw new Error(
        `Refusing remote reset: apps/api/wrangler.toml must declare ${key} = "${value}".`,
      );
  }
  const bindings = [...text.matchAll(/^binding\s*=\s*"([^"]+)"\s*$/gm)].map((match) => match[1]);
  if (!bindings.includes(DEMO_TARGET.bucketBinding))
    throw new Error(
      `Refusing remote reset: apps/api/wrangler.toml must bind R2 as ${DEMO_TARGET.bucketBinding}.`,
    );
}

export function remoteResetCommands() {
  return [
    ["d1", "migrations", "apply", DEMO_TARGET.databaseBinding, "--remote"],
    ["d1", "execute", DEMO_TARGET.databaseBinding, "--remote", "--file", "seed/reset.sql", "--yes"],
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
  ];
}

function runWrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd: API_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(" ")} exited with status ${result.status}`);
}

export function main(argv = process.argv.slice(2)) {
  const confirmation = argv.length === 2 && argv[0] === "--confirm" ? argv[1] : undefined;
  if (confirmation !== DEMO_TARGET.worker)
    throw new Error(
      `Refusing remote reset. Re-run with: npm run reset:demo -- --confirm ${DEMO_TARGET.worker}`,
    );
  assertDemoConfig(readFileSync(CONFIG_PATH, "utf8"));
  for (const command of remoteResetCommands()) runWrangler(command);
  process.stdout.write(`Remote demo restored: ${DEMO_TARGET.worker}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    // ERROR-INTENT: this CLI boundary turns a guard or provider failure into one actionable
    // message and a non-zero exit; the underlying Wrangler command has already printed details.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
