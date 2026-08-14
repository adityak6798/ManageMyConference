/**
 * Which configuration categories on an event are still outstanding, folded from its applications.
 *
 * This is issue #203, and it exists because the previous answer was per *application* rather than
 * per *category*. An application row is keyed per version, so applying a newer version — or a
 * different template, or the same one with a narrower selection — writes its own row and leaves
 * an older `partial` one exactly where it was. The surface that showed only the newest row went
 * quiet the moment anything else was applied, while the category the earlier application could
 * not write was still unconfigured.
 *
 * The reason it only ever showed the newest row is worth keeping, because it constrains the fix:
 * offering an older application as a whole-clone repair would write its payload over the
 * configuration that superseded it, since every category converges on the payload it is given.
 * "Re-apply version 1" against an event since configured from version 2 is a revert wearing the
 * word repair.
 *
 * Folding per category dissolves that. For each category, the deciding application is the newest
 * one that actually **reached** it, and a category is outstanding only when that application
 * refused it. So the repair this produces is never a revert: if a later application had
 * configured the category, that later one would be the deciding application and the category
 * would not be outstanding at all. The repair is therefore narrow by construction — one version,
 * one category — rather than narrow by convention.
 *
 * Pure, and deliberately in the domain: the rule is "what does this event still owe", which is a
 * statement about the event rather than about storage or about a screen. Two surfaces read it —
 * the templates workspace and the operational inbox — and a rule with two readers is a rule that
 * must not live in either.
 *
 * @spec PRD-EVT-002 PRD-OPS-002 ARC-FLOW-006
 */

/** The three verdicts that mean a category was reached and refused. */
const REFUSALS = ["failed", "incompatible", "unauthorized"] as const;

type Refusal = (typeof REFUSALS)[number];

/** Exactly the fields of a stored slice report this fold reads. */
export interface AppliedCategoryReport {
  readonly key: string;
  readonly label: string;
  readonly outcome: string;
  readonly reason: string;
}

/** Exactly the fields of a stored application this fold reads. */
export interface AppliedTemplateRecord {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateState: "active" | "archived";
  readonly templateVersionId: string;
  readonly version: number;
  readonly appliedAt: string;
  readonly destination: { readonly startsOn: string; readonly endsOn: string };
  readonly slices: readonly AppliedCategoryReport[];
}

/**
 * One category this event still owes, and the exact act that would settle it.
 *
 * Everything a repair needs is here, because the repair has to be *the same act* as the
 * application it repairs: the version that was applied, the destination range it was applied
 * against — a parameter of the clone rather than a property of the event, so nothing else could
 * reconstruct it — and this one category, never the whole selection the original command named.
 */
export interface OutstandingCategory {
  readonly key: string;
  readonly label: string;
  /** The refusal the deciding application recorded, and what it said about it. */
  readonly outcome: Refusal;
  readonly reason: string;
  readonly templateId: string;
  readonly templateName: string;
  /** An archived template cannot be applied, so a surface offering the repair must know. */
  readonly templateState: "active" | "archived";
  readonly templateVersionId: string;
  readonly version: number;
  /** When the deciding application ran — the occurrence, for anything that keys on it. */
  readonly outstandingSince: string;
  readonly destination: { readonly startsOn: string; readonly endsOn: string };
}

const isRefusal = (outcome: string): outcome is Refusal =>
  (REFUSALS as readonly string[]).includes(outcome);

/**
 * Fold every application this event has recorded into the categories still outstanding.
 *
 * Ordered newest-first internally rather than trusting the caller, because the whole answer turns
 * on which application is last and a caller that assumed wrong would report a settled category as
 * outstanding — or, worse, offer a repair that reverts.
 *
 * **A `skipped` category is transparent, and that is the one subtle rule here.** `skipped` means
 * the application wrote nothing *and* refused nothing: either the command did not name the
 * category, or the source event had nothing configured for it. Neither settles an earlier
 * refusal and neither creates one, so the fold looks straight through it to the application
 * before. Treating a skip as settling would let an organizer silence an outstanding category by
 * cloning a template that says nothing about it.
 *
 * A category can be **partly** applied — review refuses a locked rubric while its triage statuses
 * land — and that still counts as outstanding, because something the organizer asked for did not
 * arrive. The refusal wins over the entries beside it for the same reason `applied` is reserved
 * for an application that refused nothing.
 */
export function outstandingConfiguration(
  applications: readonly AppliedTemplateRecord[],
): readonly OutstandingCategory[] {
  const newestFirst = [...applications].toSorted((left, right) =>
    right.appliedAt.localeCompare(left.appliedAt),
  );
  const decided = new Map<string, OutstandingCategory | null>();
  for (const application of newestFirst)
    for (const slice of application.slices) {
      // The first application to reach this category decides it, and later rows are older.
      if (decided.has(slice.key)) continue;
      if (slice.outcome === "skipped") continue;
      decided.set(
        slice.key,
        isRefusal(slice.outcome)
          ? {
              key: slice.key,
              label: slice.label,
              outcome: slice.outcome,
              reason: slice.reason,
              templateId: application.templateId,
              templateName: application.templateName,
              templateState: application.templateState,
              templateVersionId: application.templateVersionId,
              version: application.version,
              outstandingSince: application.appliedAt,
              destination: application.destination,
            }
          : null,
      );
    }
  // Sorted by category key rather than by recency: the list is a checklist of what this event
  // owes, and a checklist whose order changes as rows age is one an operator cannot scan twice.
  return [...decided.values()]
    .filter((entry): entry is OutstandingCategory => entry !== null)
    .toSorted((left, right) => left.key.localeCompare(right.key));
}
