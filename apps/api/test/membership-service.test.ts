// @acceptance ACC-IDENTITY-EVENTS
/**
 * Membership administration: who may do it, and what it refuses.
 *
 * The authorization here is the three-condition organization pattern, and the third condition is
 * the one worth a test of its own — conditions 1 and 2 can be satisfied by two *different*
 * organizations at once, which is the mixed-role escalation. The CRM directory's own suite records
 * that this case cannot be driven from the seeded demo personas, because none of them belongs to
 * two organizations; the same is true here, so it is asserted at this level.
 */
import { describe, expect, it, vi } from "vitest";
import type { Actor, Capability } from "../src/application/identity/actor";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import type { MembershipRepository } from "../src/application/identity/membership";
import {
  EventOutsideOrganizationError,
  InvitationInvalidError,
  MembershipRefusedError,
  MembershipService,
  mintInvitationToken,
} from "../src/application/identity/membership";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";

const ORG_A = "00000000-0000-4000-8000-0000000000a0";
const ORG_B = "00000000-0000-4000-8000-0000000000b0";
const EVENT_A = "00000000-0000-4000-8000-0000000000a1";
const EVENT_B = "00000000-0000-4000-8000-0000000000b1";
const NOW = 1_760_000_000_000;

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: ORG_A }],
  eventAccess: [
    {
      eventId: EVENT_A,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "identity:manage"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "identity:manage"]),
  ...over,
});

const context = { correlationId: "c", actorUserId: null, source: "human" as const };

function service(
  over: { eventsInOrganization?: string[]; belongs?: boolean; member?: boolean } = {},
) {
  // Parameters are declared rather than inferred, because these mocks are *inspected*: a
  // `vi.fn(async () => …)` records calls typed as the empty tuple, and `calls[0][0]` then fails
  // to compile even though the call carried an argument.
  type Repository = MembershipRepository;
  const repository = {
    listMembers: vi.fn(async (_organizationId: string, _eventIds: readonly string[]) => []),
    listInvitations: vi.fn(async (_organizationId: string) => []),
    createInvitation: vi.fn(
      async (
        _invitation: Parameters<Repository["createInvitation"]>[0],
        _context: Parameters<Repository["createInvitation"]>[1],
      ) => undefined,
    ),
    revokeInvitation: vi.fn(async () => 1),
    acceptInvitation: vi.fn(async (_input: Parameters<Repository["acceptInvitation"]>[0]) => ({
      organizationId: ORG_A,
      eventId: null,
      role: "organizer" as const,
    })),
    removeMember: vi.fn(async () => 1),
    setEventRole: vi.fn(async () => 1),
    revokeEventRole: vi.fn(async () => 1),
    listAuditEvents: vi.fn(
      async (_organizationId: string, _limit: number, _before: number | null) => [],
    ),
    recordRefusal: vi.fn(
      async (
        _entry: Parameters<Repository["recordRefusal"]>[0],
        _context: Parameters<Repository["recordRefusal"]>[1],
      ) => undefined,
    ),
    isMember: vi.fn(async () => over.member ?? true),
  };
  return {
    repository,
    membership: new MembershipService({
      repository,
      events: {
        belongsToOrganization: async () => over.belongs ?? true,
        listEventIdsInOrganization: async (_organizationId, candidates) =>
          (over.eventsInOrganization ?? [EVENT_A]).filter((id) => candidates.includes(id)),
        listEventIdsForOrganization: async () => over.eventsInOrganization ?? [EVENT_A],
      },
      newId: () => "invitation-1",
      now: () => NOW,
      mintToken: mintInvitationToken,
    }),
  };
}

describe("membership authorization", () => {
  it("refuses an unauthenticated caller, and one without the capability", async () => {
    const { membership } = service();
    await expect(membership.listMembers(null, ORG_A)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    const reviewer = actor({ capabilities: new Set<Capability>(["events:read"]) });
    await expect(membership.listMembers(reviewer, ORG_A)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("refuses an organizer of another organization", async () => {
    const { membership } = service();
    await expect(membership.listMembers(actor(), ORG_B)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  /**
   * The mixed-role escalation, and the whole reason this is not `requireCapability` plus a
   * membership test.
   *
   * This actor genuinely belongs to organization B and genuinely holds `identity:manage` — but
   * earned it on an event in organization A. Condition 3 is what refuses them, and dropping it
   * would hand somebody the ability to administer an organization they merely belong to.
   */
  it("refuses a capability earned in another organization", async () => {
    const { membership } = service({ eventsInOrganization: [] });
    const borrowed = actor({ organizations: [{ id: ORG_A }, { id: ORG_B }] });
    await expect(membership.listMembers(borrowed, ORG_B)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // And the same actor is admitted where they did earn it.
    const { membership: inOwn } = service({ eventsInOrganization: [EVENT_A] });
    await expect(inOwn.listMembers(borrowed, ORG_A)).resolves.toEqual([]);
  });
});

describe("the demo population cannot be crossed", () => {
  /**
   * Rule 2: a seeded persona is never a valid grant target, and the refusal is recorded.
   *
   * `seed/reset.sql` gives the personas real addresses, so without this an organizer could grant
   * `seed-organizer` a role in a real organization — after which pressing "Continue as organizer"
   * on the demo landing page opens it.
   */
  it("refuses a demo persona as the subject of a grant, and audits the refusal", async () => {
    const { membership, repository } = service();
    await expect(
      membership.setEventRole(actor(), ORG_A, EVENT_A, "seed-organizer", "reviewer", context),
    ).rejects.toBeInstanceOf(MembershipRefusedError);
    await expect(
      membership.removeMember(actor(), ORG_A, "seed-speaker", context),
    ).rejects.toBeInstanceOf(MembershipRefusedError);
    expect(repository.setEventRole).not.toHaveBeenCalled();
    expect(repository.removeMember).not.toHaveBeenCalled();
    expect(repository.recordRefusal).toHaveBeenCalledTimes(2);
    expect(repository.recordRefusal.mock.calls[0]?.[0]).toMatchObject({
      action: "event_role.granted",
      subjectUserId: "seed-organizer",
      detail: { reason: "demo-persona-subject" },
    });
  });

  /**
   * The persona is authorized *and still refused*, which is the case worth pinning.
   *
   * The seeded organizer genuinely holds `identity:manage` on the demo organization's own event,
   * so the three-condition check admits them. What refuses them is that they are a persona, and
   * anything they wrote would be real state handed to the next visitor who presses "Continue as
   * organizer". Driving this through the demo organization rather than a made-up one is the point
   * — against another organization the first check would refuse them and prove nothing.
   */
  it("refuses a demo persona as the actor administering anything", async () => {
    const persona = await resolveSeededDemoActor("organizer");
    const demoOrganization = persona.organizations[0]?.id as string;
    const demoEvent = persona.eventAccess[0]?.eventId as string;
    const { membership, repository } = service({ eventsInOrganization: [demoEvent] });
    await expect(
      membership.invite(
        persona,
        demoOrganization,
        { email: "new@example.test", role: "organizer" },
        context,
      ),
    ).rejects.toBeInstanceOf(MembershipRefusedError);
    expect(repository.createInvitation).not.toHaveBeenCalled();
    expect(repository.recordRefusal.mock.calls[0]?.[0]).toMatchObject({
      action: "membership.invited",
      detail: { reason: "demo-persona-actor" },
    });
  });

  it("refuses a demo persona accepting an invitation", async () => {
    const { membership, repository } = service();
    const persona = await resolveSeededDemoActor("organizer");
    await expect(membership.accept(persona, "any-token", context)).rejects.toBeInstanceOf(
      MembershipRefusedError,
    );
    expect(repository.acceptInvitation).not.toHaveBeenCalled();
  });
});

describe("invitations", () => {
  /**
   * Acceptance grants to the *caller*, never to the address on the invitation.
   *
   * The repository is handed the accepting actor's own id and the token's digest, and is never
   * told the address — which is rule 1 expressed as a call signature.
   */
  it("accepts by the calling identity and never by the invitation's address", async () => {
    const { membership, repository } = service();
    await expect(membership.accept(actor(), "a-token", context)).resolves.toEqual({
      organizationId: ORG_A,
      eventId: null,
      role: "organizer",
    });
    const call = repository.acceptInvitation.mock.calls[0]?.[0] as unknown as {
      userId: string;
      tokenHash: string;
    };
    expect(call.userId).toBe(actor().id);
    // The digest, never the token, and nothing resembling an address.
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain("a-token");
  });

  it("reports an unusable token as one indistinguishable refusal", async () => {
    const { membership, repository } = service();
    repository.acceptInvitation.mockResolvedValueOnce(null as never);
    await expect(membership.accept(actor(), "spent", context)).rejects.toBeInstanceOf(
      InvitationInvalidError,
    );
  });

  it("mints a token the database only ever sees the digest of", async () => {
    const { membership, repository } = service();
    const { token } = await membership.invite(
      actor(),
      ORG_A,
      { email: "New.Person@Example.test", role: "organizer" },
      context,
    );
    const stored = repository.createInvitation.mock.calls[0]?.[0] as unknown as {
      tokenHash: string;
      email: string;
      expiresAt: number;
    };
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toBe(token);
    // Addresses are normalized on the way in, so the same person is not invited twice by case.
    expect(stored.email).toBe("new.person@example.test");
    expect(stored.expiresAt).toBeGreaterThan(NOW);
  });

  it("refuses an event outside the organization, and a non-organizer organization invitation", async () => {
    const { membership } = service({ belongs: false });
    await expect(
      membership.invite(
        actor(),
        ORG_A,
        { email: "a@example.test", role: "reviewer", eventId: EVENT_B },
        context,
      ),
    ).rejects.toBeInstanceOf(EventOutsideOrganizationError);

    const { membership: ok } = service();
    await expect(
      ok.invite(actor(), ORG_A, { email: "a@example.test", role: "reviewer" }, context),
    ).rejects.toThrow(/organizer role/);
  });

  it("will not staff somebody who is not a member of the organization", async () => {
    const { membership, repository } = service({ member: false });
    await expect(
      membership.setEventRole(actor(), ORG_A, EVENT_A, "somebody-else", "reviewer", context),
    ).rejects.toBeInstanceOf(MembershipRefusedError);
    expect(repository.setEventRole).not.toHaveBeenCalled();
  });
});

describe("the audit log read", () => {
  it("clamps the page size rather than trusting the caller", async () => {
    const { membership, repository } = service();
    await membership.listAuditEvents(actor(), ORG_A, { limit: 100_000 });
    await membership.listAuditEvents(actor(), ORG_A, { limit: 0 });
    await membership.listAuditEvents(actor(), ORG_A, {});
    expect(repository.listAuditEvents.mock.calls.map((call) => call[1])).toEqual([200, 1, 50]);
  });
});
