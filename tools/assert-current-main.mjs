// @spec ENG-CI-001
/** Refuse to deploy a commit that a newer main-branch push has already superseded. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assertCurrentMain({ eventName, ref, sha, remoteMain }) {
  if (eventName !== "push" || ref !== "refs/heads/main")
    throw new Error("Refusing deploy: this is not a push to refs/heads/main.");
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(remoteMain))
    throw new Error("Refusing deploy: GitHub or origin/main did not provide a full commit SHA.");
  if (sha !== remoteMain)
    throw new Error(
      `Refusing stale deploy: workflow commit ${sha} is no longer origin/main ${remoteMain}.`,
    );
}

export function main(env = process.env) {
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: ROOT, stdio: "inherit" });
  const remoteMain = execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assertCurrentMain({
    eventName: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    sha: env.GITHUB_SHA ?? "",
    remoteMain,
  });
  process.stdout.write(`Deploying current main commit ${remoteMain.slice(0, 12)}.\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    // ERROR-INTENT: the release boundary reports one actionable refusal and a non-zero exit.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
