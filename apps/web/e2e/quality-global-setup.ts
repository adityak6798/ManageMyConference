import { rm } from "node:fs/promises";
import path from "node:path";
import {
  describeServerIdentityMismatch,
  headCommit,
  probeServerIdentity,
  resolveWorktreeEnvironment,
} from "../../../tools/worktree-env.mjs";

/** Refuse to measure a Worker serving an artifact from another checkout. */
export default async function globalSetup(): Promise<void> {
  const environment = resolveWorktreeEnvironment();
  await rm(path.join(environment.instanceDir, "browser-runtime-failure.txt"), { force: true });
  const probe = {
    label: "The built-artifact Worker",
    url: `http://127.0.0.1:${environment.apiPort}/health`,
  };
  const { fatal, warning } = describeServerIdentityMismatch(
    { root: environment.root, commit: headCommit(environment.root) },
    await probeServerIdentity(probe.url),
    probe,
  );
  if (fatal) throw new Error(`\n\n${fatal}\n`);
  // biome-ignore lint/suspicious/noConsole: a pre-run diagnostic has no other channel.
  if (warning) console.warn(`\n${warning}\n`);
}
