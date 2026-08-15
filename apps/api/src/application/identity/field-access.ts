/**
 * Per-field View/Lock/Hide access, decided once and read by every surface that projects a field.
 *
 * A custom event role narrows what its holder may see and change *within* a capability they
 * hold. `content:read` says the AV coordinator may open the sessions board; this says the
 * speaker's phone number is not on it. The two are separate questions and both have to be asked:
 * a capability check alone would hand somebody the whole record, and a field policy alone would
 * hand somebody a record they had no business opening.
 *
 * **The decision is carried on the actor, not fetched per surface.** `EventAccess.fieldPolicies`
 * is resolved in the same D1 read that resolves the actor's roles, so a projection asks a pure
 * function rather than a repository. Three things follow, and each is a property the issue
 * asks for rather than a convenience:
 *
 * - It takes effect on the next authorized read without session recreation, because
 *   `resolveUserSession` re-derives the actor from D1 on every request
 *   (`docs/architecture/authorization.md`). There is no cached projection of a prior policy to
 *   leak, because there is no cache.
 * - A delegated machine identity inherits it. `ApiClientResolver` spreads its creator's
 *   `EventAccess` and narrows only the capability set, so an API client cannot be a way around a
 *   field policy its creator is under.
 * - An export and the screen it mirrors reach the same answer by construction, because both call
 *   this. CSV and XLSX are exactly where a per-field Hide gets bypassed — the screen hides the
 *   column and the download writes it — so `redact` is what a report row is built from rather
 *   than something applied to it afterwards.
 *
 * **Composition is least-restrictive, deliberately.** An actor may hold several grants on one
 * event, and capabilities already compose by union (`hasEventRoleCapability`). A field policy
 * stricter than the union would refuse a read the actor's own capability permits — an organizer
 * who is also given an AV role would stop seeing contact details on the board they administer.
 * So a built-in role contributes `view` for every field, and a policy only bites when every
 * grant the actor holds on that event is a custom role that names it. This is why the admin
 * recovery path in `CustomRoleService` is a property of the model rather than a special case:
 * an administrator holds `organizer` and therefore is under no policy at all.
 *
 * @spec PRD-IAM-002 ARC-AUTH-001
 */
import type { Actor } from "./actor";

/** The record kinds a field policy can be written against. */
export type FieldSubject = "session" | "speaker" | "contact";

export const FIELD_SUBJECTS: readonly FieldSubject[] = ["session", "speaker", "contact"];

/**
 * View sees it; Lock sees it and may not change it; Hide never receives it.
 *
 * Ordered by strictness, which is what `leastRestrictive` compares.
 */
export type FieldPolicy = "view" | "lock" | "hide";

const STRICTNESS: Record<FieldPolicy, number> = { view: 0, lock: 1, hide: 2 };

/**
 * The subject-wide default, addressed as a field name.
 *
 * A policy table that only ever named individual fields would silently expose the *next* field
 * somebody adds to a speaker profile, because an unnamed field has to default to something. This
 * makes that default part of the role: an AV role stores `contact:*` → `hide` and stays correct
 * when a column is added, and the safe templates below set it rather than enumerating today's
 * columns.
 */
export const SUBJECT_DEFAULT_FIELD = "*";

/**
 * Every field a policy may name, per subject.
 *
 * Closed on purpose. A role naming a field that does not exist is a role whose author believes
 * they hid something, so `CustomRoleService` refuses it at the boundary and migration `1005`
 * refuses it at the table. Adding a field here is the one edit that widens what a policy can
 * govern, and it sits next to the projections that read it.
 */
export const GOVERNED_FIELDS: Readonly<Record<FieldSubject, readonly string[]>> = {
  session: ["title", "abstract", "format", "tags", "tracks", "publicationState"],
  speaker: [
    "name",
    "email",
    "bio",
    "pronouns",
    "organization",
    "photoAssetId",
    "workflowStatus",
    "logistics",
    "customFields",
  ],
  contact: ["name", "email", "company", "title", "notes", "tags", "fields", "activities"],
};

/** Fields a policy may not hide, because the record is unusable — or unjoinable — without them. */
export const REQUIRED_FIELDS: Readonly<Record<FieldSubject, readonly string[]>> = {
  session: ["title"],
  speaker: ["name"],
  contact: ["name"],
};

export function isGovernedField(subject: FieldSubject, field: string): boolean {
  return field === SUBJECT_DEFAULT_FIELD || GOVERNED_FIELDS[subject].includes(field);
}

/** `subject:field`, the key `EventAccess.fieldPolicies` is written in. */
export function fieldPolicyKey(subject: FieldSubject, field: string): string {
  return `${subject}:${field}`;
}

/**
 * A record as a policy can leave it: `K` are the keys a Hide may remove, and nothing else moves.
 *
 * Stating the hideable keys rather than making the whole record `Partial` is what keeps the
 * ripple honest. A session's `id` cannot be hidden, so a caller should not have to test for its
 * absence; a session's `abstract` can be, so a caller must. The two governed-field unions below
 * are derived from `GOVERNED_FIELDS` minus `REQUIRED_FIELDS`, and the test in
 * `field-access.test.ts` asserts the three stay in step.
 */
export type Redacted<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Session fields a policy may hide. `title` is absent: it identifies the record. */
export type HideableSessionField = "abstract" | "format" | "tags" | "tracks" | "publicationState";

/** Speaker fields a policy may hide. `name` is absent, for the same reason. */
export type HideableSpeakerField =
  | "email"
  | "bio"
  | "pronouns"
  | "organization"
  | "photoAssetId"
  | "workflowStatus"
  | "logistics"
  | "customFields";

/** Contact fields a policy may hide. `name` is absent, for the same reason. */
export type HideableContactField =
  | "email"
  | "company"
  | "title"
  | "notes"
  | "tags"
  | "fields"
  | "activities";

/** A write naming a field the caller's role locks. A caller mistake, and never a 500. */
export class FieldLockedError extends Error {
  constructor(
    readonly subject: FieldSubject,
    readonly fields: readonly string[],
  ) {
    super(
      `This role cannot change ${fields.length === 1 ? "the field" : "the fields"} ${fields.join(", ")}`,
    );
  }
}

/**
 * One event's field decision for one actor.
 *
 * Constructed by `fieldAccessFor` and then asked, never re-derived: two surfaces asking the same
 * question of the same actor must not be able to disagree.
 */
export class FieldAccess {
  constructor(private readonly policies: ReadonlyMap<string, FieldPolicy>) {}

  /** Nothing is governed. Held by every built-in role, and by an actor under no custom role. */
  static readonly unrestricted = new FieldAccess(new Map());

  /** Does any policy here narrow anything? Surfaces use it to skip work, never to skip a check. */
  get restricted(): boolean {
    return this.policies.size > 0;
  }

  /** Immutable delegated-authority snapshot using the same composed decision as live reads. */
  snapshot(): readonly (readonly [string, FieldPolicy])[] {
    return [...this.policies.entries()].map(([key, policy]) => [key, policy] as const);
  }

  /**
   * The policy in force, with the subject-wide default applied and required fields clamped.
   *
   * The clamp is what makes `SUBJECT_DEFAULT_FIELD` safe. A role storing `speaker:*` → hide
   * means "everything about a speaker except what I named", and without this the name would go
   * too — producing an export of blank rows rather than a redacted one, and a report the reader
   * cannot join back to anything. Migration `1005` refuses an explicit hide on the same three
   * fields; this refuses the implicit one.
   */
  policyFor(subject: FieldSubject, field: string): FieldPolicy {
    const policy =
      this.policies.get(fieldPolicyKey(subject, field)) ??
      this.policies.get(fieldPolicyKey(subject, SUBJECT_DEFAULT_FIELD)) ??
      "view";
    if (policy === "hide" && REQUIRED_FIELDS[subject].includes(field)) return "lock";
    return policy;
  }

  canView(subject: FieldSubject, field: string): boolean {
    return this.policyFor(subject, field) !== "hide";
  }

  canEdit(subject: FieldSubject, field: string): boolean {
    return this.policyFor(subject, field) === "view";
  }

  /** Fields of `subject` this actor never receives, in declaration order. */
  hiddenFields(subject: FieldSubject): readonly string[] {
    return GOVERNED_FIELDS[subject].filter((field) => !this.canView(subject, field));
  }

  /** Fields of `subject` this actor sees and may not change, in declaration order. */
  lockedFields(subject: FieldSubject): readonly string[] {
    return GOVERNED_FIELDS[subject].filter((field) => this.policyFor(subject, field) === "lock");
  }

  /**
   * The record with every hidden field removed.
   *
   * Removed rather than blanked. An empty string is a value, and a caller cannot tell it from a
   * speaker who genuinely has no organization — which is how a redacted export ends up looking
   * like a complete one. A field the policy does not govern is untouched: this narrows a record,
   * it does not define one.
   */
  redact<T extends object, K extends keyof T = never>(
    subject: FieldSubject,
    record: T,
  ): Redacted<T, K> {
    if (!this.restricted) return record as Redacted<T, K>;
    const hidden = new Set(this.hiddenFields(subject));
    if (hidden.size === 0) return record as Redacted<T, K>;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (!hidden.has(key)) kept[key] = value;
    return kept as Redacted<T, K>;
  }

  redactAll<T extends object, K extends keyof T = never>(
    subject: FieldSubject,
    records: readonly T[],
  ): Redacted<T, K>[] {
    return records.map((record) => this.redact<T, K>(subject, record));
  }

  /**
   * Refuse a command that names a field this actor may not change.
   *
   * Called with the keys the command actually carries, so a form that submits every field is not
   * refused for the ones it left alone. Hidden counts as unchangeable too: a caller who cannot
   * read a field certainly cannot be allowed to write one, and treating Hide as merely
   * unreadable is how a hidden field gets overwritten with a blank.
   */
  assertEditable(subject: FieldSubject, fields: Iterable<string>): void {
    const refused = [...fields].filter(
      (field) => isGovernedField(subject, field) && !this.canEdit(subject, field),
    );
    if (refused.length > 0) throw new FieldLockedError(subject, refused);
  }
}

/**
 * This actor's field decision on this event.
 *
 * Built-in grants short-circuit to unrestricted, which is the least-restrictive rule stated as
 * code: one `organizer` grant makes every custom role the same actor holds irrelevant to what
 * they may see.
 */
export function fieldAccessFor(actor: Actor | null, eventId: string): FieldAccess {
  if (!actor) return FieldAccess.unrestricted;
  const grants = actor.eventAccess.filter((access) => access.eventId === eventId);
  if (grants.length === 0) return FieldAccess.unrestricted;
  if (grants.some((access) => !access.fieldPolicies)) return FieldAccess.unrestricted;
  const merged = new Map<string, FieldPolicy>();
  for (const access of grants)
    for (const [key, policy] of access.fieldPolicies ?? []) {
      const existing = merged.get(key);
      if (!existing || STRICTNESS[policy] < STRICTNESS[existing]) merged.set(key, policy);
    }
  return new FieldAccess(merged);
}

/**
 * This actor's field decision across several events at once.
 *
 * The CRM's contact directory is organization-scoped while a role is event-scoped, so "what may
 * this person see in this organization" has to be answered over every event of it they hold a
 * grant on. Least-restrictive again, and for the same reason: an organizer of one event and an
 * AV coordinator on another is an organizer of the organization's directory, because that is
 * what their capabilities already say.
 *
 * An empty list is unrestricted rather than fully hidden. The caller has already been authorized
 * — `CrmService.requireOrganization` refuses anybody with no qualifying grant before this is
 * reached — so an empty list here means "no event-scoped policy applies", not "no access".
 */
export function fieldAccessAcross(actor: Actor | null, eventIds: readonly string[]): FieldAccess {
  if (!actor || eventIds.length === 0) return FieldAccess.unrestricted;
  const perEvent = eventIds.map((eventId) => fieldAccessFor(actor, eventId));
  if (perEvent.some((access) => !access.restricted)) return FieldAccess.unrestricted;
  const merged = new Map<string, FieldPolicy>();
  for (const subject of FIELD_SUBJECTS)
    for (const field of [SUBJECT_DEFAULT_FIELD, ...GOVERNED_FIELDS[subject]]) {
      let weakest: FieldPolicy = "hide";
      for (const access of perEvent) {
        const policy = access.policyFor(subject, field);
        if (STRICTNESS[policy] < STRICTNESS[weakest]) weakest = policy;
      }
      if (weakest !== "view") merged.set(fieldPolicyKey(subject, field), weakest);
    }
  return new FieldAccess(merged);
}

/**
 * The templates a custom role may be created from.
 *
 * A role is created *from a template* rather than from nothing, because an empty role is the one
 * an administrator fills in by guessing which capabilities are safe together. Each template is a
 * starting point the creator then narrows; `CustomRoleService` re-checks every capability
 * against `GRANTABLE_CAPABILITIES` regardless, so a template is a convenience and never the
 * authorization.
 *
 * None of them carries `identity:manage`. A custom role that could administer roles could grant
 * itself the capabilities this allowlist withholds, which would make the allowlist decorative.
 */
export interface CustomRoleTemplate {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly fieldPolicies: readonly {
    readonly subject: FieldSubject;
    readonly field: string;
    readonly policy: FieldPolicy;
  }[];
}

export const CUSTOM_ROLE_TEMPLATES: readonly CustomRoleTemplate[] = [
  {
    key: "av",
    label: "AV and production",
    description:
      "Reads the running order and session material. Speaker and contact details stay hidden.",
    capabilities: ["events:read", "content:read"],
    fieldPolicies: [
      { subject: "speaker", field: SUBJECT_DEFAULT_FIELD, policy: "hide" },
      { subject: "speaker", field: "name", policy: "lock" },
      { subject: "speaker", field: "organization", policy: "lock" },
      { subject: "contact", field: SUBJECT_DEFAULT_FIELD, policy: "hide" },
      { subject: "session", field: SUBJECT_DEFAULT_FIELD, policy: "lock" },
    ],
  },
  {
    key: "programme-assistant",
    label: "Programme assistant",
    description:
      "Edits session copy and tracks. Speaker contact details are visible but not editable.",
    capabilities: ["events:read", "content:read", "content:manage"],
    fieldPolicies: [
      { subject: "speaker", field: "email", policy: "lock" },
      { subject: "speaker", field: "logistics", policy: "hide" },
      { subject: "contact", field: SUBJECT_DEFAULT_FIELD, policy: "hide" },
    ],
  },
  {
    key: "sponsor-liaison",
    label: "Sponsor liaison",
    description: "Works the contact directory. Speaker logistics and session drafts stay hidden.",
    capabilities: ["events:read", "crm:manage"],
    fieldPolicies: [
      { subject: "speaker", field: SUBJECT_DEFAULT_FIELD, policy: "hide" },
      { subject: "contact", field: "notes", policy: "lock" },
      { subject: "session", field: "abstract", policy: "hide" },
    ],
  },
];

/**
 * The capabilities a custom role may be granted, and the reason the set is written here.
 *
 * `identity:manage` is absent so a custom role cannot administer roles — including its own — and
 * `events:create` is absent because it is organization-wide and this is an event-scoped grant.
 * `events:settings:update` is absent because an event's public settings are what a site publish
 * serves; a role that could change them could publish copy nobody with `identity:manage`
 * approved. Everything else a built-in role earns is available to be narrowed.
 */
export const GRANTABLE_CAPABILITIES: readonly string[] = [
  "events:read",
  "events:settings:read",
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
  "review:evaluate",
  /**
   * Present, and off in every template.
   *
   * An organization that wants a sponsor liaison who can export unmasked addresses should be able
   * to say so; what it must not be is implied by any other capability. Reports mask by default,
   * so a role without this one still reads every report — with the personal columns masked.
   */
  "reports:pii",
];
