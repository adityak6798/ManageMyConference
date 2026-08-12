/**
 * The organization-wide speaker directory.
 *
 * A prospect (`./prospect.ts`) is one event's outreach record. A contact is the person, held
 * once for the whole organization and linked to every event that has courted them. The two are
 * deliberately separate nouns: an event's pipeline stays event-scoped, and the directory is the
 * only thing that spans events, so cross-event visibility has exactly one place to be
 * authorized rather than being a side effect of any single event's pipeline read.
 *
 * @spec PRD-CRM-001
 */
import type { ProspectStage } from "./prospect";

export const contactSources = ["manual", "import", "prospect"] as const;
export type ContactSource = (typeof contactSources)[number];

/**
 * Directory activity kinds. `import`, `merge`, `outreach` and `conversion` are narrated by the
 * application as it performs the act they describe, exactly as `stage-change` is on a prospect,
 * so a caller cannot write a history entry for something that never happened.
 */
export const contactActivityKinds = [
  "note",
  "email",
  "call",
  "meeting",
  "import",
  "merge",
  "outreach",
  "conversion",
] as const;
export type ContactActivityKind = (typeof contactActivityKinds)[number];

export interface ContactCustomField {
  readonly key: string;
  readonly value: string;
}

/**
 * A former identity of this contact, kept when a duplicate is merged away. The merged record's
 * name and address stay resolvable, so an organizer who searches for the address printed on an
 * old badge still finds the person it belonged to.
 */
export interface ContactAlias {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly mergedFromId: string;
  readonly mergedAt: string;
}

/** One event this contact has been sourced into, projected from that event's prospect. */
export interface ContactEventLink {
  readonly eventId: string;
  readonly prospectId: string;
  readonly stage: ProspectStage;
  readonly speakerId: string | null;
  readonly convertedAt: string | null;
  readonly linkedAt: string;
}

export interface ContactActivity {
  readonly id: string;
  readonly kind: ContactActivityKind;
  readonly summary: string;
  readonly private: boolean;
  readonly occurredAt: string;
  readonly actorId: string;
}

// @spec PRD-CRM-001
export interface OrganizationContact {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  /** Already normalized by `normalizeEmail`; the directory's identity within an organization. */
  readonly email: string;
  readonly company: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly source: ContactSource;
  /**
   * Set when this record lost a merge. A merged-away contact is retained rather than deleted —
   * its activity and event links move to the primary, and this pointer keeps any id already
   * handed out resolvable — but it never appears in the directory again.
   */
  readonly mergedIntoId: string | null;
  readonly tags: readonly string[];
  readonly fields: readonly ContactCustomField[];
  readonly aliases: readonly ContactAlias[];
  readonly events: readonly ContactEventLink[];
  readonly activities: readonly ContactActivity[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a directory view selects. Every criterion is conjunctive, and every one of them is
 * optional, which is what makes "clear the filters" expressible as the empty object rather than
 * as a separate command.
 */
export interface DirectoryFilters {
  readonly search?: string | undefined;
  readonly company?: string | undefined;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly fieldKey?: string | undefined;
  readonly fieldValue?: string | undefined;
  readonly eventId?: string | undefined;
}

/** A named, reusable directory view. Stores the filter definition, never a frozen id list. */
export interface ContactSegment {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly filters: DirectoryFilters;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What one CSV import did, kept so an imported contact can say where it came from. */
export interface ContactImport {
  readonly id: string;
  readonly organizationId: string;
  readonly filename: string;
  readonly rowCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly importedAt: string;
  readonly importedBy: string;
}

export interface DuplicateGroup {
  readonly reason: "name-company" | "name";
  readonly key: string;
  readonly contactIds: readonly string[];
  /** The oldest record in the group: merging into it keeps the longest history in place. */
  readonly suggestedPrimaryId: string;
}

/**
 * The directory's identity rule, applied before storage rather than at read time, so the
 * partial unique index on `(organization_id, email)` is what actually enforces "one row per
 * person" and a case-varied re-import cannot slip past it.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Collapses inner whitespace as well as case: only duplicate detection wants this much. */
const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Exactly `lower(trim(…))`, which is what the D1 adapter's WHERE clause applies. Filters must
 * compare the same way in both repositories, or the memory-backed tests would describe matching
 * behaviour the deployed query does not have.
 */
const foldForFilter = (value: string) => value.trim().toLowerCase();

/**
 * Near-duplicate candidates, strongest signal first.
 *
 * Deliberately *near*: an exact address collision is impossible among live contacts, because the
 * partial unique index on `(organization_id, email)` refuses the second one and the import path
 * updates rather than inserting. What is left is the case that actually happens — the same
 * person entered twice under a work address and a personal one — so both rules key on the name,
 * with the company as the stronger corroborating signal and a bare name match reported only when
 * neither record carries one (otherwise every "Chris Taylor" in a large directory would be
 * offered as a merge).
 *
 * Merged-away records are never candidates: they have already been resolved, and offering them
 * again would let a second merge undo the first.
 */
export function findDuplicateGroups(
  contacts: readonly OrganizationContact[],
): readonly DuplicateGroup[] {
  const live = contacts.filter(({ mergedIntoId }) => !mergedIntoId);
  const oldestFirst = (left: OrganizationContact, right: OrganizationContact) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt);
  const groups: DuplicateGroup[] = [];
  const claimed = new Set<string>();
  const collect = (reason: DuplicateGroup["reason"], keyOf: (c: OrganizationContact) => string) => {
    const buckets = new Map<string, OrganizationContact[]>();
    for (const contact of live) {
      const key = keyOf(contact);
      if (!key) continue;
      buckets.set(key, [...(buckets.get(key) ?? []), contact]);
    }
    for (const [key, bucket] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
      const members = bucket.filter(({ id }) => !claimed.has(id)).sort(oldestFirst);
      if (members.length < 2) continue;
      for (const member of members) claimed.add(member.id);
      groups.push({
        reason,
        key,
        contactIds: members.map(({ id }) => id),
        // `sort` above put the oldest first, and a group always has one.
        suggestedPrimaryId: members[0]?.id ?? "",
      });
    }
  };
  collect("name-company", (contact) =>
    contact.company ? `${normalizeText(contact.name)}@${normalizeText(contact.company)}` : "",
  );
  collect("name", (contact) => (contact.company ? "" : normalizeText(contact.name)));
  return groups;
}

/** Does this contact satisfy every supplied criterion? Shared by the memory repository. */
export function matchesFilters(contact: OrganizationContact, filters: DirectoryFilters): boolean {
  if (contact.mergedIntoId) return false;
  const search = filters.search?.trim().toLowerCase();
  if (
    search &&
    ![contact.name, contact.email, contact.company ?? "", ...contact.aliases.map((a) => a.email)]
      .join(" ")
      .toLowerCase()
      .includes(search)
  )
    return false;
  if (filters.company && foldForFilter(contact.company ?? "") !== foldForFilter(filters.company))
    return false;
  if (filters.title && foldForFilter(contact.title ?? "") !== foldForFilter(filters.title))
    return false;
  if (filters.tags?.length && !filters.tags.every((tag) => contact.tags.includes(tag)))
    return false;
  if (filters.fieldKey) {
    const field = contact.fields.find(({ key }) => key === filters.fieldKey);
    if (!field) return false;
    if (filters.fieldValue !== undefined && field.value !== filters.fieldValue) return false;
  }
  if (filters.eventId && !contact.events.some(({ eventId }) => eventId === filters.eventId))
    return false;
  return true;
}
