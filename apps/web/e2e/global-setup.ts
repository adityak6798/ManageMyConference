// @spec ENG-DEV-001
/**
 * Refuse to test a server that is not ours.
 *
 * Outside CI, `reuseExistingServer` is on: Playwright adopts whatever already answers the
 * health URL, whoever started it. Issue #90 records what that cost — port 8787 was held by a
 * `workerd` from a *different clone*, and the suite ran every API assertion against that
 * clone's code, reporting a confident 16/19 with three "failures" that had nothing to do with
 * the branch under test. Deriving ports (issue #28) stops two checkouts *colliding*; it does
 * not stop a run that explicitly names a port from adopting a stranger on it, and an override
 * is exactly where that bites.
 *
 * This runs before any spec. A mismatch aborts the run with the foreign path named.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import {
  describeServerIdentityMismatch,
  headCommit,
  probeServerIdentity,
  resolveWorktreeEnvironment,
} from "../../../tools/worktree-env.mjs";

export default async function globalSetup(): Promise<void> {
  const environment = resolveWorktreeEnvironment();
  await rm(path.join(environment.instanceDir, "browser-runtime-failure.txt"), { force: true });
  const expected = { root: environment.root, commit: headCommit(environment.root) };
  const probes = [
    { label: "The API server", url: `http://127.0.0.1:${environment.apiPort}/health` },
    // The web server is asserted through its own `/api` proxy rather than directly: Vite has
    // no identity of its own to report, but proving that *its* proxy reaches *our* API is the
    // property the specs actually depend on.
    {
      label: "The web server's /api proxy",
      url: `http://127.0.0.1:${environment.webPort}/api/health`,
    },
  ];
  for (const probe of probes) {
    const { fatal, warning } = describeServerIdentityMismatch(
      expected,
      await probeServerIdentity(probe.url),
      probe,
    );
    if (fatal) throw new Error(`\n\n${fatal}\n`);
    // biome-ignore lint/suspicious/noConsole: a pre-run diagnostic has no other channel.
    if (warning) console.warn(`\n${warning}\n`);
  }
}
