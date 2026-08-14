// @spec ENG-DEV-001 PRD-IAM-001
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const destination = new URL("../apps/api/.dev.vars", import.meta.url);

/**
 * The Google bindings, blank, and blank is the point.
 *
 * They are all three or none — `resolveGoogleConfiguration` refuses a partial configuration by
 * name, from inside `fetch`, so a Worker holding some of them answers 500 to *everything*. That
 * used to be impossible locally, because the deployment had none either. It stopped being
 * impossible when the deployed client id moved into `[vars]` in `wrangler.toml`: `wrangler dev`
 * reads that file, a development machine has no `GOOGLE_CLIENT_SECRET`, and the local Worker then
 * has exactly two of the three and refuses every request — including the health probe the browser
 * suite waits on, which fails as a 60-second `webServer` timeout that names nothing.
 *
 * An empty value in `.dev.vars` overrides the deployed one and is falsy, so all three read as
 * absent and the door is simply not offered: `/api/auth/config` reports `google: false` and both
 * routes answer 404, exactly as before. A placeholder *value* would be worse than blank — it
 * boots a configuration that then fails at Google, which is what the all-three-or-none guard
 * exists to prevent.
 *
 * To develop against a real client, replace all three with your own; the redirect URI has to be
 * registered against that client for this checkout's derived port. See
 * docs/engineering/local-development.md#google-sign-in-configuration.
 */
const GOOGLE_BINDINGS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];

/** The keys a `.dev.vars` file already declares, whatever their values. */
export function declaredKeys(text) {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("=")[0]?.trim())
      .filter((key) => key !== undefined && key !== ""),
  );
}

/**
 * Add any Google binding this file does not declare, blank, and change nothing else.
 *
 * Append rather than rewrite: an existing `.dev.vars` is somebody's local state — a real client
 * they are testing against, a session secret their cookies were signed with — and none of it is
 * recoverable from this repository. A key that is already present is left exactly as it is, blank
 * or not.
 */
export function withGoogleBindings(text) {
  const declared = declaredKeys(text);
  const missing = GOOGLE_BINDINGS.filter((name) => !declared.has(name));
  if (missing.length === 0) return { text, added: [] };
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return {
    text: `${text}${separator}${missing.map((name) => `${name}=`).join("\n")}\n`,
    added: missing,
  };
}

if (!existsSync(destination)) {
  const secret = randomBytes(32).toString("hex");
  writeFileSync(
    destination,
    `ENVIRONMENT=development\nDEMO_MODE=true\nSESSION_SECRET=${secret}\n${GOOGLE_BINDINGS.map(
      (name) => `${name}=`,
    ).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write("Created ignored apps/api/.dev.vars with a random local session key.\n");
} else {
  const existing = readFileSync(destination, "utf8");
  const { text, added } = withGoogleBindings(existing);
  if (added.length > 0) {
    writeFileSync(destination, text, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(
      `Using existing ignored apps/api/.dev.vars, with ${added.join(", ")} added blank so the ` +
        "deployed Google configuration does not half-apply locally.\n",
    );
  } else {
    process.stdout.write("Using existing ignored apps/api/.dev.vars.\n");
  }
}
