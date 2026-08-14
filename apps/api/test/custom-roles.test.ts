// @acceptance ACC-IDENTITY-EVENTS
/**
 * Composing a custom role, and the five refusals that keep the model from being talked out of.
 *
 * The positives are cheap; the refusals are the point. Each test below constructs the exact
 * attempt that would defeat the model if it were not refused — a role granting itself
 * `identity:manage`, a policy naming a field nobody governs, a stale edit interleaving into a
 * policy set neither editor chose, a demo persona reaching across into the real population, and a
 * preview that quietly answers with the administrator's own access.
 */
import { describe, expect, it, vi } from "vitest";
import type { Actor, Capability } from "../src/application/identity/actor";
import { CapabilityDeniedError } from "../src/application/identity/actor";
import {
  type CustomRole,
  CustomRoleConflictError,
  CustomRoleInvalidError,
  CustomRoleNotFoundError,
  CustomRoleRefusedError,
  type CustomRoleRepository,
  CustomRoleService,
} from "../src/application/identity/custom-roles";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a0";
const EVENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-0000000000b0";
const USER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const NOW = 1_700_000_000_000;

const context = { correlationId: "c", actorUserId: USER, source: "human" as const };

const administrator: Actor = {
  id: USER,
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "identity:manage"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "identity:manage"]),
};

const draft = {
  name: "AV coordinator",
  description: "Runs the room",
  template: "av",
  capabilities: ["content:read", "events:read"],
  fieldPolicies: [
    { subject: "speaker" as const, field: "*", policy: "hide" as const },
    { subject: "session" as const, field: "abstract", policy: "lock" as const },
  ],
};

function service(over: { stored?: CustomRole | null; updated?: number; member?: boolean } = {}) {
  const roles = new Map<string, CustomRole>();
  if (over.stored) roles.set(over.stored.id, over.stored);
  const repository = {
    list: vi.fn(async () => [...roles.values()]),
    find: vi.fn(async (_eventId: string, roleId: string) => roles.get(roleId) ?? null),
    create: vi.fn(async (role: CustomRole) => {
      roles.set(role.id, role);
    }),
    update: vi.fn(async (role: CustomRole, expected: number) => {
      if (over.updated !== undefined) return over.updated;
      const held = roles.get(role.id);
      if (!held || held.revision !== expected) return 0;
      roles.set(role.id, role);
      return 1;
    }),
    remove: vi.fn(async (_eventId: string, roleId: string, expected: number) => {
      const held = roles.get(roleId);
      if (!held || held.revision !== expected) return 0;
      roles.delete(roleId);
      return 1;
    }),
    assign: vi.fn(async () => 1),
    unassign: vi.fn(async () => 1),
    listAssignments: vi.fn(async () => []),
    isMember: vi.fn(async () => over.member ?? true),
  } satisfies CustomRoleRepository;
  return {
    repository,
    roles,
    service: new CustomRoleService({
      repository,
      events: {
        belongsToOrganization: async (_eventId, organizationId) => organizationId === ORGANIZATION,
        listEventIdsInOrganization: async (organizationId, candidates) =>
          organizationId === ORGANIZATION ? [...candidates] : [],
      },
      newId: () => "33333333-3333-4333-8333-333333333333",
      now: () => NOW,
    }),
  };
}

const storedRole = (over: Partial<CustomRole> = {}): CustomRole => ({
  id: "44444444-4444-4444-8444-444444444444",
  eventId: EVENT,
  organizationId: ORGANIZATION,
  name: "AV coordinator",
  description: "",
  template: "av",
  capabilities: ["content:read"],
  fieldPolicies: [{ subject: "speaker", field: "*", policy: "hide" }],
  createdBy: USER,
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
  ...over,
});

describe("composing a custom role", () => {
  it("stores a validated role, dropping the policies that decide nothing", async () => {
    const { service: subject } = service();
    const role = await subject.create(administrator, ORGANIZATION, EVENT, draft, context);
    expect(role.capabilities).toEqual(["content:read", "events:read"]);
    // `view` is the absence of a policy; storing it would make two identical roles compare
    // unequal and fill the table with rows that change nothing.
    const withView = await service().service.create(
      administrator,
      ORGANIZATION,
      EVENT,
      { ...draft, fieldPolicies: [{ subject: "session", field: "format", policy: "view" }] },
      context,
    );
    expect(withView.fieldPolicies).toEqual([]);
  });

  it("refuses a capability outside the allowlist, however the template is written", async () => {
    const { service: subject } = service();
    await expect(
      subject.create(
        administrator,
        ORGANIZATION,
        EVENT,
        { ...draft, capabilities: ["content:read", "identity:manage"] },
        context,
      ),
    ).rejects.toThrow(CustomRoleInvalidError);
  });

  it("refuses a policy naming a field nobody governs, and one hiding an identifier", async () => {
    const { service: subject } = service();
    await expect(
      subject.create(
        administrator,
        ORGANIZATION,
        EVENT,
        {
          ...draft,
          fieldPolicies: [{ subject: "speaker", field: "salary", policy: "hide" }],
        },
        context,
      ),
    ).rejects.toThrow(CustomRoleInvalidError);
    await expect(
      subject.create(
        administrator,
        ORGANIZATION,
        EVENT,
        { ...draft, fieldPolicies: [{ subject: "speaker", field: "name", policy: "hide" }] },
        context,
      ),
    ).rejects.toThrow(CustomRoleInvalidError);
  });

  it("refuses an administrator of another organization, and an event outside this one", async () => {
    const { service: subject } = service();
    await expect(subject.list(administrator, OTHER_ORGANIZATION, EVENT)).rejects.toThrow(
      CapabilityDeniedError,
    );
    const elsewhere: Actor = {
      ...administrator,
      organizations: [{ id: OTHER_ORGANIZATION }],
    };
    await expect(subject.list(elsewhere, OTHER_ORGANIZATION, EVENT)).rejects.toThrow(
      CapabilityDeniedError,
    );
  });

  it("refuses a demo persona as actor and as subject, while letting it read", async () => {
    const { service: subject } = service();
    const persona: Actor = { ...administrator, id: "seed-organizer" };
    await expect(subject.create(persona, ORGANIZATION, EVENT, draft, context)).rejects.toThrow(
      CustomRoleRefusedError,
    );
    // Reading is not a write: the screen is a real console surface a persona can open.
    await expect(subject.list(persona, ORGANIZATION, EVENT)).resolves.toBeTruthy();
  });
});

describe("editing and granting a custom role", () => {
  it("refuses a stale edit rather than interleaving it", async () => {
    const stored = storedRole({ revision: 3 });
    const { service: subject } = service({ stored });
    await expect(
      subject.update(
        administrator,
        ORGANIZATION,
        EVENT,
        stored.id,
        { ...draft, expectedRevision: 2 },
        context,
      ),
    ).rejects.toThrow(CustomRoleConflictError);
    const applied = await subject.update(
      administrator,
      ORGANIZATION,
      EVENT,
      stored.id,
      { ...draft, expectedRevision: 3 },
      context,
    );
    expect(applied.revision).toBe(4);
  });

  it("refuses an edit the storage layer says lost the race, even after a clean read", async () => {
    // The read above and the write are two round trips, and a writer can arrive between them.
    // The repository puts the expected revision in its own WHERE; this asserts the service
    // believes the count rather than the read.
    const stored = storedRole({ revision: 1 });
    const { service: subject } = service({ stored, updated: 0 });
    await expect(
      subject.update(
        administrator,
        ORGANIZATION,
        EVENT,
        stored.id,
        { ...draft, expectedRevision: 1 },
        context,
      ),
    ).rejects.toThrow(CustomRoleConflictError);
  });

  it("refuses to staff a stranger, and refuses a persona as the subject", async () => {
    const stored = storedRole();
    const { service: subject } = service({ stored, member: false });
    await expect(
      subject.assign(administrator, ORGANIZATION, EVENT, stored.id, MEMBER, context),
    ).rejects.toThrow(CustomRoleRefusedError);
    const { service: staffed } = service({ stored });
    await expect(
      staffed.assign(administrator, ORGANIZATION, EVENT, stored.id, "seed-speaker", context),
    ).rejects.toThrow(CustomRoleRefusedError);
    await expect(
      staffed.assign(administrator, ORGANIZATION, EVENT, stored.id, MEMBER, context),
    ).resolves.toBeUndefined();
  });

  it("reports a role that is not on this event as absent", async () => {
    const { service: subject } = service();
    await expect(
      subject.assign(administrator, ORGANIZATION, EVENT, "no-such-role", MEMBER, context),
    ).rejects.toThrow(CustomRoleNotFoundError);
  });
});

describe("previewing a role", () => {
  it("answers from the stored role, resolving the subject default over every field", async () => {
    const stored = storedRole({
      fieldPolicies: [
        { subject: "speaker", field: "*", policy: "hide" },
        { subject: "speaker", field: "organization", policy: "lock" },
      ],
    });
    const { service: subject, repository } = service({ stored });
    const preview = await subject.previewAs(administrator, ORGANIZATION, EVENT, stored.id);
    expect(preview.capabilities).toEqual(["content:read"]);
    const policyOf = (field: string) =>
      preview.fields.find((entry) => entry.subject === "speaker" && entry.field === field)?.policy;
    expect(policyOf("bio")).toBe("hide");
    expect(policyOf("organization")).toBe("lock");
    // The identifier is clamped rather than hidden, even under a subject-wide default.
    expect(policyOf("name")).toBe("lock");
    // A field nothing narrows in another subject is plainly viewable.
    expect(
      preview.fields.find((entry) => entry.subject === "session" && entry.field === "title")
        ?.policy,
    ).toBe("view");
    // Nothing was read on the role's behalf: preview inspects, it does not impersonate.
    expect(repository.listAssignments).not.toHaveBeenCalled();
  });
});
