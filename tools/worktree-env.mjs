// @spec ENG-DEV-001
/**
 * One definition of "where does this checkout run, and where does it keep its local state".
 *
 * Every local entrypoint — `wrangler dev`, `wrangler d1`, Vite, Playwright — resolves its
 * ports and its state directory through this module, so two checkouts (or two instances of
 * one checkout) cannot quietly land on the same port or the same SQLite file. `GAP-004`
 * records what that costs when it happens: a browser suite that tests a stranger's code, and
 * a pair of `wrangler dev` processes sharing one D1 file whose interference reads as ordinary
 * assertion failures.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ports are one contiguous block, chosen to sit above every default this repository ever
 * documented (5173, 4173, 8787) and below the ephemeral range the operating system allocates
 * from (49152 on macOS and Linux), so a derived port can never collide with a socket the
 * kernel handed out on its own.
 */
export const PORT_BLOCK_BASE = 20000;
/** 500 blocks of two ports each: 20000-20999. */
export const PORT_BLOCK_COUNT = 500;

const TOOLS_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The checkout this process belongs to. `git rev-parse --show-toplevel` answers the worktree
 * root rather than the shared `.git` directory, which is what makes two worktrees of one
 * clone distinct identities here.
 */
export function worktreeRoot(cwd = TOOLS_ROOT) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // ERROR-INTENT: outside a git checkout — a tarball export, a container copy — the
    // repository directory is still a usable identity, and port derivation must not require
    // git to be present. The path is the identity either way.
    return TOOLS_ROOT;
  }
}

/** The commit this checkout is on, or "unknown" outside a git checkout. */
export function headCommit(cwd = TOOLS_ROOT) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // ERROR-INTENT: an export with no git history still has a usable path identity, which is
    // the half that decides whether a server belongs to this checkout. Reporting the commit as
    // unknown is more useful than refusing to start.
    return "unknown";
  }
}

/** Map a checkout path onto its port block. Same path in, same ports out, on every machine. */
export function derivePorts(root) {
  const digest = createHash("sha256").update(path.resolve(root)).digest();
  const apiPort = PORT_BLOCK_BASE + (digest.readUInt32BE(0) % PORT_BLOCK_COUNT) * 2;
  return { apiPort, webPort: apiPort + 1 };
}

function readPort(value, fallback, name) {
  if (value === undefined || value === "") return { port: fallback, source: "derived" };
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  return { port, source: "override" };
}

/**
 * Resolve ports and every local state path for this checkout.
 *
 * The state directory is keyed on the **API port**, not on the checkout, because the API port
 * is what identifies a running instance. Keying on the checkout alone is what `GAP-004`
 * measured and rejected: two `wrangler dev` processes of one worktree on different ports still
 * opened one `apps/api/.wrangler/state/v3/d1` file and corrupted each other's runs.
 */
export function resolveWorktreeEnvironment(env = process.env, cwd = TOOLS_ROOT) {
  const root = env.GREENROOM_WORKTREE_ROOT ?? worktreeRoot(cwd);
  const derived = derivePorts(root);
  const api = readPort(env.GREENROOM_API_PORT, derived.apiPort, "GREENROOM_API_PORT");
  const web = readPort(env.GREENROOM_WEB_PORT, derived.webPort, "GREENROOM_WEB_PORT");
  const instanceDir = path.join(root, "apps", "api", ".wrangler", "instances", String(api.port));
  return {
    root,
    derivedApiPort: derived.apiPort,
    derivedWebPort: derived.webPort,
    apiPort: api.port,
    webPort: web.port,
    apiPortSource: api.source,
    webPortSource: web.source,
    instanceDir,
    stateDir: path.join(instanceDir, "state"),
    configHome: path.join(instanceDir, "config"),
    logPath: path.join(instanceDir, "wrangler.log"),
    migrationRecordPath: path.join(instanceDir, "migration-identity.json"),
    migrationsDir: path.join(root, "apps", "api", "migrations"),
    playwrightOutputDir: path.join(root, "apps", "web", "test-results", String(api.port)),
    playwrightReportDir: path.join(root, "apps", "web", "playwright-report", String(api.port)),
  };
}

/**
 * The identity of the migration set on disk: every filename, and a digest of every file's
 * bytes. Contents are recorded per file because an edited migration is exactly as
 * incompatible with an already-migrated database as a deleted one, and is harder to notice —
 * but a *new* migration is the ordinary case and must not be mistaken for divergence.
 */
export function migrationIdentity(migrationsDir) {
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files = {};
  const digest = createHash("sha256");
  for (const name of names) {
    const bytes = readFileSync(path.join(migrationsDir, name));
    files[name] = createHash("sha256").update(bytes).digest("hex");
    digest.update(name);
    digest.update("\0");
    digest.update(bytes);
  }
  return { names, files, digest: digest.digest("hex") };
}

export function readMigrationRecord(recordPath) {
  if (!existsSync(recordPath)) return null;
  try {
    return JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    // ERROR-INTENT: a truncated or hand-edited record is indistinguishable from no record at
    // all for our purposes, and both resolve the same way — re-apply and rewrite it. Throwing
    // here would block the reset that repairs it.
    return null;
  }
}

export function writeMigrationRecord(recordPath, identity) {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

/**
 * Compare the migrations this state directory was built from against the ones on disk now.
 * Returns an actionable message, or null when the state is usable as it stands.
 *
 * Adding a migration is the ordinary forward case and is **not** a conflict: `wrangler d1
 * migrations apply` will apply the new file on the next reset. Only a migration that was
 * applied here and has since been deleted, or one whose bytes changed after being applied,
 * makes this database disagree with the schema the repository now describes — and neither can
 * be repaired by applying anything.
 */
export function staleMigrationDiagnostic(recorded, current, environment) {
  if (!recorded || recorded.digest === current.digest) return null;
  const recordedFiles = recorded.files ?? {};
  const recordedNames = recorded.names ?? Object.keys(recordedFiles);
  const removed = recordedNames.filter((name) => !current.names.includes(name));
  const changed = recordedNames.filter(
    (name) => current.files[name] !== undefined && current.files[name] !== recordedFiles[name],
  );
  if (removed.length === 0 && changed.length === 0) return null;
  const detail = [];
  if (removed.length > 0)
    detail.push(`applied here but no longer in the repository: ${removed.join(", ")}`);
  if (changed.length > 0)
    detail.push(`applied here, then edited in the repository: ${changed.join(", ")}`);
  return [
    `Local D1 state at ${environment.stateDir} was migrated from a different migration set.`,
    ...detail.map((line) => `  - ${line}`),
    "",
    "Applying migrations cannot repair either case, so this database no longer matches the",
    "schema the repository describes. Rebuild it:",
    "",
    "  npm run reset -- --rebuild",
    "",
    "That deletes only this instance's directory; other worktrees and other ports are untouched.",
  ].join("\n");
}

/**
 * Ask a running server who it belongs to. Returns the reported build identity, `undefined`
 * when the server answers but reports none, or `null` when nothing is listening.
 */
export async function probeServerIdentity(url) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    // ERROR-INTENT: a refused connection is the ordinary case — no server is up yet, and
    // Playwright is about to start ours. It is not a failure and must not read as one. This
    // catch covers *only* the connection, because anything a server actually answered has to
    // fall through to `undefined`: something is listening, and it has not identified itself.
    return null;
  }
  if (!response.ok) return undefined;
  try {
    return (await response.json()).build;
  } catch {
    // ERROR-INTENT: a 200 that is not the health document is a server we cannot identify, not
    // an absent one. Collapsing it to `null` would read as "nothing listening" and let the run
    // adopt it unchecked — the exact hole this guard exists to close.
    return undefined;
  }
}

/**
 * Decide whether a server already answering on our port is ours.
 *
 * The **path** is the decisive half and a mismatch is fatal: a server rooted in another
 * checkout is serving another branch's code, and every assertion made against it is
 * meaningless (issue #90 records a run that reported 16/19 against a stranger's clone).
 *
 * A differing **commit** is reported but not fatal, because `wrangler dev` reloads source on
 * change: a server started three commits ago is serving the working tree as it is now, so
 * aborting on it would be a false alarm in the ordinary edit-and-rerun loop. The case where a
 * stale process genuinely matters — the database it holds was built from different migrations
 * — is caught precisely, by the migration identity check, rather than guessed at from a SHA.
 */
export function describeServerIdentityMismatch(expected, actual, probe) {
  if (actual === null) return { fatal: null, warning: null };
  const where = `${probe.label} on ${probe.url}`;
  if (!actual || typeof actual.root !== "string")
    return {
      fatal: [
        `${where} answered, but reports no build identity.`,
        "",
        "It was not started by this repository's launcher, so there is no way to tell which",
        "checkout it belongs to. Stop it and start the servers with `npm run dev`, or let the",
        "suite start its own by freeing the port.",
      ].join("\n"),
      warning: null,
    };
  if (path.resolve(actual.root) !== path.resolve(expected.root))
    return {
      fatal: [
        `${where} belongs to a different checkout.`,
        "",
        `  this checkout:  ${expected.root}`,
        `  the server's:   ${actual.root}`,
        "",
        "Every API assertion in this run would have been made against that checkout's code.",
        "Stop that server, or give this run its own ports:",
        "",
        "  npm run worktree:status        # the ports this checkout resolves to",
        "  GREENROOM_API_PORT=… GREENROOM_WEB_PORT=… npm run test:e2e",
      ].join("\n"),
      warning: null,
    };
  if (actual.commit !== expected.commit)
    return {
      fatal: null,
      warning:
        `${where} was started at commit ${String(actual.commit).slice(0, 12)}, and this ` +
        `checkout is on ${String(expected.commit).slice(0, 12)}. Wrangler reloads source on ` +
        "change, so this is usually harmless — but restart it if migrations moved.",
    };
  return { fatal: null, warning: null };
}

/** Everything a contributor needs to see, and nothing that is a secret. */
export function statusReport(environment) {
  const migrations = existsSync(environment.migrationsDir)
    ? migrationIdentity(environment.migrationsDir)
    : { names: [], digest: "(no migrations directory)" };
  const recorded = readMigrationRecord(environment.migrationRecordPath);
  return [
    `worktree root      ${environment.root}`,
    `api port           ${environment.apiPort} (${environment.apiPortSource}; derived ${environment.derivedApiPort})`,
    `web port           ${environment.webPort} (${environment.webPortSource}; derived ${environment.derivedWebPort})`,
    `instance state     ${environment.instanceDir}`,
    `  d1/r2 state      ${environment.stateDir}${existsSync(environment.stateDir) ? "" : "  (not created yet)"}`,
    `  wrangler log     ${environment.logPath}`,
    `  wrangler config  ${environment.configHome}`,
    `migrations on disk ${migrations.names.length} files, digest ${migrations.digest.slice(0, 12)}`,
    `migrations applied ${
      recorded
        ? `${(recorded.names ?? []).length} files, digest ${String(recorded.digest).slice(0, 12)}`
        : "(none recorded for this instance)"
    }`,
    `dev secrets        apps/api/.dev.vars ${existsSync(path.join(environment.root, "apps", "api", ".dev.vars")) ? "present (contents never printed)" : "absent — run npm run setup:local"}`,
  ].join("\n");
}

function main(argv) {
  const command = argv[0] ?? "status";
  const environment = resolveWorktreeEnvironment();
  if (command === "status") {
    process.stdout.write(`${statusReport(environment)}\n`);
    const stale = staleMigrationDiagnostic(
      readMigrationRecord(environment.migrationRecordPath),
      migrationIdentity(environment.migrationsDir),
      environment,
    );
    if (stale) {
      process.stderr.write(`\n${stale}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "clean") {
    rmSync(environment.instanceDir, { recursive: true, force: true });
    process.stdout.write(`Removed ${environment.instanceDir}\n`);
    return;
  }
  if (command === "env") {
    process.stdout.write(
      `GREENROOM_API_PORT=${environment.apiPort}\nGREENROOM_WEB_PORT=${environment.webPort}\n`,
    );
    return;
  }
  process.stderr.write(`Unknown command '${command}'. Expected: status, clean, env.\n`);
  process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  main(process.argv.slice(2));
