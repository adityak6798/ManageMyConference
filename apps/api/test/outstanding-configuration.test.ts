// @acceptance ACC-EVENT-TEMPLATES
/**
 * What an event still owes after being cloned into, folded per category (issue #203).
 *
 * The rule this pins is the one that closes the issue: outstanding work is answered per
 * **category** rather than per **application**, so a later clone cannot hide an earlier one's
 * refusal. Its exact closure condition — apply template A partially, then apply template B in
 * full, and assert the refused category is still reported — is the first case below.
 *
 * Driven at the domain function rather than through storage, because everything here is a
 * statement about a list of stored outcomes and nothing about how they are stored. The service
 * and route that carry it are exercised in `event-templates-http.test.ts`; this is the rule.
 */
import { describe, expect, it } from "vitest";
import {
  type AppliedTemplateRecord,
  outstandingConfiguration,
} from "../src/domain/events/outstanding-configuration";

const application = (
  overrides: Partial<AppliedTemplateRecord> & Pick<AppliedTemplateRecord, "slices">,
): AppliedTemplateRecord => ({
  templateId: "11111111-1111-4111-8111-111111111111",
  templateName: "Annual summit starter",
  templateState: "active",
  templateVersionId: "22222222-2222-4222-8222-222222222222",
  version: 1,
  appliedAt: "2027-01-05T12:00:00.000Z",
  destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
  ...overrides,
});

const slice = (
  key: string,
  outcome: string,
  label = key,
  reason = "",
): AppliedTemplateRecord["slices"][number] => ({ key, label, outcome, reason, incompatible: [] });

describe("outstandingConfiguration", () => {
  /**
   * The issue's own closure condition, verbatim.
   *
   * Before this fold, the surface showed the newest application and only when its own envelope
   * word said `partial`. Template B applied in full is newer and reads `applied`, so the agenda
   * category template A could not write went unreported from that moment — which is the failure
   * mode the whole card exists to prevent, reappearing in a narrower case.
   */
  it("still reports a category template A refused after template B applied in full", () => {
    const outstanding = outstandingConfiguration([
      application({
        templateName: "Template A",
        appliedAt: "2027-01-05T12:00:00.000Z",
        slices: [slice("cfp", "applied"), slice("agenda", "failed", "Rooms and time slots")],
      }),
      application({
        templateId: "33333333-3333-4333-8333-333333333333",
        templateName: "Template B",
        templateVersionId: "44444444-4444-4444-8444-444444444444",
        version: 3,
        appliedAt: "2027-02-09T09:00:00.000Z",
        slices: [slice("cfp", "applied"), slice("content-resources", "applied")],
      }),
    ]);

    expect(outstanding.map(({ key }) => key)).toEqual(["agenda"]);
    // And the repair it offers is template A's version, because that is the one that owes it —
    // not template B, which never carried the category at all.
    expect(outstanding[0]).toMatchObject({
      templateName: "Template A",
      version: 1,
      outstandingSince: "2027-01-05T12:00:00.000Z",
    });
  });

  it("clears a category a later application configured", () => {
    expect(
      outstandingConfiguration([
        application({ appliedAt: "2027-01-05T12:00:00.000Z", slices: [slice("agenda", "failed")] }),
        application({
          version: 2,
          appliedAt: "2027-02-09T09:00:00.000Z",
          slices: [slice("agenda", "applied")],
        }),
      ]),
    ).toEqual([]);
  });

  /**
   * A `skipped` category is transparent, and this is the case that makes it matter.
   *
   * `skipped` means the application wrote nothing *and* refused nothing — the command did not
   * name the category, or the source had nothing configured for it. Reading it as settling an
   * earlier refusal would let an organizer silence an outstanding category by cloning a template
   * that says nothing about it, which is the opposite of a repair.
   */
  it("looks through a skip to the application before it", () => {
    const outstanding = outstandingConfiguration([
      application({ appliedAt: "2027-01-05T12:00:00.000Z", slices: [slice("agenda", "failed")] }),
      application({
        version: 2,
        appliedAt: "2027-02-09T09:00:00.000Z",
        slices: [slice("agenda", "skipped")],
      }),
    ]);

    expect(outstanding.map(({ key }) => key)).toEqual(["agenda"]);
    expect(outstanding[0]).toMatchObject({ version: 1 });
  });

  it("reports a category the destination refused and one the actor could not write", () => {
    expect(
      outstandingConfiguration([
        application({
          slices: [
            slice("agenda", "incompatible", "Rooms and time slots"),
            slice("content-resources", "unauthorized", "Speaker portal resource pages"),
            slice("cfp", "applied"),
          ],
        }),
      ]).map(({ key, outcome }) => ({ key, outcome })),
    ).toEqual([
      { key: "agenda", outcome: "incompatible" },
      { key: "content-resources", outcome: "unauthorized" },
    ]);
  });

  /**
   * Two versions each owing a category is the shape the per-application surface could not hold.
   *
   * It showed one row, so the older version's category was invisible from the moment the newer
   * one was applied — and the two repairs are genuinely different acts, against different
   * versions, which is why they have to be two entries rather than one.
   */
  it("keeps a category from each version that owes one", () => {
    expect(
      outstandingConfiguration([
        application({
          appliedAt: "2027-01-05T12:00:00.000Z",
          slices: [slice("agenda", "failed")],
        }),
        application({
          templateVersionId: "44444444-4444-4444-8444-444444444444",
          version: 2,
          appliedAt: "2027-02-09T09:00:00.000Z",
          slices: [slice("content-resources", "unauthorized")],
        }),
      ]).map(({ key, version }) => ({ key, version })),
    ).toEqual([
      { key: "agenda", version: 1 },
      { key: "content-resources", version: 2 },
    ]);
  });

  it("answers the same whatever order the rows arrive in", () => {
    const rows = [
      application({ appliedAt: "2027-01-05T12:00:00.000Z", slices: [slice("agenda", "failed")] }),
      application({
        version: 2,
        appliedAt: "2027-02-09T09:00:00.000Z",
        slices: [slice("agenda", "applied")],
      }),
    ];

    // Newest-first is what the route promises; the fold sorts anyway, because the whole answer
    // turns on which row is last and a caller that assumed wrong would offer a revert.
    expect(outstandingConfiguration(rows)).toEqual(outstandingConfiguration([...rows].reverse()));
    expect(outstandingConfiguration(rows)).toEqual([]);
  });

  it("owes nothing when nothing has been applied", () => {
    expect(outstandingConfiguration([])).toEqual([]);
  });
});
