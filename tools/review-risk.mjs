// @spec ENG-AGENT-001 TST-005
/**
 * Derive what a review of this change has to look at, and how hard.
 *
 * "Review this diff" is not a review input. Ralph repeatedly found authorization, migration,
 * concurrency, contract and async-state defects that the automated gates missed, and those
 * finds came from being pointed at the seam — not from re-reading everything at equal depth.
 * Broad repeated review is also expensive, so this classifies the change instead: which risk
 * dimensions it touches, which files raised them, and which domains and governing specs own
 * them.
 *
 * It selects and reports. It does not judge, and it never shortens the reviewer's conclusions:
 * a `deep` dimension means "look here properly", never "here is what you will find".
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { worktreeRoot } from "./worktree-env.mjs";

/**
 * The seams that get a deep pass whenever the change touches them.
 *
 * Each names why it is on the list, because a dimension nobody can justify is one that gets
 * quietly dropped the first time a review is in a hurry.
 */
export const DIMENSIONS = [
  {
    id: "authorization",
    depth: "deep",
    why: "A missing capability check is invisible to every gate here: the tests that would catch it are the ones nobody wrote.",
    matches: (file) =>
      /identity\/actor|demo-session|runtime-auth|\/routes\/identity\.ts$/.test(file) ||
      /capabilit|authoriz/i.test(file),
  },
  {
    id: "persistence-and-migrations",
    depth: "deep",
    why: "Migrations are immutable once merged, and a wrong one is a data problem rather than a code problem.",
    matches: (file) =>
      /^apps\/api\/migrations\//.test(file) || /schema\.ts$|seed\/reset\.sql$/.test(file),
  },
  {
    id: "concurrency-and-idempotency",
    depth: "deep",
    why: "Retry, ordering and double-submit defects pass a green suite and appear under load.",
    matches: (file) => /repository|outbox|throttle|conversion/.test(file),
  },
  {
    id: "provider-effects",
    depth: "deep",
    why: "An adapter that reaches outside the machine cannot be un-sent, and the fakes hide the difference.",
    matches: (file) => /adapters\/providers|adapters\/storage/.test(file),
  },
  {
    id: "public-contracts",
    depth: "deep",
    why: "A published shape is a promise to callers this repository does not control.",
    matches: (file) =>
      /^packages\/contracts\/src\//.test(file) ||
      /\/routes\/publishing\.ts$|PublicEventApp/.test(file),
  },
  {
    id: "cross-domain-composition",
    depth: "deep",
    why: "Composition roots and registries are where one domain's change becomes another domain's behaviour.",
    matches: (file) =>
      /registry\.tsx?$|contract\.ts$|transport\/http\/app\.ts$|src\/index\.ts$|App\.tsx$/.test(
        file,
      ),
  },
  {
    id: "harness-and-gates",
    depth: "deep",
    why: "A weakened gate makes every later review less trustworthy, and does it silently.",
    matches: (file) => /^tools\/|^\.github\/|^context\/|^context-manifest\.json$/.test(file),
  },
  {
    id: "product-behaviour",
    depth: "standard",
    why: "Ordinary feature surface: reviewed, but not at the depth the seams above get.",
    matches: (file) => /^apps\/(api|web)\/src\//.test(file),
  },
  {
    id: "documentation",
    depth: "standard",
    why: "Canonical documents are normative here; a wrong one misleads the next agent.",
    matches: (file) => /^docs\/|\.md$/.test(file) && !/^docs\/generated\//.test(file),
  },
];

/** Files whose content is produced by a command, and provable by re-running it. */
export const GENERATED = [
  "packages/contracts/openapi.json",
  "context-manifest.json",
  "docs/generated/context-index.md",
];

export function isGenerated(file) {
  return GENERATED.includes(file) || file.startsWith("docs/generated/");
}

export function changedFiles(base, cwd = worktreeRoot()) {
  const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

/** Which domains own these files, from the context manifest. */
export function owningDomains(files, manifest) {
  const owners = new Map();
  for (const file of files)
    for (const domain of manifest.domains)
      for (const owned of domain.paths)
        if (file === owned || file.startsWith(`${owned}/`)) {
          const existing = owners.get(domain.id) ?? [];
          if (!existing.includes(file)) owners.set(domain.id, [...existing, file]);
        }
  return owners;
}

/**
 * Classify a change.
 *
 * `abbreviated` is offered only when every changed file is a generated artifact, because that
 * is the one case where re-running the generator proves equivalence. A change that touches a
 * generator *and* its output is not generated-only: the generator is source.
 */
export function riskMap(files, manifest) {
  const dimensions = [];
  for (const dimension of DIMENSIONS) {
    const matched = files.filter((file) => !isGenerated(file) && dimension.matches(file));
    if (matched.length > 0)
      dimensions.push({
        id: dimension.id,
        depth: dimension.depth,
        why: dimension.why,
        files: matched,
      });
  }
  const generatedOnly = files.length > 0 && files.every(isGenerated);
  const specs = [
    ...new Set(
      [...owningDomains(files, manifest).keys()].flatMap(
        (id) => manifest.domains.find((domain) => domain.id === id)?.specs ?? [],
      ),
    ),
  ].sort();
  return {
    files,
    generatedOnly,
    path: generatedOnly ? "abbreviated" : "full",
    dimensions,
    deep: dimensions.filter((dimension) => dimension.depth === "deep").map(({ id }) => id),
    domains: Object.fromEntries(owningDomains(files, manifest)),
    specs,
  };
}

/** The review input a reviewer is actually given, instead of "review this diff". */
export function render(map) {
  if (map.files.length === 0)
    return "No changed files against the base; there is nothing to review.";
  const lines = [];
  if (map.generatedOnly)
    lines.push(
      "ABBREVIATED PATH. Every changed file is a generated artifact. Prove equivalence by",
      "re-running its generator and confirming the diff is empty; that is the whole review.",
      "This does not weaken source validation, because no source changed.",
      "",
    );
  lines.push(`Changed files: ${map.files.length}`);
  lines.push(
    `Domains: ${Object.keys(map.domains).join(", ") || "none declared"}`,
    `Governing specs: ${map.specs.join(", ") || "none"}`,
    "",
  );
  for (const dimension of map.dimensions) {
    lines.push(`[${dimension.depth.toUpperCase()}] ${dimension.id}`);
    lines.push(`  why: ${dimension.why}`);
    for (const file of dimension.files.slice(0, 12)) lines.push(`  - ${file}`);
    if (dimension.files.length > 12) lines.push(`  - … and ${dimension.files.length - 12} more`);
    lines.push("");
  }
  lines.push(
    "Report severity-ranked findings with concrete file and behaviour evidence. A dimension",
    "marked DEEP is where to look hardest; it is not a claim that something is wrong there,",
    "and finding nothing in one is a valid result worth stating.",
  );
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] ?? "origin/main";
  const root = worktreeRoot();
  const manifest = JSON.parse(readFileSync(path.join(root, "context-manifest.json"), "utf8"));
  const map = riskMap(changedFiles(base, root), manifest);
  process.stdout.write(
    process.argv.includes("--json") ? `${JSON.stringify(map, null, 2)}\n` : `${render(map)}\n`,
  );
}
