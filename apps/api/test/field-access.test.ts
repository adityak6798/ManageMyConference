// @acceptance ACC-IDENTITY-EVENTS
/**
 * The per-field decision, and the three ways a policy could be talked out of holding.
 *
 * These are properties rather than examples: composition across grants, the subject-wide default,
 * and the required-field clamp are each asserted by constructing the case that would break them.
 */
import { describe, expect, it } from "vitest";
import type { Actor, Capability } from "../src/application/identity/actor";
import {
  CUSTOM_ROLE_TEMPLATES,
  FIELD_SUBJECTS,
  fieldAccessAcross,
  fieldAccessFor,
  FieldLockedError,
  GOVERNED_FIELDS,
  GRANTABLE_CAPABILITIES,
  isGovernedField,
  REQUIRED_FIELDS,
} from "../src/application/identity/field-access";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "22222222-2222-4222-8222-222222222222";

const policies = (entries: readonly [string, "view" | "lock" | "hide"][]) => new Map(entries);

const actorOf = (
  grants: readonly {
    eventId: string;
    role: Actor["eventAccess"][number]["role"];
    capabilities?: readonly Capability[];
    fieldPolicies?: Map<string, "view" | "lock" | "hide">;
  }[],
): Actor => ({
  id: "user-1",
  name: "Ada",
  persona: "organizer",
  organizations: [{ id: "org-1" }],
  eventAccess: grants.map((grant) => ({
    eventId: grant.eventId,
    role: grant.role,
    capabilities: new Set(grant.capabilities ?? ["events:read"]),
    ...(grant.fieldPolicies ? { fieldPolicies: grant.fieldPolicies } : {}),
  })),
  capabilities: new Set<Capability>(["events:read"]),
});

describe("per-field access", () => {
  it("governs nothing for a built-in role, and everything named for a custom one", () => {
    const builtIn = fieldAccessFor(actorOf([{ eventId: EVENT, role: "organizer" }]), EVENT);
    expect(builtIn.restricted).toBe(false);
    expect(builtIn.canView("speaker", "email")).toBe(true);

    const custom = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([
            ["speaker:email", "hide"],
            ["session:abstract", "lock"],
          ]),
        },
      ]),
      EVENT,
    );
    expect(custom.canView("speaker", "email")).toBe(false);
    expect(custom.canView("session", "abstract")).toBe(true);
    expect(custom.canEdit("session", "abstract")).toBe(false);
    expect(custom.canEdit("session", "format")).toBe(true);
  });

  it("takes the least restrictive policy across an actor's grants on one event", () => {
    // The escalation this rules out is the *opposite* of the usual one: an organizer who is also
    // given an AV role must keep seeing the board they administer, because their capabilities
    // already say they may. A stricter composition would refuse a read the capability permits.
    const both = fieldAccessFor(
      actorOf([
        { eventId: EVENT, role: "organizer" },
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([["speaker:email", "hide"]]),
        },
      ]),
      EVENT,
    );
    expect(both.restricted).toBe(false);

    const twoCustom = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([["speaker:email", "hide"]]),
        },
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([["speaker:email", "lock"]]),
        },
      ]),
      EVENT,
    );
    expect(twoCustom.policyFor("speaker", "email")).toBe("lock");
  });

  it("reads a policy on another event as no policy at all", () => {
    const access = fieldAccessFor(
      actorOf([
        {
          eventId: OTHER_EVENT,
          role: "custom",
          fieldPolicies: policies([["speaker:email", "hide"]]),
        },
      ]),
      EVENT,
    );
    expect(access.canView("speaker", "email")).toBe(true);
  });

  it("applies the subject default to a field no policy names", () => {
    const access = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([
            ["speaker:*", "hide"],
            ["speaker:organization", "lock"],
          ]),
        },
      ]),
      EVENT,
    );
    expect(access.canView("speaker", "bio")).toBe(false);
    expect(access.canView("speaker", "pronouns")).toBe(false);
    expect(access.policyFor("speaker", "organization")).toBe("lock");
  });

  it("never hides the field that identifies a record, even under a subject default", () => {
    const access = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([
            ["speaker:*", "hide"],
            ["session:*", "hide"],
            ["contact:*", "hide"],
          ]),
        },
      ]),
      EVENT,
    );
    for (const subject of FIELD_SUBJECTS)
      for (const field of REQUIRED_FIELDS[subject]) {
        expect(access.policyFor(subject, field)).toBe("lock");
        expect(access.canView(subject, field)).toBe(true);
      }
  });

  it("removes a hidden field rather than blanking it", () => {
    const access = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([["speaker:email", "hide"]]),
        },
      ]),
      EVENT,
    );
    const redacted = access.redact("speaker", {
      id: "s1",
      name: "Ada",
      email: "ada@example.test",
      organization: "Difference Engines",
    });
    // `in`, not a truthiness test: "" would pass a truthiness test and is exactly the value a
    // blanking implementation would leave behind.
    expect("email" in redacted).toBe(false);
    expect(redacted).toEqual({ id: "s1", name: "Ada", organization: "Difference Engines" });
  });

  it("refuses a write naming a locked or hidden field, and passes one that names neither", () => {
    const access = fieldAccessFor(
      actorOf([
        {
          eventId: EVENT,
          role: "custom",
          fieldPolicies: policies([
            ["session:abstract", "lock"],
            ["session:tracks", "hide"],
          ]),
        },
      ]),
      EVENT,
    );
    expect(() => access.assertEditable("session", ["format"])).not.toThrow();
    expect(() => access.assertEditable("session", ["abstract"])).toThrow(FieldLockedError);
    // Hidden counts as unchangeable: a caller who cannot read a field must not overwrite it.
    expect(() => access.assertEditable("session", ["tracks"])).toThrow(FieldLockedError);
    // A key the policy does not govern is not this decision's business.
    expect(() => access.assertEditable("session", ["speakerProfileIds"])).not.toThrow();
  });

  it("answers an organization-wide question over every event the actor holds a grant on", () => {
    const actor = actorOf([
      {
        eventId: EVENT,
        role: "custom",
        fieldPolicies: policies([["contact:notes", "hide"]]),
      },
      {
        eventId: OTHER_EVENT,
        role: "custom",
        fieldPolicies: policies([["contact:notes", "lock"]]),
      },
    ]);
    expect(fieldAccessAcross(actor, [EVENT, OTHER_EVENT]).policyFor("contact", "notes")).toBe(
      "lock",
    );
    // One built-in grant anywhere in the organization makes the directory unrestricted, because
    // that grant's capabilities already permit the read.
    const mixed = actorOf([
      {
        eventId: EVENT,
        role: "custom",
        fieldPolicies: policies([["contact:notes", "hide"]]),
      },
      { eventId: OTHER_EVENT, role: "organizer" },
    ]);
    expect(fieldAccessAcross(mixed, [EVENT, OTHER_EVENT]).restricted).toBe(false);
  });
});

describe("the vocabulary a role may be composed from", () => {
  it("never offers identity:manage, which would let a role widen itself", () => {
    expect(GRANTABLE_CAPABILITIES).not.toContain("identity:manage");
    expect(GRANTABLE_CAPABILITIES).not.toContain("events:create");
    expect(GRANTABLE_CAPABILITIES).not.toContain("events:settings:update");
  });

  it("keeps every template inside the allowlist and the field catalogue", () => {
    for (const template of CUSTOM_ROLE_TEMPLATES) {
      for (const capability of template.capabilities)
        expect(GRANTABLE_CAPABILITIES).toContain(capability);
      for (const entry of template.fieldPolicies) {
        expect(isGovernedField(entry.subject, entry.field)).toBe(true);
        if (entry.policy === "hide")
          expect(REQUIRED_FIELDS[entry.subject]).not.toContain(entry.field);
      }
    }
  });

  it("keeps the required fields a subset of the governed ones", () => {
    for (const subject of FIELD_SUBJECTS)
      for (const field of REQUIRED_FIELDS[subject])
        expect(GOVERNED_FIELDS[subject]).toContain(field);
  });
});
