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

  /** Counted from the same memberships `actor()` derives organizations from. */
  async countOrganizationMembers(organizationId: string): Promise<number> {
    return [...this.memberships.values()].filter((held) => held.includes(organizationId)).length;
  }

  /** `INSERT OR IGNORE` in D1, so the fake must not accrete a duplicate role either. */
  async grantOrganizer(eventId: string, userId: string): Promise<void> {
    const held = this.eventRoles.get(userId) ?? [];
    if (held.some((role) => role.eventId === eventId && role.role === "organizer")) return;
    this.eventRoles.set(userId, [...held, { eventId, role: "organizer" }]);
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
    organizationId: string | null;
  }): Promise<void> {
    this.calls.push("createSelfServeIdentity");
    // The two uniqueness constraints the real table carries, because they are what decides a
    // race: `identity_provider_accounts` is keyed on (provider, subject) and
    // `identity_emails.email` is UNIQUE, so the second writer's whole batch fails.
    if (
      this.providerAccounts.has(`${input.provider}:${input.subject}`) ||
      this.emails.has(input.email.trim().toLowerCase())
    )
      throw new Error("D1 failed to provision identity: UNIQUE constraint failed");
    // One batch in D1, so one indivisible step here: an account that exists without its address
    // or its membership is a state the adapter cannot produce.
    //
    // A null organization is the submitter door: three rows, no membership, and the `public`
    // persona the adapter writes for exactly that case.
    this.users.set(input.userId, {
      name: input.name,
      persona: input.organizationId === null ? "public" : "organizer",
    });
    this.emails.set(input.email.trim().toLowerCase(), input.userId);
    this.providerAccounts.set(`${input.provider}:${input.subject}`, input.userId);
    if (input.organizationId !== null) this.memberships.set(input.userId, [input.organizationId]);
  }

  /**
   * The conditional insert, faithful to *why* it is conditional.
   *
   * D1 runs `INSERT … WHERE NOT EXISTS (SELECT 1 FROM organization_memberships WHERE user_id = ?)`
   * and reports the row count. A fake that wrote unconditionally would reproduce the defect it
   * exists to prevent — two concurrent sign-ins each keeping their own organization — silently,
   * which is exactly what the previous `INSERT OR IGNORE` version did.
   */
  async joinOrganization(organizationId: string, userId: string): Promise<boolean> {
    this.calls.push("joinOrganization");
    if ((this.memberships.get(userId) ?? []).length > 0) return false;
    this.memberships.set(userId, [organizationId]);
    const user = this.users.get(userId);
    if (user) this.users.set(userId, { ...user, persona: "organizer" });
    return true;
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
 * `createFirstEvent` reproduces `EventService.provisionFirstEvent`: the same two authorization
 * checks — so a signup that handed it an actor without the membership it had just been given
 * would fail here rather than quietly produce an event nobody can reach — and the same
 * idempotence, because the provisioning key is unique per organization and the second writer
 * adopts the first's event instead of creating another (issue #164).
 */
class FakeWorkspace implements WorkspaceProvisioning {
  readonly organizations: { id: string; name: string }[] = [];
  readonly events: { id: string; organizationId: string; name: string; timezone: string }[] = [];
  /** Organizations discarded after a signup could not use them, newest last. */
  readonly discarded: string[] = [];
  /** `organizationId` + the subject, exactly as the real partial unique index is keyed. */
  private readonly provisioned = new Map<string, string>();
  constructor(private readonly directory: FakeDirectory) {}

  private static key(organizationId: string, userId: string) {
    return `${organizationId}::${userId}`;
  }

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
    const key = FakeWorkspace.key(command.organizationId, actor.id);
    const taken = this.provisioned.get(key);
    // The partial unique index, as the loser experiences it: the winner's row comes back.
    if (taken !== undefined) return { id: taken };
    const id = `event-${this.events.length + 1}`;
    this.events.push({ id, ...command });
    this.provisioned.set(key, id);
    await this.directory.grantOrganizer(id, actor.id);
    return { id };
  }

  /** Scoped by membership, exactly as `EventService.list` is. */
  async eventsInOrganization(actor: Actor, organizationId: string) {
    if (!actor.organizations.some(({ id }) => id === organizationId)) return [];
    return this.events.filter((event) => event.organizationId === organizationId);
  }

  /** An event somebody else made in their own organization: no provisioning key of this person's. */
  seedForeignEvent(organizationId: string, id: string, name: string): void {
    this.events.push({ id, organizationId, name, timezone: DEFAULT_TIMEZONE });
  }

  /** Guarded exactly as the statement is: an organization holding an event is kept. */
  async discardUnusedOrganization(organizationId: string): Promise<boolean> {
    if (this.events.some((event) => event.organizationId === organizationId)) return false;
    const index = this.organizations.findIndex(({ id }) => id === organizationId);
    if (index === -1) return false;
    this.organizations.splice(index, 1);
    this.discarded.push(organizationId);
    return true;
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

  describe("a sign-in started from a public call page", () => {
    /*
     * Outcome 3 provisioned an organization and a "Your first event" for every unrecognized
     * Google account — including a CFP submitter who pressed "Continue with Google" on a public
     * call page because they wanted to keep track of a talk proposal. They came for a proposal
     * and were handed a conference workspace named after themselves. Recorded as a residual of
     * `GAP-027` by issue #190 and owned by nobody until this lane.
     */
    it("creates an identity and no conference at all", async () => {
      const { directory, workspace, service } = build();

      const outcome = await service.signInWithGoogle(identity(), "submitter");

      // The account is real and complete: it can hold proposals, be written to, and sign in again.
      expect(outcome.provisioned).toBe(true);
      expect(outcome.actor.id).toBe("user-1");
      expect(directory.emails.get("nadia@example.test")).toBe("user-1");
      expect(directory.users.get("user-1")?.persona).toBe("public");
      // And nothing was provisioned around it. Both halves matter: an organization with no event
      // is the orphan a data-aware demo reset refuses on, so "no event" alone is not the claim.
      expect(workspace.organizations).toEqual([]);
      expect(workspace.events).toEqual([]);
      expect(outcome.actor.organizations).toEqual([]);
      expect(outcome.actor.capabilities.size).toBe(0);
    });

    it("does not provision on a later sign-in through the same door", async () => {
      // The decision is about the door, not a one-time flag: returning to the call page must not
      // start handing out workspaces on the second visit.
      const { workspace, service } = build();
      await service.signInWithGoogle(identity(), "submitter");

      const again = await service.signInWithGoogle(identity(), "submitter");

      expect(again.provisioned).toBe(false);
      expect(workspace.organizations).toEqual([]);
      expect(workspace.events).toEqual([]);
    });

    it("gives the same person a workspace when they later sign in through the organizer door", async () => {
      /*
       * The other half, and the reason withholding is safe. An account with no organization used
       * to be a dead end — `completeWorkspace` returned early on it — so a submitter who later
       * decided to run a conference had no way to get one. Signing in at `/signin` is them asking.
       */
      const { directory, workspace, service } = build();
      await service.signInWithGoogle(identity(), "submitter");

      const promoted = await service.signInWithGoogle(identity());

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
      expect(promoted.actor.organizations).toEqual([{ id: "organization-1" }]);
      expect(promoted.actor.eventAccess).toEqual([
        {
          eventId: "event-1",
          role: "organizer",
          capabilities: new Set(roleCapabilities.organizer),
        },
      ]);
      // The console picks its surfaces from the persona when an account holds no event role, so
      // the persona moves with the membership rather than leaving them labelled `public`.
      expect(directory.users.get(promoted.actor.id)?.persona).toBe("organizer");

      // And once: a third sign-in finds the event role and leaves everything alone.
      await service.signInWithGoogle(identity());
      expect(workspace.organizations).toHaveLength(1);
      expect(workspace.events).toHaveLength(1);
    });

    it("gives that person one workspace when two tabs ask at the same moment", async () => {
      /*
       * The race this branch has no *natural* arbiter for, and the reason the membership insert is
       * conditional. Two open tabs are ordinary here — this file's header says so — and each racer
       * mints its own organization before reaching the membership, so the conflict `INSERT OR
       * IGNORE` would absorb never happens: both rows are distinct, both land, and the person is
       * left holding two conferences named after themselves with two "Your first event"s. Nothing
       * in this repository deletes either.
       *
       * With the condition, storage picks one; the loser discards what it made and adopts the
       * winner's workspace.
       */
      const { directory, workspace, service } = build();
      await service.signInWithGoogle(identity(), "submitter");

      const [first, second] = await Promise.all([
        service.signInWithGoogle(identity()),
        service.signInWithGoogle(identity()),
      ]);

      expect(workspace.organizations).toHaveLength(1);
      expect(workspace.events).toHaveLength(1);
      // The loser's organization was created and then removed, rather than left unreferenced —
      // an orphan is the row `GAP-019`'s data-aware restore refuses on for ever.
      expect(workspace.discarded).toHaveLength(1);
      // Both callers are signed in, and to the same workspace.
      expect(first.actor.organizations).toEqual(second.actor.organizations);
      expect(directory.memberships.get(first.actor.id)).toHaveLength(1);
    });

    it("still leaves a linked speaker holding an event role alone", async () => {
      /*
       * The guard that stops "complete the workspace" meaning "give everyone an event" is the
       * *role*, not the absent organization — the submitter door creates accounts holding neither,
       * and one of those signing in at the front door is asking. This is the other side of that
       * line, kept as its own case because the version of it that lived in the resume test was
       * edited when the rule changed, which is how a case stops being covered.
       */
      const { directory, workspace, service } = build();
      directory.seed({
        id: "seed-speaker",
        name: "Sam Speaker",
        persona: "speaker",
        email: "speaker@greenroom.test",
        roles: [{ eventId: "event-someone-elses", role: "speaker" }],
      });
      directory.providerAccounts.set("google:speaker-subject", "seed-speaker");

      const speaker = await service.signInWithGoogle(
        identity({ subject: "speaker-subject", email: "speaker@greenroom.test" }),
      );

      expect(speaker.actor.organizations).toEqual([]);
      expect(workspace.organizations).toEqual([]);
      expect(workspace.events).toEqual([]);
    });

    it("discards the organization when the membership write fails, rather than orphaning it", async () => {
      /*
       * The ordering rule this file's header states, applied to the new path: an organization is
       * written before the row that references it, so a failure in between must remove it. An
       * unreferenced organization is invisible to the product and is exactly what `GAP-019`'s
       * data-aware reset refuses on for ever.
       */
      const { directory, workspace, service } = build();
      await service.signInWithGoogle(identity(), "submitter");
      directory.joinOrganization = async () => {
        throw new Error("D1 failed to record organization membership");
      };

      await expect(service.signInWithGoogle(identity())).rejects.toThrow(
        "D1 failed to record organization membership",
      );
      expect(workspace.organizations).toEqual([]);
      expect(workspace.discarded).toEqual(["organization-1"]);
      expect(workspace.events).toEqual([]);
    });
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

    /*
     * A linked speaker holds an event role, and that is the guard that stops "complete the
     * workspace" meaning "give everyone an event". It is the *role* that excludes them, not the
     * absent organization: the submitter door now creates accounts that hold neither, and one of
     * those signing in through the organizer door is asking for a workspace rather than being
     * given one it never wanted.
     */
    directory.seed({
      id: "seed-speaker",
      name: "Sam Speaker",
      persona: "speaker",
      email: "speaker@greenroom.test",
      roles: [{ eventId: "event-someone-elses", role: "speaker" }],
    });
    directory.providerAccounts.set("google:speaker-subject", "seed-speaker");
    const speaker = await service.signInWithGoogle(
      identity({ subject: "speaker-subject", email: "speaker@greenroom.test" }),
    );
    expect(speaker.actor.organizations).toEqual([]);
    expect(speaker.actor.eventAccess).toEqual([
      {
        eventId: "event-someone-elses",
        role: "speaker",
        capabilities: new Set(roleCapabilities.speaker),
      },
    ]);
    expect(workspace.events).toHaveLength(1);
  });

  /**
   * Two tabs, one account, and the loser recovering instead of leaving marks.
   *
   * The interleaving is forced rather than hoped for: both callbacks read an empty directory
   * before either writes, which is exactly the window issue #164 measured at 25 of 45 stagger
   * offsets against real D1. What decides it here is what decides it there — the identity
   * batch's own uniqueness — so the loser's write fails, its organization is discarded, and it
   * signs in as the user the winner created.
   */
  it("converges two concurrent first sign-ins on one workspace and leaves no orphan", async () => {
    const { directory, workspace, service } = build();

    const [first, second] = await Promise.all([
      service.signInWithGoogle(identity()),
      service.signInWithGoogle(identity()),
    ]);

    expect(directory.users.size).toBe(1);
    expect(workspace.organizations).toHaveLength(1);
    expect(workspace.events).toHaveLength(1);
    // The organization the losing callback created is gone rather than left unreferenced: it is
    // the row a data-aware demo reset would refuse on forever (`GAP-019`).
    expect(workspace.discarded).toHaveLength(1);
    expect(workspace.organizations.map(({ id }) => id)).not.toContain(workspace.discarded[0]);
    // Both callers are signed in, as the same person.
    expect(first.actor.id).toBe(second.actor.id);
    // Exactly one of them created the account, so exactly one browser is welcomed — that flag is
    // what sends a new workspace to `/?welcome=1` rather than to an empty console.
    expect([first.provisioned, second.provisioned].filter(Boolean)).toHaveLength(1);
    /*
     * One of the two may return the actor it read *before* the other's grant landed, and that is
     * deliberate rather than overlooked: the session cookie carries an id, and every later
     * request re-resolves capabilities from storage. What has to be true is the row, so it is the
     * directory that is asserted here rather than the snapshot.
     */
    expect(directory.eventRoles.get(first.actor.id)).toHaveLength(1);
  });

  it("discards the organization and rethrows when provisioning fails for its own reason", async () => {
    const { directory, workspace, service } = build();
    const failure = new Error("D1 unavailable");
    directory.createSelfServeIdentity = async () => {
      throw failure;
    };

    await expect(service.signInWithGoogle(identity())).rejects.toBe(failure);

    // Nothing survives the attempt: no user, and no organization for a reset to trip over.
    expect(directory.users.size).toBe(0);
    expect(workspace.organizations).toEqual([]);
    expect(workspace.discarded).toHaveLength(1);
  });

  /**
   * The discard that removed nothing, which is the quietest way to leave a permanent orphan.
   *
   * `discardUnusedOrganization` answers `false` when the organization has become referenced —
   * nothing threw, nothing is wrong, and the row is now invisible to the product and refused by
   * every later demo restore (`GAP-019`). The count is load-bearing rather than decorative, and
   * this is what holds it that way: without the `!discarded` branch, the only trace of that row
   * disappears and every test still passes.
   */
  it("reports an orphan the discard removed nothing for", async () => {
    const { directory, workspace } = build();
    const reported: { fields: Record<string, unknown>; event: string }[] = [];
    directory.createSelfServeIdentity = async () => {
      throw new Error("identity batch refused");
    };
    // No throw, and no row removed: the organization is referenced by something this domain
    // cannot see.
    workspace.discardUnusedOrganization = async () => false;
    const reporting = new SignupService({
      directory,
      workspace,
      newId: () => "user-orphaned",
      now: () => 1_760_000_000_000,
      report: (fields, event) => reported.push({ fields, event }),
    });

    await expect(reporting.signInWithGoogle(identity())).rejects.toThrow(/identity batch refused/);

    expect(reported).toHaveLength(1);
    expect(reported[0]?.event).toBe("auth.signup.organization_not_discarded");
    // Named, so it can be found by hand: nothing else in the product ever mentions this row.
    expect(reported[0]?.fields).toMatchObject({ organizationId: "organization-1" });
    // And no `discardError`, because nothing failed — this is the silent case.
    expect(reported[0]?.fields).not.toHaveProperty("discardError");
  });

  it("reports both failures when the orphaned organization cannot be discarded either", async () => {
    const { directory, workspace, service } = build();
    const reported: { fields: Record<string, unknown>; event: string }[] = [];
    directory.createSelfServeIdentity = async () => {
      throw new Error("identity batch refused");
    };
    workspace.discardUnusedOrganization = async () => {
      throw new Error("organizations table unreachable");
    };
    const reporting = new SignupService({
      directory,
      workspace,
      newId: () => "user-reported",
      now: () => 1_760_000_000_000,
      report: (fields, event) => reported.push({ fields, event }),
    });

    // Neither error is dropped: the one that explains the sign-in, and the orphan that has to be
    // found by hand because nothing else will now remove it.
    await expect(reporting.signInWithGoogle(identity())).rejects.toThrow(/identity batch refused/);
    await expect(reporting.signInWithGoogle(identity())).rejects.toThrow(
      /organization-\d+ could not be discarded/,
    );
    // And the orphan is named where an operator will find it, because a reset will refuse on it
    // and nothing else in the product ever mentions it.
    expect(reported.map(({ event }) => event)).toEqual([
      "auth.signup.organization_not_discarded",
      "auth.signup.organization_not_discarded",
    ]);
    expect(reported[0]?.fields).toMatchObject({
      organizationId: "organization-1",
      discardError: "organizations table unreachable",
    });
  });

  /**
   * The member count, which is the half of "is this workspace mine" that the events domain
   * cannot answer.
   *
   * Without it, "an organization with no events" reads as "a fresh workspace" and a newcomer is
   * made the organizer of somebody else's empty one — while its owner, whose own next sign-in
   * would then find it non-empty, is stranded with no event for ever. Proved here as well as
   * against D1, because this suite is the one that runs on every check.
   */
  it("provisions nothing into an empty organization somebody else already belongs to", async () => {
    const { directory, workspace, service } = build();
    directory.seed({
      id: "the-owner",
      name: "The Owner",
      persona: "organizer",
      organizationIds: ["organization-shared"],
    });
    directory.seed({
      id: "newcomer",
      name: "The Newcomer",
      persona: "organizer",
      email: "newcomer@example.test",
      organizationIds: ["organization-shared"],
    });
    directory.providerAccounts.set("google:newcomer-subject", "newcomer");

    const outcome = await service.signInWithGoogle(
      identity({ subject: "newcomer-subject", email: "newcomer@example.test" }),
    );

    expect(outcome.actor.eventAccess).toEqual([]);
    expect(workspace.events).toEqual([]);
    expect(directory.eventRoles.get("newcomer") ?? []).toEqual([]);
  });

  /**
   * The state a revoked role leaves, which is bit-for-bit the state a half-finished signup
   * leaves — so completing a workspace must not act on it.
   *
   * `revokeEventRole` deletes the `event_roles` row and audits it, and
   * `docs/product/specifications.md` promises removal "takes effect on their next request". If
   * signing in re-granted organizer on the event this person's own signup provisioned, that
   * promise would hold for every door except Google, and the audit row would describe a
   * revocation that did not survive the afternoon.
   *
   * Nothing is lost by refusing: the event exists, and an organizer of that organization can
   * grant the role back deliberately.
   */
  it("does not restore an event role that was revoked", async () => {
    const { directory, workspace, service } = build();
    const owner = await service.signInWithGoogle(identity({ subject: "owner", email: "o@x.test" }));
    const ownerEvent = owner.actor.eventAccess[0]?.eventId as string;

    // Exactly what revoking their only event role leaves: the membership, and no role.
    directory.eventRoles.set(owner.actor.id, []);
    const returning = await service.signInWithGoogle(
      identity({ subject: "owner", email: "o@x.test" }),
    );

    expect(returning.actor.eventAccess).toEqual([]);
    expect(directory.eventRoles.get(owner.actor.id)).toEqual([]);
    // And no second "Your first event" invented in its place, which is the other way this could
    // have gone wrong.
    expect(workspace.events.map(({ id }) => id)).toEqual([ownerEvent]);
  });

  /**
   * The workspace that is somebody else's, which "adopt the organization's first event" could not
   * tell from a resumable one.
   *
   * An organization-level invitation writes a membership and **no** event role, which is exactly
   * the state `completeWorkspace` acts on: an organization, no event access. Adopting the oldest
   * event there would hand a brand-new member `events:settings:update`, `agenda:manage` and
   * `review:manage` on an event nobody granted them — an escalation that organization membership
   * deliberately does not confer. What separates the two is that completing a workspace never
   * adopts an event at all: it provisions, and only where there is nothing and nobody else.
   */
  it("gives a new member of somebody else's organization nothing", async () => {
    const { directory, workspace, service } = build();
    directory.seed({
      id: "invited",
      name: "Ivan Invited",
      persona: "organizer",
      email: "ivan@example.test",
      // Accepted an organization-level invitation: a membership, and no event role.
      organizationIds: ["organization-established"],
    });
    directory.providerAccounts.set("google:invited-subject", "invited");
    workspace.seedForeignEvent("organization-established", "event-theirs", "Their conference");
    workspace.seedForeignEvent("organization-established", "event-theirs-2", "Their workshop");

    const outcome = await service.signInWithGoogle(
      identity({ subject: "invited-subject", email: "ivan@example.test" }),
    );

    // No role on either of their events, and no event invented for them either: an organizer of
    // that organization grants access deliberately or it does not exist.
    expect(outcome.actor.eventAccess).toEqual([]);
    expect(workspace.events).toHaveLength(2);
    expect(directory.eventRoles.get("invited") ?? []).toEqual([]);
  });

  /**
   * The same escalation against the organization it is actually reachable in: one that a
   * self-serve signup created, and therefore one that holds a *provisioned* first event for ever.
   *
   * Adopting "the organization's first event" hands it to anybody who later holds a membership and
   * no event role — a person invited at organization level, or one whose single event role an
   * organizer deliberately revoked. The fixture below is Alice's own workspace rather than a
   * hand-made one because that is the shape the defect needs: a real provisioned first event,
   * sitting in an organization somebody else has just joined.
   */
  it("does not hand a later member the workspace owner's provisioned event", async () => {
    const { directory, workspace, service } = build();
    // Alice's workspace, made the way the product makes one.
    const alice = await service.signInWithGoogle(identity({ subject: "alice", email: "a@x.test" }));
    const aliceOrganization = alice.actor.organizations[0]?.id as string;
    const aliceEvent = alice.actor.eventAccess[0]?.eventId as string;

    // Bob joins it at organization level: a membership, and no event role — the same shape a
    // revoked event role leaves behind.
    directory.seed({
      id: "bob",
      name: "Bob Later",
      persona: "organizer",
      email: "bob@example.test",
      organizationIds: [aliceOrganization],
    });
    directory.providerAccounts.set("google:bob-subject", "bob");

    const bob = await service.signInWithGoogle(
      identity({ subject: "bob-subject", email: "bob@example.test" }),
    );

    // Bob holds nothing on Alice's event, and Alice still does.
    expect(bob.actor.eventAccess).toEqual([]);
    expect(directory.eventRoles.get("bob") ?? []).toEqual([]);
    expect(directory.eventRoles.get(alice.actor.id)).toEqual([
      { eventId: aliceEvent, role: "organizer" },
    ]);
    expect(workspace.events).toHaveLength(1);
  });

  /**
   * Which organization gets completed must not be decided by identifier sort order.
   *
   * `organizations[0]` is whatever `ORDER BY organization_id` returned. A person whose own signup
   * stalled *and* who has since been invited elsewhere would otherwise have their own workspace
   * completed, or silently not, depending on which UUID sorts first.
   */
  it("completes the signup's own workspace, whichever organization sorts first", async () => {
    const { directory, workspace, service } = build();
    // A signup that stopped before its event: the organization and the membership exist, and
    // nothing else. Meanwhile this person has been invited into somebody else's organization,
    // whose id sorts first.
    directory.seed({
      id: "stalled",
      name: "Sam Stalled",
      persona: "organizer",
      email: "sam@example.test",
      organizationIds: ["aaa-someone-elses", "own-organization"],
    });
    directory.providerAccounts.set("google:stalled-subject", "stalled");
    directory.seed({ id: "their-owner", name: "Their Owner", persona: "organizer" });
    directory.memberships.set("their-owner", ["aaa-someone-elses"]);
    workspace.seedForeignEvent("aaa-someone-elses", "event-theirs", "Their conference");

    const resumed = await service.signInWithGoogle(
      identity({ subject: "stalled-subject", email: "sam@example.test" }),
    );

    // Their own workspace got the event, not the one that merely sorted first.
    expect(workspace.events).toEqual([
      {
        id: "event-theirs",
        organizationId: "aaa-someone-elses",
        name: "Their conference",
        timezone: DEFAULT_TIMEZONE,
      },
      {
        id: "event-2",
        organizationId: "own-organization",
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      },
    ]);
    expect(resumed.actor.eventAccess).toEqual([
      { eventId: "event-2", role: "organizer", capabilities: new Set(roleCapabilities.organizer) },
    ]);
  });

  it("names an organization after the person, clamped to what the column accepts", () => {
    expect(organizationNameFor("Nadia Newcomer")).toBe("Nadia Newcomer");
    expect(organizationNameFor("   ")).toBe("New organization");
    expect(organizationNameFor("x".repeat(200))).toHaveLength(120);
  });
});
