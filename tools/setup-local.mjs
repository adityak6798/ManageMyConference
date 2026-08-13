// @spec ENG-DEV-001 PRD-IAM-001
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const destination = new URL("../apps/api/.dev.vars", import.meta.url);
// Only the three bindings a local run cannot start without. Google sign-in's bindings are
// deliberately not written here: they need an OAuth client and a redirect URI registered against
// this checkout's derived port, so a generated placeholder would be a configuration that boots and
// then fails at Google. Absent means the door is simply not offered, which is the right default.
// See docs/engineering/local-development.md#google-sign-in-configuration.
if (!existsSync(destination)) {
  const secret = randomBytes(32).toString("hex");
  writeFileSync(
    destination,
    `ENVIRONMENT=development\nDEMO_MODE=true\nSESSION_SECRET=${secret}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write("Created ignored apps/api/.dev.vars with a random local session key.\n");
} else {
  process.stdout.write("Using existing ignored apps/api/.dev.vars.\n");
}
