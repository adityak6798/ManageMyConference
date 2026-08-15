// @spec ACC-DEMO-SMOKE
/**
 * Reproducible SessionBoard evaluator entrypoint.
 *
 * Product state, the evaluator checkout, its browser storage and every report remain below the
 * gitignored `.evidence/` directory. A missing model credential is recorded as a blocked run with
 * a validated 18-scenario plan; it is never turned into a score.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorktreeEnvironment, worktreeRoot } from "./worktree-env.mjs";

export const EVALUATOR_URL = "https://github.com/mkly/killmysaas-evals-coding-agent.git";
export const EVALUATOR_COMMIT = "d8fafa41cdc484309e3fda953c5567cc2d462734";
const ROOT = worktreeRoot(path.dirname(fileURLToPath(import.meta.url)));

export function sanitizedConfiguration(url) {
  return {
    url,
    areas: [],
    includeOptional: false,
    agentModel: "claude-sonnet-5",
    judgeModel: "claude-opus-5",
    maxTurnsPerScenario: 70,
    headless: true,
    submissionNotes:
      "Use the seeded Continue-as demo personas. Exercise all six required areas and all 18 required scenarios.",
  };
}

export function treeState(cwd = ROOT) {
  const commit = command("git", ["rev-parse", "HEAD"], cwd).stdout.trim();
  const porcelain = command(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  ).stdout;
  return {
    commit,
    clean: porcelain.length === 0,
    changes: porcelain.trim().split("\n").filter(Boolean),
  };
}

function command(program, args, cwd, options = {}) {
  const result = spawnSync(program, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${program} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function ensureEvaluator(checkout) {
  if (!existsSync(path.join(checkout, ".git"))) {
    mkdirSync(path.dirname(checkout), { recursive: true });
    command("git", ["clone", "--no-checkout", EVALUATOR_URL, checkout], ROOT);
  }
  command("git", ["remote", "set-url", "origin", EVALUATOR_URL], checkout);
  command("git", ["fetch", "--depth=1", "origin", EVALUATOR_COMMIT], checkout);
  command("git", ["checkout", "--detach", EVALUATOR_COMMIT], checkout);
  const actual = command("git", ["rev-parse", "HEAD"], checkout).stdout.trim();
  if (actual !== EVALUATOR_COMMIT) throw new Error(`Evaluator pin mismatch: ${actual}`);
}

function pnpm(args, cwd, options = {}) {
  const corepack = spawnSync("corepack", ["--version"], { encoding: "utf8" });
  return corepack.status === 0
    ? command("corepack", ["pnpm", ...args], cwd, options)
    : command("npx", ["--yes", "pnpm@10.33.1", ...args], cwd, options);
}

function newestRun(evaluator) {
  const directory = path.join(evaluator, "runs");
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory).filter((name) => existsSync(path.join(directory, name)));
  return names.sort().at(-1) ?? null;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 45_000;
  let lastConnectionFailed = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Local Worker exited before health was ready (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // ERROR-INTENT: connection refusal is the expected state while the local Worker starts.
      lastConnectionFailed = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${url}/health${lastConnectionFailed ? " after connection refusal" : ""}`,
  );
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function run(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(/[:.]/g, "-");
  const evidenceRoot = path.join(ROOT, ".evidence", "sbek");
  const archive = path.join(evidenceRoot, "runs", stamp);
  const evaluator = path.resolve(
    valueAfter(argv, "--evaluator-dir") ?? path.join(evidenceRoot, "evaluator"),
  );
  const local = !argv.includes("--no-local-server");
  const portSeed = Number.parseInt(
    createHash("sha256").update(stamp).digest("hex").slice(0, 8),
    16,
  );
  const isolatedPort = 30_000 + (portSeed % 9_000) * 2;
  const runnerEnv = local
    ? { ...process.env, GREENROOM_API_PORT: String(isolatedPort) }
    : process.env;
  const environment = resolveWorktreeEnvironment(runnerEnv, ROOT);
  const url = valueAfter(argv, "--url") ?? `http://127.0.0.1:${environment.apiPort}`;
  const target = treeState();
  const configuration = sanitizedConfiguration(url);
  const metadata = {
    schemaVersion: 1,
    status: "running",
    startedAt,
    target,
    evaluator: { url: EVALUATOR_URL, commit: EVALUATOR_COMMIT },
    configuration,
    configurationSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
    fixture: { isolatedStateDirectory: environment.stateDir, resetBeforeRun: local },
    failures: [],
  };
  writeJson(path.join(archive, "metadata.json"), metadata);

  let server;
  const serverLog = [];
  try {
    ensureEvaluator(evaluator);
    pnpm(["install", "--frozen-lockfile"], evaluator);
    const configFile = path.join(archive, "evalconfig.json");
    writeJson(configFile, configuration);
    if (local) {
      command("npm", ["run", "setup:local"], ROOT, { env: runnerEnv });
      command("npm", ["run", "build", "--workspace", "@greenroom/web"], ROOT, { env: runnerEnv });
      command("npm", ["run", "reset"], ROOT, { env: runnerEnv });
      server = spawn("npm", ["run", "dev", "--workspace", "@greenroom/api"], {
        cwd: ROOT,
        env: runnerEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout.on("data", (chunk) => serverLog.push(chunk));
      server.stderr.on("data", (chunk) => serverLog.push(chunk));
      await waitForHealth(url, server);
    }

    const before = newestRun(evaluator);
    const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY);
    const evaluatorArgs = hasCredential
      ? ["run", "eval", "--", "--config", configFile]
      : ["run", "sbek", "--", "plan", "--config", configFile];
    const manager = spawnSync("corepack", ["--version"], { encoding: "utf8" }).status === 0;
    const result = spawnSync(
      manager ? "corepack" : "npx",
      manager ? ["pnpm", ...evaluatorArgs] : ["--yes", "pnpm@10.33.1", ...evaluatorArgs],
      {
        cwd: evaluator,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    writeFileSync(
      path.join(archive, "evaluator.log"),
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
      "utf8",
    );
    if (result.error || result.status !== 0)
      throw new Error(`Evaluator exited ${result.status ?? "without a status"}`);
    const after = newestRun(evaluator);
    if (after && after !== before)
      cpSync(path.join(evaluator, "runs", after), path.join(archive, "artifacts"), {
        recursive: true,
      });
    metadata.status = hasCredential ? "completed" : "blocked";
    metadata.completedAt = new Date().toISOString();
    metadata.failures = hasCredential
      ? []
      : [
          {
            stage: "model-evaluation",
            reason:
              "ANTHROPIC_API_KEY is absent. The 18-scenario plan was validated and archived; no score was invented. Continue through the evaluator MCP harness or rerun with a credential.",
          },
        ];
    writeJson(path.join(archive, "metadata.json"), metadata);
    process.stdout.write(`${metadata.status}: ${archive}\n`);
    return metadata.status === "completed" ? 0 : 2;
  } catch (error) {
    // ERROR-INTENT: CLI ownership boundary records the full failure in metadata and exits nonzero.
    metadata.status = "failed";
    metadata.completedAt = new Date().toISOString();
    metadata.failures.push({
      stage: "runner",
      reason: error instanceof Error ? error.message : String(error),
    });
    writeJson(path.join(archive, "metadata.json"), metadata);
    process.stderr.write(`${metadata.failures.at(-1).reason}\nartifacts: ${archive}\n`);
    return 1;
  } finally {
    if (server && server.exitCode === null && server.pid) {
      // The detached group contains only the npm wrapper and Worker started by this invocation.
      // Killing the group avoids orphaning wrangler while leaving every other worktree alone.
      process.kill(-server.pid, "SIGTERM");
      server.stdout.destroy();
      server.stderr.destroy();
      server.unref();
    }
    if (serverLog.length > 0)
      writeFileSync(path.join(archive, "worker.log"), Buffer.concat(serverLog), "utf8");
  }
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await run();
}
