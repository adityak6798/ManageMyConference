// @acceptance ACC-IDENTITY-EVENTS
/**
 * What a verified Google identity turns into, and — more to the point — what it does not.
 *
 * The fakes here are deliberately not empty stubs. The directory resolves an actor the way
 * `D1IdentityDirectory` does, from stored memberships and event roles, and the workspace runs
 * the same capability and membership checks `EventService.create` runs. That is what lets these
 * cases assert the interesting properties rather than the call order: a linked speaker is still
 * a speaker because the roles say so, and the first event is created by an actor who genuinely
 * holds `events:create` on the organization it belongs to.
 */
import { describe, expect, it } from "vitest";
import {
  type Actor,
  type Capability,
  CapabilityDeniedError,
  type EventAccess,
  requireCapability,
} from "../src/application/identity/actor";
import type { GoogleIdentity } from "../src/application/identity/google-oauth";
import {
  DEFAULT_TIMEZONE,
  FIRST_EVENT_NAME,
  organizationNameFor,
  type SignupDirectory,
  SignupService,
  UnverifiedProviderEmailError,
  type WorkspaceProvisioning,
} from "../src/application/identity/signup";

const roleCapabilities: Record<EventAccess["role"], readonly Capability[]> = {
  organizer: [
    "events:read",
    "events:settings:read",
    "events:settings:update",
    "communications:manage",
    "agenda:manage",
    "crm:manage",
    "content:read",
    "content:manage",
    "review:manage",
  ],
  reviewer: ["events:read", "review:evaluate"],
  speaker: ["events:read", "content:read"],
  public: [],
};

interface StoredUser {
  name: string;
  persona: Actor["persona"];
}

/**
 * The identity store, as rows rather than as canned answers.
 *
 * `calls` is what the unverified-address case asserts on: "writes nothing" has to mean nothing
 * was asked of the directory at all, not that a write happened to be harmless.
 */
class FakeDirectory implements SignupDirectory {
  readonly calls: string[] = [];
  readonly users = new Map<string, StoredUser>();
  readonly emails = new Map<string, string>();
  readonly providerAccounts = new Map<string, string>();
  readonly memberships = new Map<string, string[]>();
  readonly eventRoles = new Map<string, { eventId: string; role: EventAccess["role"] }[]>();

  seed(user: {
    id: string;
    name: string;
    persona: Actor["persona"];
    email?: string;
    organizationIds?: string[];
    roles?: { eventId: string; role: EventAccess["role"] }[];
  }): void {
    this.users.set(user.id, { name: user.name, persona: user.persona });
    if (user.email) this.emails.set(user.email, user.id);
    if (user.organizationIds) this.memberships.set(user.id, user.organizationIds);
    if (user.roles) this.eventRoles.set(user.id, user.roles);
  }

  grantOrganizer(eventId: string, userId: string): void {
    this.eventRoles.set(userId, [
      ...(this.eventRoles.get(userId) ?? []),
      { eventId, role: "organizer" },
    ]);
  }

  async findByProviderAccount(provider: "google", subject: string): Promise<Actor | null> {
    this.calls.push("findByProviderAccount");
    const userId = this.providerAccounts.get(`${provider}:${subject}`);
    return userId ? this.actor(userId) : null;
  }

  async findByEmail(email: string): Promise<Actor | null> {
    this.calls.push("findByEmail");
    const userId = this.emails.get(email.trim().toLowerCase());
    return userId ? this.actor(userId) : null;
  }

  async findByUserId(userId: string): Promise<Actor | null> {
    this.calls.push("findByUserId");
    return this.actor(userId);
  }

  async linkProviderAccount(input: {
    provider: "google";
    subject: string;
    userId: string;
    linkedAt: number;
  }): Promise<void> {
    this.calls.push("linkProviderAccount");
    const key = `${input.provider}:${input.subject}`;
    if (!this.providerAccounts.has(key)) this.providerAccounts.set(key, input.userId);
  }

  async createSelfServeIdentity(input: {
    userId: string;
    name: string;
    email: string;
    provider: "google";
    subject: string;
    linkedAt: number;
    organizationId: string;
  }): Promise<void> {
    this.calls.push("createSelfServeIdentity");
    // One batch in D1, so one indivisible step here: an account that exists without its address
    // or its membership is a state the adapter cannot produce.
    this.users.set(input.userId, { name: input.name, persona: "organizer" });
    this.emails.set(input.email.trim().toLowerCase(), input.userId);
    this.providerAccounts.set(`${input.provider}:${input.subject}`, input.userId);
    this.memberships.set(input.userId, [input.organizationId]);
  }

  /** The same derivation `D1IdentityDirectory.resolve` performs, from the same two tables. */
  private actor(userId: string): Actor | null {
    const user = this.users.get(userId);
    if (!user) return null;
    const organizations = (this.memberships.get(userId) ?? []).map((id) => ({ id }));
    const eventAccess = (this.eventRoles.get(userId) ?? []).map((role) => ({
      eventId: role.eventId,
      role: role.role,
      capabilities: new Set(roleCapabilities[role.role]),
    }));
    const capabilities = new Set<Capability>();
    if (organizations.length)
      for (const capability of [
        "events:read",
        "events:create",
        "communications:manage",
        "agenda:manage",
      ] as const)
        capabilities.add(capability);
    for (const access of eventAccess)
      for (const capability of access.capabilities) capabilities.add(capability);
    return {
      id: userId,
      name: user.name,
      persona: user.persona,
      organizations,
      eventAccess,
      capabilities,
    };
  }
}

/**
 * The events domain's side, with its real refusals.
 *
 * `createFirstEvent` reproduces `EventService.create`'s two checks, so a signup that handed it
 * an actor without the membership it had just been given would fail here rather than quietly
 * produce an event nobody can reach.
 */
class FakeWorkspace implements WorkspaceProvisioning {
  readonly organizations: { id: string; name: string }[] = [];
  readonly events: { id: string; organizationId: string; name: string; timezone: string }[] = [];
  constructor(private readonly directory: FakeDirectory) {}

  async provisionOrganization(command: { name: string }): Promise<{ id: string }> {
    const id = `organization-${this.organizations.length + 1}`;
    this.organizations.push({ id, name: command.name });
    return { id };
  }

  async createFirstEvent(
    actor: Actor,
    command: { organizationId: string; name: string; timezone: string },
  ): Promise<{ id: string }> {
    requireCapability(actor, "events:create");
    if (!actor.organizations.some(({ id }) => id === command.organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const id = `event-${this.events.length + 1}`;
    this.events.push({ id, ...command });
    this.directory.grantOrganizer(id, actor.id);
    return { id };
  }
}

const build = () => {
  const directory = new FakeDirectory();
  const workspace = new FakeWorkspace(directory);
  let minted = 0;
  const service = new SignupService({
    directory,
    workspace,
    newId: () => {
      minted += 1;
      return `user-${minted}`;
    },
    now: () => 1_760_000_000_000,
  });
  return { directory, workspace, service };
};

const identity = (overrides: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  subject: "104729183746501928374",
  email: "nadia@example.test",
  emailVerified: true,
  name: "Nadia Newcomer",
  ...overrides,
});

const demoEventId = "00000000-0000-4000-8000-000000000001";

describe("SignupService", () => {
  it("gives a first-time Google identity a user, an organization and an event it organizes", async () => {
    const { directory, workspace, service } = build();

    const outcome = await service.signInWithGoogle(identity());

    expect(outcome.provisioned).toBe(true);
    expect(workspace.organizations).toEqual([
      { id: "organization-1", name: organizationNameFor("Nadia Newcomer") },
    ]);
    expect(workspace.events).toEqual([
      {
        id: "event-1",
        organizationId: "organization-1",
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      },
    ]);
    expect(directory.users.get("user-1")).toEqual({ name: "Nadia Newcomer", persona: "organizer" });
    expect(directory.emails.get("nadia@example.test")).toBe("user-1");
    expect(directory.providerAccounts.get("google:104729183746501928374")).toBe("user-1");
    // The actor the session will be issued for is read back after the role was granted, so it
    // carries the organizer capabilities on the event it just received.
    expect(outcome.actor).toMatchObject({ id: "user-1", persona: "organizer" });
    expect(outcome.actor.organizations).toEqual([{ id: "organization-1" }]);
    expect(outcome.actor.eventAccess).toEqual([
      {
        eventId: "event-1",
        role: "organizer",
        capabilities: new Set(roleCapabilities.organizer),
      },
    ]);
    expect(outcome.actor.capabilities.has("events:settings:update")).toBe(true);
    expect(outcome.actor.capabilities.has("agenda:manage")).toBe(true);
  });

  it("provisions nothing at all on the second sign-in of the same account", async () => {
    const { directory, workspace, service } = build();
    const first = await service.signInWithGoogle(identity());

    const second = await service.signInWithGoogle(identity({ name: "Nadia N." }));

    expect(second.provisioned).toBe(false);
    expect(second.actor).toEqual(first.actor);
    expect(workspace.organizations).toHaveLength(1);
    expect(workspace.events).toHaveLength(1);
    expect(directory.users.size).toBe(1);
    // Nor is the display name from a later token allowed to rewrite the stored one.
    expect(directory.users.get("user-1")?.name).toBe("Nadia Newcomer");
  });

  it("links a verified address to the identity that already holds it, and provisions nothing", async () => {
    const { directory, workspace, service } = build();
    directory.seed({
      id: "seed-speaker",
      name: "Sam Speaker",
      persona: "speaker",
      email: "speaker@greenroom.test",
      roles: [{ eventId: demoEventId, role: "speaker" }],
    });

    const outcome = await service.signInWithGoogle(
      identity({ subject: "speaker-subject", email: "speaker@greenroom.test" }),
    );

    expect(outcome.provisioned).toBe(false);
    // The whole point of the case: a seeded speaker who signs in with Google is that speaker.
    expect(outcome.actor).toMatchObject({ id: "seed-speaker", persona: "speaker" });
    expect(outcome.actor.organizations).toEqual([]);
    expect(outcome.actor.eventAccess).toEqual([
      {
        eventId: demoEventId,
        role: "speaker",
        capabilities: new Set(roleCapabilities.speaker),
      },
    ]);
    expect(outcome.actor.capabilities.has("events:create")).toBe(false);
    expect(workspace.organizations).toEqual([]);
    expect(workspace.events).toEqual([]);
    expect(directory.users.size).toBe(1);
    expect(directory.providerAccounts.get("google:speaker-subject")).toBe("seed-speaker");

    // And the link holds: the next sign-in resolves by provider account and still provisions
    // nothing, so a speaker never accumulates an empty organization beside their real access.
    const returning = await service.signInWithGoogle(
      identity({ subject: "speaker-subject", email: "speaker@greenroom.test" }),
    );
    expect(returning.actor).toEqual(outcome.actor);
    expect(workspace.organizations).toEqual([]);
    expect(workspace.events).toEqual([]);
  });

  it("refuses an unverified address before it can be linked to anything", async () => {
    const { directory, workspace, service } = build();
    // Seeded so the refusal is load-bearing: without it, "I claim this address" would hand this
    // caller the organizer's account.
    directory.seed({
      id: "seed-organizer",
      name: "Olivia Organizer",
      persona: "organizer",
      email: "organizer@greenroom.test",
      organizationIds: ["organization-seed"],
      roles: [{ eventId: demoEventId, role: "organizer" }],
    });

    await expect(
      service.signInWithGoogle(
        identity({ email: "organizer@greenroom.test", emailVerified: false }),
      ),
    ).rejects.toBeInstanceOf(UnverifiedProviderEmailError);

    expect(directory.calls).toEqual([]);
    expect(directory.providerAccounts.size).toBe(0);
    expect(directory.users.size).toBe(1);
    expect(workspace.organizations).toEqual([]);
    expect(workspace.events).toEqual([]);
  });

  it("resumes a signup that stopped after the organization, and only that one", async () => {
    const { directory, workspace, service } = build();
    // The state a failure between the identity batch and the first event leaves behind.
    directory.seed({
      id: "half-provisioned",
      name: "Half Provisioned",
      persona: "organizer",
      email: "half@example.test",
      organizationIds: ["organization-existing"],
    });
    directory.providerAccounts.set("google:half-subject", "half-provisioned");

    const resumed = await service.signInWithGoogle(
      identity({ subject: "half-subject", email: "half@example.test" }),
    );

    // Not `provisioned`: the account was not created by this sign-in, so nothing welcomes them
    // as new. The missing event is simply completed.
    expect(resumed.provisioned).toBe(false);
    expect(workspace.organizations).toEqual([]);
    expect(workspace.events).toEqual([
      {
        id: "event-1",
        organizationId: "organization-existing",
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      },
    ]);
    expect(resumed.actor.eventAccess).toEqual([
      { eventId: "event-1", role: "organizer", capabilities: new Set(roleCapabilities.organizer) },
    ]);

    // Once. A third sign-in finds an event role and leaves it alone.
    await service.signInWithGoogle(
      identity({ subject: "half-subject", email: "half@example.test" }),
    );
    expect(workspace.events).toHaveLength(1);

    // A linked speaker has no organization, so the resume condition can never fire for them —
    // this is the guard that stops "complete the workspace" meaning "give everyone an event".
    directory.seed({
      id: "seed-speaker",
      name: "Sam Speaker",
      persona: "speaker",
      email: "speaker@greenroom.test",
      roles: [],
    });
    directory.providerAccounts.set("google:speaker-subject", "seed-speaker");
    const speaker = await service.signInWithGoogle(
      identity({ subject: "speaker-subject", email: "speaker@greenroom.test" }),
    );
    expect(speaker.actor.eventAccess).toEqual([]);
    expect(workspace.events).toHaveLength(1);
  });

  it("names an organization after the person, clamped to what the column accepts", () => {
    expect(organizationNameFor("Nadia Newcomer")).toBe("Nadia Newcomer");
    expect(organizationNameFor("   ")).toBe("New organization");
    expect(organizationNameFor("x".repeat(200))).toHaveLength(120);
  });
});
