// @acceptance ACC-HARNESS
// @spec ENG-DEV-001 TST-005
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  derivePorts,
  describeServerIdentityMismatch,
  probeServerIdentity,
  migrationIdentity,
  PORT_BLOCK_BASE,
  PORT_BLOCK_COUNT,
  readMigrationRecord,
  resolveWorktreeEnvironment,
  staleMigrationDiagnostic,
  statusReport,
  writeMigrationRecord,
} from "../worktree-env.mjs";

function migrationsFixture(files) {
  const directory = mkdtempSync(path.join(tmpdir(), "greenroom-migrations-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(directory, name), body, "utf8");
  return directory;
}

function environmentFixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "greenroom-worktree-"));
  mkdirSync(path.join(root, "apps", "api", "migrations"), { recursive: true });
  return resolveWorktreeEnvironment({ GREENROOM_WORKTREE_ROOT: root, ...overrides });
}

test("ports are derived from the checkout path and are stable", () => {
  const first = derivePorts("/tmp/checkout-a");
  assert.deepEqual(first, derivePorts("/tmp/checkout-a"));
  assert.notDeepEqual(first, derivePorts("/tmp/checkout-b"));
});

test("derived ports sit inside the reserved block and never collide with each other", () => {
  for (const root of ["/a", "/b", "/c/d/e", "/Users/x/GH/repo", "/home/runner/work/r/r"]) {
    const { apiPort, webPort } = derivePorts(root);
    assert.ok(apiPort >= PORT_BLOCK_BASE && apiPort < PORT_BLOCK_BASE + PORT_BLOCK_COUNT * 2);
    assert.equal(webPort, apiPort + 1);
    // Below the ephemeral range the kernel allocates from, so a derived port cannot collide
    // with a socket the operating system handed out on its own.
    assert.ok(webPort < 49152);
  }
});

test("two worktrees of one clone resolve different ports and different state directories", () => {
  const left = resolveWorktreeEnvironment({ GREENROOM_WORKTREE_ROOT: "/repo/worktrees/left" });
  const right = resolveWorktreeEnvironment({ GREENROOM_WORKTREE_ROOT: "/repo/worktrees/right" });
  assert.notEqual(left.apiPort, right.apiPort);
  assert.notEqual(left.stateDir, right.stateDir);
});

test("two instances of one worktree get separate state directories", () => {
  const root = "/repo";
  const first = resolveWorktreeEnvironment({ GREENROOM_WORKTREE_ROOT: root });
  const second = resolveWorktreeEnvironment({
    GREENROOM_WORKTREE_ROOT: root,
    GREENROOM_API_PORT: "8887",
  });
  // `GAP-004`: a per-worktree state directory is not enough. Two `wrangler dev` processes of
  // one checkout on different ports shared one D1 file and corrupted each other's runs.
  assert.notEqual(first.stateDir, second.stateDir);
  assert.equal(second.apiPort, 8887);
  assert.equal(second.apiPortSource, "override");
  assert.equal(first.apiPortSource, "derived");
});

test("an unusable port override is refused with the variable named", () => {
  for (const value of ["0", "70000", "not-a-port", "8787.5"]) {
    assert.throws(
      () =>
        resolveWorktreeEnvironment({ GREENROOM_WORKTREE_ROOT: "/repo", GREENROOM_API_PORT: value }),
      /GREENROOM_API_PORT must be an integer between 1 and 65535/,
    );
  }
});

test("migration identity covers filenames and contents", () => {
  const directory = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  const before = migrationIdentity(directory);
  assert.deepEqual(before.names, ["0001_a.sql"]);
  writeFileSync(path.join(directory, "0001_a.sql"), "CREATE TABLE a(id INTEGER);", "utf8");
  assert.notEqual(migrationIdentity(directory).digest, before.digest);
});

test("adding a migration is a forward step, not a conflict", () => {
  const directory = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  const recorded = migrationIdentity(directory);
  writeFileSync(path.join(directory, "0002_b.sql"), "CREATE TABLE b(id TEXT);", "utf8");
  const environment = environmentFixture();
  assert.equal(staleMigrationDiagnostic(recorded, migrationIdentity(directory), environment), null);
});

test("a migration applied here and since deleted is an actionable conflict", () => {
  const directory = migrationsFixture({
    "0001_a.sql": "CREATE TABLE a(id TEXT);",
    "0002_b.sql": "CREATE TABLE b(id TEXT);",
  });
  const recorded = migrationIdentity(directory);
  const shrunk = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  const message = staleMigrationDiagnostic(
    recorded,
    migrationIdentity(shrunk),
    environmentFixture(),
  );
  assert.match(message ?? "", /0002_b\.sql/);
  assert.match(message ?? "", /no longer in the repository/);
  assert.match(message ?? "", /npm run reset -- --rebuild/);
});

test("a migration edited after it was applied is an actionable conflict", () => {
  const directory = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  const recorded = migrationIdentity(directory);
  writeFileSync(path.join(directory, "0001_a.sql"), "CREATE TABLE a(id INTEGER);", "utf8");
  const message = staleMigrationDiagnostic(
    recorded,
    migrationIdentity(directory),
    environmentFixture(),
  );
  assert.match(message ?? "", /0001_a\.sql/);
  assert.match(message ?? "", /then edited in the repository/);
});

test("no recorded identity is not a conflict", () => {
  const directory = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  assert.equal(
    staleMigrationDiagnostic(null, migrationIdentity(directory), environmentFixture()),
    null,
  );
});

test("a migration record round-trips, and an unreadable one reads as absent", () => {
  const environment = environmentFixture();
  const directory = migrationsFixture({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
  const identity = migrationIdentity(directory);
  writeMigrationRecord(environment.migrationRecordPath, identity);
  assert.deepEqual(readMigrationRecord(environment.migrationRecordPath), identity);
  writeFileSync(environment.migrationRecordPath, "{ truncated", "utf8");
  assert.equal(readMigrationRecord(environment.migrationRecordPath), null);
});

const PROBE = { label: "The API server", url: "http://127.0.0.1:20192/health" };
const HERE = { root: "/repo/worktrees/mine", commit: "a".repeat(40) };

test("a server from another checkout is fatal and names both paths", () => {
  const { fatal, warning } = describeServerIdentityMismatch(
    HERE,
    { root: "/Users/x/GH/ManageMyConference-issue-10-20260810-a7f3", commit: "b".repeat(40) },
    PROBE,
  );
  assert.match(fatal ?? "", /belongs to a different checkout/);
  assert.match(fatal ?? "", /ManageMyConference-issue-10-20260810-a7f3/);
  assert.match(fatal ?? "", /\/repo\/worktrees\/mine/);
  assert.equal(warning, null);
});

test("our own server at our own commit is accepted silently", () => {
  assert.deepEqual(describeServerIdentityMismatch(HERE, { ...HERE }, PROBE), {
    fatal: null,
    warning: null,
  });
});

test("a trailing-slash or unnormalised root is still our own server", () => {
  const { fatal } = describeServerIdentityMismatch(
    HERE,
    { root: `${HERE.root}/`, commit: HERE.commit },
    PROBE,
  );
  assert.equal(fatal, null);
});

test("nothing listening is not a mismatch — the suite starts its own server", () => {
  assert.deepEqual(describeServerIdentityMismatch(HERE, null, PROBE), {
    fatal: null,
    warning: null,
  });
});

test("a server that reports no identity is fatal", () => {
  const { fatal } = describeServerIdentityMismatch(HERE, undefined, PROBE);
  assert.match(fatal ?? "", /reports no build identity/);
  assert.match(fatal ?? "", /npm run dev/);
});

test("a server answering with something that is not the health document is fatal", async () => {
  // `undefined`, not `null`. Something is listening and has not identified itself, which is the
  // case the guard exists for; reading it as "nothing listening" would let the run adopt it.
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("<html>not json</html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const actual = await probeServerIdentity(`http://127.0.0.1:${port}/health`);
    assert.equal(actual, undefined);
    assert.match(
      describeServerIdentityMismatch(HERE, actual, PROBE).fatal ?? "",
      /no build identity/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("nothing listening probes as null, which is not a mismatch", async () => {
  // Port 1 is privileged and unbound in every environment this runs in.
  assert.equal(await probeServerIdentity("http://127.0.0.1:1/health"), null);
});

test("our own checkout at another commit warns but does not abort", () => {
  // `wrangler dev` reloads source on change, so a server started at an older commit is serving
  // the current working tree. The case that genuinely matters — a database built from
  // different migrations — is caught precisely by the migration identity check instead.
  const { fatal, warning } = describeServerIdentityMismatch(
    HERE,
    { root: HERE.root, commit: "c".repeat(40) },
    PROBE,
  );
  assert.equal(fatal, null);
  assert.match(warning ?? "", /was started at commit cccccccccccc/);
});

test("the status report resolves paths and never prints a secret", () => {
  const environment = environmentFixture();
  writeFileSync(path.join(environment.root, "apps", "api", ".dev.vars"), "SESSION_SECRET=abc123\n");
  const report = statusReport(environment);
  assert.match(report, /api port {2,}\d+/);
  assert.match(report, /present \(contents never printed\)/);
  assert.doesNotMatch(report, /abc123/);
  assert.doesNotMatch(report, /SESSION_SECRET=/);
});
