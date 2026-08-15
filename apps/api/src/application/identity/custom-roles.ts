/**
 * Composing an event role, and deciding what its holder may see field by field.
 *
 * Issue #196's first area, and the one it calls load-bearing and dangerous. This service writes
 * an authorization surface, so everything it refuses is refused *here* rather than in a route:
 * a service is not entitled to assume its transport, and the same commands reach it from the
 * console, from an API client, and from a test.
 *
 * Five refusals, each of which is a way the model could otherwise be talked out of:
 *
 * 1. **The allowlist is re-checked on every write**, never taken from the template. A template is
 *    a starting point somebody narrows; treating its capability list as authorization would mean
 *    a widened template silently widening every role created from it.
 * 2. **`identity:manage` cannot be granted.** It is absent from `GRANTABLE_CAPABILITIES` and from
 *    the table's `CHECK`, because a custom role that could administer roles could grant itself
 *    everything the allowlist withholds.
 * 3. **A policy may only name a governed field.** A role naming a field that does not exist is a
 *    role whose author believes they hid something.
 * 4. **A demo persona is never a subject.** Rule 2 of the three that keep the demo population and
 *    the real one apart (`docs/architecture/authorization.md`) applies to a custom grant exactly
 *    as it applies to a built-in one — a persona holds the seeded organizer's capabilities, so
 *    anything it wrote would be real state handed to whoever presses **Continue as organizer**.
 * 5. **Every write is audited in the same batch as the change**, which is this domain's rule:
 *    an audit row cannot claim something that did not happen, and a change cannot happen
 *    unaudited.
 *
 * **Preview-as-role does not impersonate.** `previewAs` answers what a role *would* be able to
 * see — the capability set and the resolved field decision — and reads nothing on that role's
 * behalf. An implementation that fetched the sessions board "as" the AV role would be a
 * privilege-granting operation wearing a preview's name: it would run under the administrator's
 * own grants, so a bug in the narrowing would show the administrator's data and call it the
 * role's.
 *
 * @spec PRD-IAM-002 ARC-AUTH-001
 */
import type { Actor } from "./actor";
import type { AuditContext } from "./audit";
import { isDemoPersonaId } from "./demo-session";
import {
  CUSTOM_ROLE_TEMPLATES,
  type CustomRoleTemplate,
  FIELD_SUBJECTS,
  type FieldPolicy,
  type FieldSubject,
  FieldAccess,
  fieldPolicyKey,
  GRANTABLE_CAPABILITIES,
  GOVERNED_FIELDS,
  isGovernedField,
  REQUIRED_FIELDS,
  SUBJECT_DEFAULT_FIELD,
} from "./field-access";
import {
  type OrganizationEventDirectory,
  requireOrganizationAdministration,
} from "./organization-administration";

export interface CustomRoleFieldPolicy {
  readonly subject: FieldSubject;
  readonly field: string;
  readonly policy: FieldPolicy;
}

export interface CustomRole {
  readonly id: string;
  readonly eventId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string;
  readonly template: string;
  readonly capabilities: readonly string[];
  readonly fieldPolicies: readonly CustomRoleFieldPolicy[];
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

/** A role and the people holding it, for the inspection screen. */
export interface CustomRoleAssignment {
  readonly roleId: string;
  readonly userId: string;
  readonly userName: string;
}

export class CustomRoleInvalidError extends Error {}
export class CustomRoleNotFoundError extends Error {}
export class CustomRoleConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("This role changed while you were editing it. Reload and reapply your changes.");
  }
}
export class CustomRoleNameTakenError extends Error {
  constructor() {
    super("A role with that name already exists on this event.");
  }
}
export class CustomRoleRefusedError extends Error {}

export interface CustomRoleRepository {
  list(eventId: string): Promise<readonly CustomRole[]>;
  find(eventId: string, roleId: string): Promise<CustomRole | null>;
  /** Rejects a duplicate name with `CustomRoleNameTakenError`; the unique index is the arbiter. */
  create(role: CustomRole, context: AuditContext): Promise<void>;
  /**
   * Rewrite a role's name, description, capabilities and policies at `expectedRevision`.
   *
   * Answers the number of role rows changed: `0` means the revision moved, which the service
   * turns into a conflict rather than a silent no-op.
   */
  update(role: CustomRole, expectedRevision: number, context: AuditContext): Promise<number>;
  remove(
    eventId: string,
    roleId: string,
    expectedRevision: number,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number>;
  /** Grant the custom role to a member. Returns rows written; `0` when the role is gone. */
  assign(
    eventId: string,
    roleId: string,
    userId: string,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number>;
  unassign(
    eventId: string,
    roleId: string,
    userId: string,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number>;
  listAssignments(eventId: string): Promise<readonly CustomRoleAssignment[]>;
  isMember(organizationId: string, userId: string): Promise<boolean>;
  /**
   * What this event has closed on its own portal, and the write that replaces it.
   *
   * On this repository rather than a second one because it is administered from the same screen,
   * by the same people, in the same vocabulary — but it is a *different question* from a role's
   * policy, and `1007_event_field_locks.sql` says why: a role policy governs a staffed role, and
   * a lock governs the person whose record it is.
   */
  listFieldLocks(eventId: string): Promise<readonly CustomRoleFieldPolicy[]>;
  replaceFieldLocks(
    eventId: string,
    locks: readonly CustomRoleFieldPolicy[],
    updatedBy: string,
    updatedAt: number,
  ): Promise<void>;
}

export interface CustomRoleDependencies {
  repository: CustomRoleRepository;
  events: OrganizationEventDirectory & {
    belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
  };
  newId(): string;
  now(): number;
}

export interface CustomRoleDraft {
  readonly name: string;
  readonly description?: string | undefined;
  readonly template: string;
  readonly capabilities: readonly string[];
  readonly fieldPolicies: readonly CustomRoleFieldPolicy[];
}

/** The templates offered to a creator, as data rather than as a screen's hardcoded list. */
export function customRoleTemplates(): readonly CustomRoleTemplate[] {
  return CUSTOM_ROLE_TEMPLATES;
}

/**
 * The field catalogue a policy editor renders, with the fields it may not hide marked.
 *
 * Published so the console cannot drift from what the service will accept — a screen offering
 * Hide on a field the service refuses is a form that fails on submit for no visible reason.
 */
export function governedFieldCatalogue(): readonly {
  subject: FieldSubject;
  fields: readonly { field: string; required: boolean }[];
}[] {
  return FIELD_SUBJECTS.map((subject) => ({
    subject,
    fields: [
      { field: SUBJECT_DEFAULT_FIELD, required: false },
      ...GOVERNED_FIELDS[subject].map((field) => ({
        field,
        required: REQUIRED_FIELDS[subject].includes(field),
      })),
    ],
  }));
}

export class CustomRoleService {
  constructor(private readonly dependencies: CustomRoleDependencies) {}

  private async authorize(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
  ): Promise<Actor> {
    const authorized = await requireOrganizationAdministration(
      actor,
      organizationId,
      this.dependencies.events,
    );
    if (!(await this.dependencies.events.belongsToOrganization(eventId, organizationId)))
      throw new CustomRoleNotFoundError("That event is not part of this organization");
    return authorized;
  }

  /**
   * A persona may read this surface and may write nothing on it.
   *
   * The same asymmetry membership administration has, and for the same reason: the members screen
   * is a real console surface a persona can open, while every write behind it would leave real
   * state in the demo organization.
   */
  private refusePersona(actor: Actor): void {
    if (isDemoPersonaId(actor.id))
      throw new CustomRoleRefusedError("A demo persona cannot administer custom roles");
  }

  private validate(draft: CustomRoleDraft): {
    name: string;
    description: string;
    template: string;
    capabilities: readonly string[];
    fieldPolicies: readonly CustomRoleFieldPolicy[];
  } {
    const name = draft.name.trim();
    if (name.length < 1 || name.length > 80)
      throw new CustomRoleInvalidError("A role name is between 1 and 80 characters");
    const description = (draft.description ?? "").trim();
    if (description.length > 400)
      throw new CustomRoleInvalidError("A role description is at most 400 characters");
    if (!CUSTOM_ROLE_TEMPLATES.some((template) => template.key === draft.template))
      throw new CustomRoleInvalidError("A role is created from one of the offered templates");
    const capabilities = [...new Set(draft.capabilities)].sort();
    const ungrantable = capabilities.filter(
      (capability) => !GRANTABLE_CAPABILITIES.includes(capability),
    );
    if (ungrantable.length > 0)
      throw new CustomRoleInvalidError(`A custom role cannot be granted ${ungrantable.join(", ")}`);
    if (capabilities.length === 0)
      throw new CustomRoleInvalidError("A role grants at least one capability");
    const seen = new Set<string>();
    const fieldPolicies: CustomRoleFieldPolicy[] = [];
    for (const entry of draft.fieldPolicies) {
      if (!FIELD_SUBJECTS.includes(entry.subject))
        throw new CustomRoleInvalidError(`${entry.subject} is not a governed record kind`);
      if (!isGovernedField(entry.subject, entry.field))
        throw new CustomRoleInvalidError(
          `${entry.subject} has no field ${entry.field} for a policy to govern`,
        );
      if (entry.policy === "hide" && REQUIRED_FIELDS[entry.subject].includes(entry.field))
        throw new CustomRoleInvalidError(
          `${entry.subject}.${entry.field} identifies the record and cannot be hidden`,
        );
      const key = fieldPolicyKey(entry.subject, entry.field);
      // Last write wins rather than a refusal: a form that renders a row per field and submits
      // the lot can legitimately send one entry per field, and a duplicate is a client bug that
      // should not cost the administrator their edit.
      if (seen.has(key))
        fieldPolicies.splice(
          fieldPolicies.findIndex((held) => fieldPolicyKey(held.subject, held.field) === key),
          1,
        );
      seen.add(key);
      fieldPolicies.push({ subject: entry.subject, field: entry.field, policy: entry.policy });
    }
    // `view` is the absence of a policy, so storing it would make two identical roles compare
    // unequal and would fill the table with rows that decide nothing.
    return {
      name,
      description,
      template: draft.template,
      capabilities,
      fieldPolicies: fieldPolicies
        .filter((entry) => entry.policy !== "view")
        .sort((left, right) =>
          fieldPolicyKey(left.subject, left.field).localeCompare(
            fieldPolicyKey(right.subject, right.field),
          ),
        ),
    };
  }

  async list(actor: Actor | null, organizationId: string, eventId: string) {
    await this.authorize(actor, organizationId, eventId);
    const [roles, assignments, fieldLocks] = await Promise.all([
      this.dependencies.repository.list(eventId),
      this.dependencies.repository.listAssignments(eventId),
      this.dependencies.repository.listFieldLocks(eventId),
    ]);
    return {
      roles,
      assignments,
      // What the event has closed on its own portal, beside what each role sees. One screen,
      // because an organizer asking "can this person change their bio" should not have to know
      // which of the two mechanisms answered.
      fieldLocks,
      templates: customRoleTemplates(),
      catalogue: governedFieldCatalogue(),
      grantableCapabilities: GRANTABLE_CAPABILITIES,
    };
  }

  /**
   * Replace this event's portal field locks.
   *
   * Whole-set replacement rather than per-field toggles, so the stored locks are always exactly
   * what the organizer last saw and confirmed — a partial write is how a screen and a database
   * come to disagree about whether a field is open.
   *
   * `view` entries are dropped for the same reason a role's are: `view` is the absence of a
   * policy, and storing it would fill the table with rows that decide nothing.
   */
  async setFieldLocks(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    locks: readonly CustomRoleFieldPolicy[],
  ): Promise<readonly CustomRoleFieldPolicy[]> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    const seen = new Set<string>();
    const validated: CustomRoleFieldPolicy[] = [];
    for (const entry of locks) {
      if (!FIELD_SUBJECTS.includes(entry.subject))
        throw new CustomRoleInvalidError(`${entry.subject} is not a governed record kind`);
      if (!isGovernedField(entry.subject, entry.field))
        throw new CustomRoleInvalidError(
          `${entry.subject} has no field ${entry.field} for a lock to govern`,
        );
      if (entry.policy === "hide" && REQUIRED_FIELDS[entry.subject].includes(entry.field))
        throw new CustomRoleInvalidError(
          `${entry.subject}.${entry.field} identifies the record and cannot be hidden`,
        );
      const key = fieldPolicyKey(entry.subject, entry.field);
      if (seen.has(key) || entry.policy === "view") continue;
      seen.add(key);
      validated.push(entry);
    }
    await this.dependencies.repository.replaceFieldLocks(
      eventId,
      validated,
      authorized.id,
      this.dependencies.now(),
    );
    return validated;
  }

  async create(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    draft: CustomRoleDraft,
    context: AuditContext,
  ): Promise<CustomRole> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    const validated = this.validate(draft);
    const now = this.dependencies.now();
    const role: CustomRole = {
      id: this.dependencies.newId(),
      eventId,
      organizationId,
      ...validated,
      createdBy: authorized.id,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await this.dependencies.repository.create(role, context);
    return role;
  }

  async update(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    roleId: string,
    draft: CustomRoleDraft & { expectedRevision: number },
    context: AuditContext,
  ): Promise<CustomRole> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    const existing = await this.dependencies.repository.find(eventId, roleId);
    if (!existing) throw new CustomRoleNotFoundError("That role was not found");
    if (existing.revision !== draft.expectedRevision)
      throw new CustomRoleConflictError(existing.revision);
    const validated = this.validate(draft);
    const next: CustomRole = {
      ...existing,
      ...validated,
      updatedAt: this.dependencies.now(),
      revision: existing.revision + 1,
    };
    // The repository puts the expected revision in its own `WHERE`, so a writer that arrived
    // between the read above and this write loses rather than being read back as a success.
    if ((await this.dependencies.repository.update(next, draft.expectedRevision, context)) === 0)
      throw new CustomRoleConflictError(existing.revision);
    return next;
  }

  async remove(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    roleId: string,
    expectedRevision: number,
    context: AuditContext,
  ): Promise<void> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    // The grants go with it: `event_roles.custom_role_id` cascades, so nobody is left holding a
    // role that no longer says what it permits.
    const removed = await this.dependencies.repository.remove(
      eventId,
      roleId,
      expectedRevision,
      this.dependencies.now(),
      context,
    );
    if (removed === 0) {
      const existing = await this.dependencies.repository.find(eventId, roleId);
      if (!existing) throw new CustomRoleNotFoundError("That role was not found");
      throw new CustomRoleConflictError(existing.revision);
    }
  }

  async assign(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    roleId: string,
    userId: string,
    context: AuditContext,
  ): Promise<void> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    if (isDemoPersonaId(userId))
      throw new CustomRoleRefusedError("A demo persona cannot be granted a role");
    // A custom role staffs a member, exactly as a built-in event role does. Granting one to a
    // stranger would be an invitation by another name, without the acceptance step that makes
    // invitations safe.
    if (!(await this.dependencies.repository.isMember(organizationId, userId)))
      throw new CustomRoleRefusedError("That person is not a member of this organization");
    // The role has to exist before the grant is attempted, because the write answers `0` for both
    // "no such role" and "already holds it" — an idempotent regrant is the outcome the caller
    // wanted and must not be reported as a missing role.
    if (!(await this.dependencies.repository.find(eventId, roleId)))
      throw new CustomRoleNotFoundError("That role was not found");
    await this.dependencies.repository.assign(
      eventId,
      roleId,
      userId,
      this.dependencies.now(),
      context,
    );
  }

  async unassign(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    roleId: string,
    userId: string,
    context: AuditContext,
  ): Promise<number> {
    const authorized = await this.authorize(actor, organizationId, eventId);
    this.refusePersona(authorized);
    // No last-administrator guard: a custom role can never hold `identity:manage`, so taking one
    // away cannot leave an organization unadministrable. `MembershipService.revokeEventRole` is
    // where that guard belongs and is where it lives.
    return this.dependencies.repository.unassign(
      eventId,
      roleId,
      userId,
      this.dependencies.now(),
      context,
    );
  }

  /**
   * What this role would be able to do and see. Reads nothing on the role's behalf.
   *
   * The answer is derived from the stored role rather than from a session, so it cannot
   * accidentally report the administrator's own access: there is no actor in it at all.
   */
  async previewAs(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    roleId: string,
  ): Promise<{
    role: CustomRole;
    capabilities: readonly string[];
    fields: readonly { subject: FieldSubject; field: string; policy: FieldPolicy }[];
  }> {
    await this.authorize(actor, organizationId, eventId);
    const role = await this.dependencies.repository.find(eventId, roleId);
    if (!role) throw new CustomRoleNotFoundError("That role was not found");
    const access = new FieldAccess(
      new Map(
        role.fieldPolicies.map((entry) => [
          fieldPolicyKey(entry.subject, entry.field),
          entry.policy,
        ]),
      ),
    );
    return {
      role,
      capabilities: role.capabilities,
      fields: FIELD_SUBJECTS.flatMap((subject) =>
        GOVERNED_FIELDS[subject].map((field) => ({
          subject,
          field,
          policy: access.policyFor(subject, field),
        })),
      ),
    };
  }
}
