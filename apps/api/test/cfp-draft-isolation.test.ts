// @acceptance ACC-CFP
/*
 * A draft must stay invisible to the organizer and reviewer projection, and this asserts that of
 * the *source* rather than of one draft's behaviour.
 *
 * `d1-cfp-account-binding.integration.test.ts` already drives every read path of
 * `D1SubmittedProposalAdapter` against a real draft in a real database, which is the stronger
 * evidence for the paths that exist. What it cannot do is fail when somebody adds a fifth one: a
 * hand-written enumeration only knows the four it was written for, and a new `SELECT … FROM
 * cfp_submissions` without the predicate would leak a proposal nobody submitted while every test
 * stayed green.
 *
 * So this reads the file. It is a coarse instrument deliberately — the rule it enforces is coarse:
 * inside the adapter that answers organizers and reviewers, every statement that names
 * `cfp_submissions` carries the lifecycle predicate. A review pass found the comment on
 * `SUBMITTED_ONLY` claiming exactly this protection when nothing provided it, which is the kind of
 * false statement about a guarantee that is worse than having no comment at all.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CFP_DRAFT_STATUS } from "../src/domain/cfp/cfp";

const ADAPTER = new URL(
  "../src/adapters/persistence/d1-submitted-proposal-adapter.ts",
  import.meta.url,
);

/** Every template-literal or plain SQL string in the file that names the submissions table. */
function statementsNamingSubmissions(source: string): string[] {
  // Statements are written as single- or back-quoted strings passed to `prepare(...)`. Splitting on
  // the table name and keeping the surrounding string is enough to judge each occurrence, and does
  // not need a SQL parser to be a useful gate.
  return source
    .split("\n")
    .filter((line) => line.includes("cfp_submissions"))
    .map((line) => line.trim());
}

describe("the draft-isolation predicate", () => {
  const source = readFileSync(ADAPTER, "utf8");

  it("is on every statement in the proposal adapter that names cfp_submissions", () => {
    const naming = statementsNamingSubmissions(source);
    // If this file stops finding statements the test has stopped testing anything.
    expect(naming.length).toBeGreaterThanOrEqual(4);
    const unguarded = naming.filter(
      (line) => !line.includes("SUBMITTED_ONLY") && !line.startsWith("*") && !line.startsWith("//"),
    );
    expect(
      unguarded,
      `statements missing the lifecycle predicate:\n${unguarded.join("\n")}`,
    ).toEqual([]);
  });

  it("is defined as the lifecycle predicate and nothing looser", () => {
    // A future edit that redefined `SUBMITTED_ONLY` as `1 = 1` would satisfy the scan above while
    // removing the protection entirely, so the constant's own text is pinned.
    expect(source).toContain(`const SUBMITTED_ONLY = "lifecycle = 'submitted'"`);
  });

  it("keeps the draft status unspellable as a configured triage status", () => {
    /*
     * The second half of the same protection, and the reason it is asserted here rather than
     * assumed in a migration comment: `proposalStatusSchema` accepts `^[a-z0-9_-]+$`, so any value
     * matching that pattern is a triage key an organizer can configure. A draft's status must not
     * be one — an earlier version used the bare word `draft`, and an event configuring it turned a
     * bulk transition, a routed submission and a status delete into failures.
     */
    expect(CFP_DRAFT_STATUS).not.toMatch(/^[a-z0-9_-]+$/);
  });
});
