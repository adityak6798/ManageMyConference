// @spec ENG-AGENT-001 TST-005
/**
 * Keep the findings ledger true across review passes, and catch it going stale.
 *
 * A PR's findings comment is an audit record, and it decays in a specific way: a late repair
 * moves the head, the comment still names the old one, and it now describes a review of code
 * that is no longer there. Worse, a finding raised in pass 3 is easy to lose when pass 4
 * rewrites the table — so findings accumulate here rather than being re-derived each time.
 *
 * The ledger is the source; the comment is rendered from it.
 */
import { pathToFileURL } from "node:url";

/** A finding keeps its identity across passes: same dimension, same file, same claim. */
export function findingKey(finding) {
  return [finding.dimension ?? "unclassified", finding.file ?? "-", finding.summary]
    .join("::")
    .toLowerCase();
}

export const SEVERITIES = ["blocker", "major", "minor", "note"];
export const CLOSED_STATUSES = ["fixed", "rejected", "duplicate", "outdated", "deferred"];

/**
 * Fold a pass's findings into the ledger.
 *
 * Carrying forward is the default. A finding disappearing from a later pass means the reviewer
 * did not raise it again, which is not the same as it being fixed — only an explicit
 * disposition closes one, and that disposition has to name the evidence.
 */
export function mergePass(ledger, pass) {
  const merged = new Map(ledger.findings.map((finding) => [findingKey(finding), { ...finding }]));
  for (const finding of pass.findings) {
    const key = findingKey(finding);
    const existing = merged.get(key);
    merged.set(key, {
      ...existing,
      ...finding,
      firstSeenPass: existing?.firstSeenPass ?? pass.pass,
      lastSeenPass: pass.pass,
      status: finding.status ?? existing?.status ?? "open",
    });
  }
  return {
    ...ledger,
    head: pass.head,
    passes: [
      ...ledger.passes,
      {
        pass: pass.pass,
        head: pass.head,
        durationMinutes: pass.durationMinutes ?? null,
        found: pass.findings.length,
      },
    ],
    findings: [...merged.values()].sort(
      (left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity),
    ),
  };
}

export function emptyLedger() {
  return { head: null, passes: [], findings: [] };
}

/** Blockers and majors that are still open. Zero of these is the bar for review-ready. */
export function unresolved(ledger) {
  return ledger.findings.filter(
    (finding) =>
      ["blocker", "major"].includes(finding.severity) && !CLOSED_STATUSES.includes(finding.status),
  );
}

/**
 * Reasons this ledger cannot be published as the PR's audit record yet.
 *
 * `head` is the commit the PR now points at. A ledger whose last pass ran against anything else
 * describes a review of code that is no longer there.
 */
export function publicationProblems(ledger, head) {
  const problems = [];
  if (ledger.passes.length === 0) problems.push("No review pass has been recorded.");
  const last = ledger.passes.at(-1);
  if (last && last.head !== head)
    problems.push(
      `The last review pass ran against ${String(last.head).slice(0, 12)}, and the PR head is ` +
        `${String(head).slice(0, 12)}. A repair after the review needs another pass before the ` +
        "findings comment can claim to describe this head.",
    );
  for (const pass of ledger.passes)
    if (typeof pass.durationMinutes !== "number")
      problems.push(
        `Review pass ${pass.pass} has no duration. Record elapsed minutes so review cost and ` +
          "finding yield can be tuned from evidence.",
      );
  for (const finding of unresolved(ledger))
    problems.push(
      `${finding.severity} still open: ${finding.summary}. A blocker or major closes on ` +
        "evidence from a re-review, never on self-attestation.",
    );
  for (const finding of ledger.findings)
    if (CLOSED_STATUSES.includes(finding.status) && !finding.evidence)
      problems.push(
        `'${finding.summary}' is marked ${finding.status} with no evidence. Name the test, the commit, ` +
          "or the reviewer pass that closed it.",
      );
  return problems;
}

/** The findings table, rendered from the ledger so it cannot drift from it. */
export function renderFindings(ledger, head) {
  const rows = ledger.findings.map(
    (finding) =>
      `| ${finding.severity} | ${finding.dimension ?? "—"} | ${finding.summary} | ` +
      `${finding.status ?? "open"} | ${finding.evidence ?? "—"} | pass ${finding.firstSeenPass} |`,
  );
  return [
    `<!-- ship-it-findings -->`,
    `## Ship It review findings`,
    "",
    `Reviewed head: \`${head}\`. ${ledger.passes.length} pass(es), ` +
      `${ledger.findings.length} finding(s), ${passStatistics(ledger).totalMinutes} review minute(s).`,
    "",
    "| Severity | Dimension | Finding | Disposition | Evidence | Raised |",
    "|---|---|---|---|---|---|",
    ...(rows.length > 0 ? rows : ["| — | — | No findings were raised. | — | — | — |"]),
  ].join("\n");
}

/** Duration and yield per pass, so the policy can be tuned against evidence rather than taste. */
export function passStatistics(ledger) {
  const timed = ledger.passes.filter((pass) => typeof pass.durationMinutes === "number");
  return {
    passes: ledger.passes.length,
    findings: ledger.findings.length,
    blockersAndMajors: ledger.findings.filter((finding) =>
      ["blocker", "major"].includes(finding.severity),
    ).length,
    totalMinutes: timed.reduce((sum, pass) => sum + pass.durationMinutes, 0),
    findingsPerPass: ledger.passes.map((pass) => pass.found),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(
    "This module is used by the Ship It skill; it has no standalone command.\n" +
      "See .agents/skills/ship-it/references/review-loop.md.\n",
  );
}
