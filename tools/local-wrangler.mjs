// @spec ENG-DEV-001
/**
 * The single place that starts Wrangler for local development.
 *
 * Every invocation is pinned to this instance's own state directory with `--persist-to`, so
 * the local D1 file and R2 bucket belong to one running API instance rather than to the
 * checkout as a whole. `GAP-004` measured the alternative: two `wrangler dev` processes of one
 * worktree on different ports shared `apps/api/.wrangler/state/v3/d1` and produced
 * intermittent, irreproducible browser failures that read as ordinary assertion errors.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  headCommit,
  migrationIdentity,
  readMigrationRecord,
  resolveWorktreeEnvironment,
  staleMigrationDiagnostic,
  writeMigrationRecord,
} from "./worktree-env.mjs";

const SEED_ASSET_KEY =
  "greenroom-assets/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/90000000-0000-4000-8000-000000000001";

function runWrangler(args, environment) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: path.join(environment.root, "apps", "api"),
    stdio: "inherit",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: environment.configHome,
      WRANGLER_LOG_PATH: environment.logPath,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`wrangler ${args[0]} exited with status ${result.status ?? "unknown"}`);
}

/** Refuse to run against a database the current migrations can no longer explain. */
function assertMigrationsUsable(environment) {
  const stale = staleMigrationDiagnostic(
    readMigrationRecord(environment.migrationRecordPath),
    migrationIdentity(environment.migrationsDir),
    environment,
  );
  if (stale) throw new Error(stale);
}

function prepare(environment) {
  mkdirSync(environment.stateDir, { recursive: true });
  mkdirSync(environment.configHome, { recursive: true });
}

function reset(environment, { rebuild }) {
  if (rebuild) {
    rmSync(environment.instanceDir, { recursive: true, force: true });
    process.stdout.write(`Rebuilt: removed ${environment.instanceDir}\n`);
  } else {
    assertMigrationsUsable(environment);
  }
  prepare(environment);
  const persist = ["--persist-to", environment.stateDir];
  runWrangler(["d1", "migrations", "apply", "greenroom-local", "--local", ...persist], environment);
  runWrangler(
    ["d1", "execute", "greenroom-local", "--local", ...persist, "--file", "seed/reset.sql"],
    environment,
  );
  runWrangler(
    [
      "r2",
      "object",
      "put",
      SEED_ASSET_KEY,
      "--local",
      ...persist,
      "--file",
      "seed/assets/speaker-portrait.png",
      "--content-type",
      "image/png",
    ],
    environment,
  );
  // Written only after every migration applied, so a half-applied reset is not recorded as a
  // clean identity that the next run would then trust.
  writeMigrationRecord(
    environment.migrationRecordPath,
    migrationIdentity(environment.migrationsDir),
  );
}

function main(argv) {
  const command = argv[0];
  const environment = resolveWorktreeEnvironment();
  if (command === "dev") {
    assertMigrationsUsable(environment);
    prepare(environment);
    runWrangler(
      [
        "dev",
        "src/index.ts",
        "--port",
        String(environment.apiPort),
        "--persist-to",
        environment.stateDir,
        // Stamped into `/health` so a test run can prove the server answering its port is this
        // checkout's and not another clone's (issue #90). Both are non-secret.
        "--var",
        `GREENROOM_WORKTREE_ROOT:${environment.root}`,
        "--var",
        `GREENROOM_COMMIT:${headCommit(environment.root)}`,
      ],
      environment,
    );
    return;
  }
  if (command === "reset") {
    reset(environment, { rebuild: argv.includes("--rebuild") });
    return;
  }
  if (command === "migrate") {
    assertMigrationsUsable(environment);
    prepare(environment);
    runWrangler(
      [
        "d1",
        "migrations",
        "apply",
        "greenroom-local",
        "--local",
        "--persist-to",
        environment.stateDir,
      ],
      environment,
    );
    writeMigrationRecord(
      environment.migrationRecordPath,
      migrationIdentity(environment.migrationsDir),
    );
    return;
  }
  if (command === "build") {
    // A dry-run deploy compiles the Worker and touches no local state, so it takes no
    // `--persist-to` and must not create an instance directory.
    runWrangler(["deploy", "--dry-run", "--outdir", "dist"], environment);
    return;
  }
  throw new Error(`Unknown command '${command ?? ""}'. Expected: dev, reset, migrate, build.`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // ERROR-INTENT: this is the CLI ownership boundary. The message is the product here — a
    // stack trace above a stale-migration diagnostic buries the one paragraph that tells the
    // contributor what to run — so the error is reported in full and turned into a non-zero
    // exit rather than rethrown. See docs/architecture/error-observability.md.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
