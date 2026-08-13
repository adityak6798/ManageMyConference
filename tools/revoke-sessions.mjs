// @spec PRD-IAM-001 ARC-AUTH-001
/**
 * Incident revocation: end sessions from the command line, when the console is not the right
 * instrument.
 *
 * The console offers a person their own sessions. This is the other case — a leaked backup, a
 * compromised device, a departing account — where an operator has to act on somebody else's
 * sessions, or on everybody's, and has to be able to say afterwards exactly what they did.
 *
 * Three guards, because this is a destructive command that signs real people out:
 *
 * 1. `--confirm <worker-name>` must name the worker in `apps/api/wrangler.toml`. Modelled on
 *    `assertDemoConfig` in `remote-demo-reset.mjs`: copying the command into a shell pointed at
 *    a different deployment fails closed rather than acting on the wrong database.
 * 2. Exactly one of `--user <id>` and `--all`. Neither is a mistake; both is a contradiction.
 * 3. A user id must be a plain identifier. The id is interpolated into SQL — `wrangler d1
 *    execute` takes a command string, not bound parameters — so anything that is not
 *    `[A-Za-z0-9_-]{1,64}` is refused rather than escaped. Refusing is checkable; escaping is
 *    the thing people get wrong.
 *
 * Every run writes its own `session.revoked_all` audit row with `source = 'system'` and the
 * correlation id it prints, so the revocation and the record of it are one command. That row is
 * how an operator answers "who ended these sessions, and when" afterwards.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identityRevocationStatements } from "../apps/api/src/adapters/persistence/identity-revocation-statements.mjs";

const CONFIG_PATH = new URL("../apps/api/wrangler.toml", import.meta.url);

/** A plain identifier, and nothing that could end a SQL string literal. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The `key = "value"` at the top level of a wrangler config. */
export function quotedValue(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
  return match?.[1];
}

/**
 * Refuse unless the caller named the worker this checkout actually configures.
 *
 * The check is against the config file rather than a flag alone, so `--confirm` cannot be
 * satisfied by repeating whatever the operator believed they were pointed at.
 */
export function assertWorkerConfirmation(configText, confirmation) {
  const configured = quotedValue(configText, "name");
  if (!configured)
    throw new Error("Refusing to revoke: apps/api/wrangler.toml declares no worker name.");
  if (confirmation !== configured)
    throw new Error(
      `Refusing to revoke. Re-run with one of:\n` +
        `  npm run revoke:sessions -- --confirm ${configured} --user <id>\n` +
        `  npm run revoke:sessions -- --confirm ${configured} --all`,
    );
  return configured;
}

export function parseArguments(argv) {
  const target = { user: undefined, all: false, confirm: undefined, local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--all") target.all = true;
    else if (flag === "--local") target.local = true;
    else if (flag === "--user") {
      target.user = argv[index + 1];
      index += 1;
    } else if (flag === "--confirm") {
      target.confirm = argv[index + 1];
      index += 1;
    } else throw new Error(`Unrecognized argument: ${flag}`);
  }
  if (target.all && target.user !== undefined)
    throw new Error("Choose one of --all and --user <id>, not both.");
  if (!target.all && target.user === undefined)
    throw new Error("Name what to revoke: --user <id> or --all.");
  if (target.user !== undefined && !USER_ID.test(target.user))
    throw new Error(
      `Refusing to revoke: --user must be a plain identifier matching ${USER_ID}, not ${JSON.stringify(target.user)}.`,
    );
  return target;
}

/**
 * The two statements this command runs, in order: the revocation, then its audit row.
 *
 * Built by `identity-access`, not here. They name `identity_sessions` and
 * `identity_audit_events`, which that domain owns, and a tool is not exempt from the boundary
 * every other cross-domain read respects. Re-exported so this module stays the one surface the
 * command's own test drives.
 */
export function revokeStatements(target, now, correlationId, rowId = crypto.randomUUID()) {
  return identityRevocationStatements({
    ...(target.all ? {} : { userId: target.user }),
    now,
    correlationId,
    rowId,
  });
}

function runWrangler(command) {
  const result = spawnSync("npx", ["wrangler", ...command], {
    cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`wrangler ${command.slice(0, 3).join(" ")} exited ${result.status}`);
}

export function main(
  argv = process.argv.slice(2),
  now = Date.now(),
  correlationId = crypto.randomUUID(),
) {
  const target = parseArguments(argv);
  assertWorkerConfirmation(readFileSync(CONFIG_PATH, "utf8"), target.confirm);
  runWrangler([
    "d1",
    "execute",
    "DB",
    target.local ? "--local" : "--remote",
    "--command",
    `${revokeStatements(target, now, correlationId).join("; ")};`,
    "--yes",
  ]);
  process.stdout.write(
    `Revoked ${target.all ? "every live session" : `every live session of ${target.user}`}. ` +
      `Audit correlation id: ${correlationId}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    // ERROR-INTENT: this CLI boundary turns a guard or provider failure into one actionable
    // message and a non-zero exit; a failing Wrangler command has already printed its own detail.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
