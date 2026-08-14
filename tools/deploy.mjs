// @spec ENG-CI-001 PRD-INT-001
/** Main-only release sequence, including the separately operated webhook egress Container. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEBHOOK_WRAPPING_KEY_VERSION = "v1";

const required = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Refusing deploy: ${name} is required.`);
  return value;
};

const webhookToken = (environment) => {
  const value = required(environment, "WEBHOOK_EGRESS_TOKEN");
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(value))
    throw new Error(
      "Refusing deploy: WEBHOOK_EGRESS_TOKEN must be a 32-256 character bearer-safe secret.",
    );
  return value;
};

const wrappingKeys = (environment) => {
  const value = required(environment, "WEBHOOK_WRAPPING_KEYS");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Refusing deploy: WEBHOOK_WRAPPING_KEYS must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Refusing deploy: WEBHOOK_WRAPPING_KEYS must be a JSON object.");
  for (const [version, encoded] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9_-]{1,40}$/.test(version) ||
      typeof encoded !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(encoded) ||
      Buffer.from(encoded, "base64").byteLength !== 32
    )
      throw new Error(
        "Refusing deploy: every WEBHOOK_WRAPPING_KEYS entry must have a valid version and base64 32-byte key.",
      );
  }
  if (!(WEBHOOK_WRAPPING_KEY_VERSION in parsed))
    throw new Error(
      `Refusing deploy: WEBHOOK_WRAPPING_KEYS must contain a base64 32-byte ${WEBHOOK_WRAPPING_KEY_VERSION} key.`,
    );
  return value;
};

export function deploymentSecrets(environment) {
  const token = webhookToken(environment);
  const previous = environment.WEBHOOK_EGRESS_TOKEN_PREVIOUS;
  if (previous !== undefined && previous !== "" && !/^[A-Za-z0-9._~-]{32,256}$/.test(previous))
    throw new Error(
      "Refusing deploy: WEBHOOK_EGRESS_TOKEN_PREVIOUS must be empty or a 32-256 character bearer-safe secret.",
    );
  return {
    egress: {
      WEBHOOK_EGRESS_TOKEN: token,
      // `wrangler secret bulk` reads null as deletion; deploy's `--secrets-file` path filters it.
      WEBHOOK_EGRESS_TOKEN_PREVIOUS: previous || null,
    },
    api: {
      WEBHOOK_EGRESS_TOKEN: token,
      WEBHOOK_WRAPPING_KEYS: wrappingKeys(environment),
    },
  };
}

export function deploymentCommands(secretDirectory) {
  const egressSecrets = path.join(secretDirectory, "webhook-egress.json");
  return [
    ["npm", ["run", "migrate:remote", "--workspace", "@greenroom/api"]],
    ["npm", ["run", "build", "--workspace", "@greenroom/web"]],
    [
      "npm",
      ["run", "secrets:reconcile", "--workspace", "@greenroom/webhook-egress", "--", egressSecrets],
    ],
    ["npm", ["run", "deploy", "--workspace", "@greenroom/webhook-egress"]],
    [
      "npm",
      [
        "run",
        "deploy",
        "--workspace",
        "@greenroom/api",
        "--",
        "--secrets-file",
        path.join(secretDirectory, "api-webhooks.json"),
      ],
    ],
  ];
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Deployment command ${command} ${args.slice(0, 3).join(" ")} failed.`);
};

export function main(environment = process.env, runner = run) {
  // Validate every secret before migrations or deployments change remote state.
  const secrets = deploymentSecrets(environment);
  const secretDirectory = mkdtempSync(path.join(tmpdir(), "greenroom-deploy-"));
  try {
    writeFileSync(
      path.join(secretDirectory, "webhook-egress.json"),
      JSON.stringify(secrets.egress),
      {
        mode: 0o600,
      },
    );
    writeFileSync(path.join(secretDirectory, "api-webhooks.json"), JSON.stringify(secrets.api), {
      mode: 0o600,
    });
    for (const [command, args] of deploymentCommands(secretDirectory)) runner(command, args);
  } finally {
    rmSync(secretDirectory, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
