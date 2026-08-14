import type { IdentityDirectory } from "../../application/identity/identity-directory";
import type { DemoPersona } from "../../application/identity/demo-session";
import type { Actor, Capability, EventAccess } from "../../application/identity/actor";
import { ATTEMPT_LIFETIME_MS } from "../../application/identity/google-oauth";

interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}
export interface IdentityDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

interface UserRow {
  id: string;
  name: string;
  persona: DemoPersona;
}
interface MembershipRow {
  organization_id: string;
}
interface EventRoleRow {
  event_id: string;
  role: EventAccess["role"];
  custom_role_id: string | null;
  custom_role_name: string | null;
}
interface CustomGrantRow {
  role_id: string;
  capability: string | null;
  subject: string | null;
  field: string | null;
  policy: string | null;
}

/**
 * What each built-in role earns. A `custom` grant earns nothing here — its capabilities are rows
 * in `event_custom_role_capabilities` and are read per role, which is the whole point of it.
 */
const eventCapabilities: Record<EventAccess["role"], readonly Capability[]> = {
  custom: [],
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
    "identity:manage",
  ],
  reviewer: ["events:read", "review:evaluate"],
  speaker: ["events:read", "content:read"],
  public: [],
};

/** The one statement `grantOrganizer` runs, shared with the writer below so they cannot drift. */
const GRANT_ORGANIZER =
  "INSERT OR IGNORE INTO event_roles (event_id, user_id, role) VALUES (?, ?, 'organizer')";

/**
 * Binds the organizer grant to a database, for a caller that must commit it inside its own batch.
 *
 * The events domain creates an event and its creator's organizer role, and those were two
 * unbatched writes: a failure between them left an event its creator could not open (issue
 * #164). `event_roles` is identity-access's table, so the events adapter is handed this rather
 * than the SQL — it never learns the table or the column names. Mirrors `preparedAuditWriter`
 * and `preparedDeliveryWriter`.
 *
 * `INSERT OR IGNORE`, exactly as `grantOrganizer` is: a role already held is the outcome the
 * caller wanted, and a repeat of it is free.
 */
export function preparedOrganizerGrant<TStatement>(
  database: { prepare(query: string): { bind(...values: unknown[]): TStatement } },
  grant: { readonly eventId: string; readonly userId: string },
): readonly TStatement[] {
  return [database.prepare(GRANT_ORGANIZER).bind(grant.eventId, grant.userId)];
}

// @spec PRD-IAM-001 PRD-EVT-001
export class D1IdentityDirectory implements IdentityDirectory {
  async linkEmail(userId: string, email: string): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO identity_emails (user_id,email) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email",
      )
      .bind(userId, email)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to link identity email: ${result.error ?? "unknown error"}`);
  }
  async saveLoginChallenge(challenge: {
    id: string;
    email: string;
    codeProof: string;
    expiresAt: number;
  }) {
    const cleanup = await this.database
      .prepare("DELETE FROM identity_login_challenges WHERE expires_at <= ?")
      .bind(challenge.expiresAt - 600_000)
      .run();
    if (!cleanup.success)
      throw new Error(`D1 failed to clean login challenges: ${cleanup.error ?? "unknown error"}`);
    const result = await this.database
      .prepare(
        "INSERT INTO identity_login_challenges (id,email,code_proof,expires_at,attempts) VALUES (?,?,?,?,0)",
      )
      .bind(challenge.id, challenge.email, challenge.codeProof, challenge.expiresAt)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save login challenge: ${result.error ?? "unknown error"}`);
  }

  async consumeLoginChallenge(id: string, codeProof: string, now: number): Promise<string | null> {
    const result = await this.database
      .prepare(
        "UPDATE identity_login_challenges SET attempts=attempts+1, consumed_at=CASE WHEN code_proof=? THEN ? ELSE consumed_at END WHERE id=? AND consumed_at IS NULL AND expires_at>? AND attempts<5 RETURNING email, code_proof",
      )
      .bind(codeProof, now, id, now)
      .all<{ email: string; code_proof: string }>();
    if (!result.success)
      throw new Error(`D1 failed to consume login challenge: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row?.code_proof === codeProof ? row.email : null;
  }
  constructor(private readonly database: IdentityDatabasePort) {}

  async findByPersona(persona: DemoPersona): Promise<Actor | null> {
    const users = await this.database
      .prepare("SELECT id, name, persona FROM users WHERE id = ? AND persona = ? LIMIT 1")
      .bind(`seed-${persona}`, persona)
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve identity: ${users.error ?? "unknown error"}`);
    if (!users.results?.length) return null;
    return users.results?.[0] ? this.resolve(users.results[0]) : null;
  }

  async findByUserId(userId: string): Promise<Actor | null> {
    const users = await this.database
      .prepare("SELECT id, name, persona FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve identity: ${users.error ?? "unknown error"}`);
    return users.results?.[0] ? this.resolve(users.results[0]) : null;
  }

  /**
   * Save one in-flight authorization attempt, sweeping attempts that can no longer complete.
   *
   * The sweep is the same shape as `saveLoginChallenge`'s and exists for the same reason: this
   * table only ever grows otherwise, and every row in it is a secret that has outlived its use.
   *
   * The threshold is `expiresAt - ATTEMPT_LIFETIME_MS`, which is *now* — the moment this attempt
   * was minted — so it deletes exactly the attempts that have already expired and never one that
   * is still in flight. It reads the same constant the lifetime is set from rather than repeating
   * its value: written as a literal, raising the lifetime to accommodate a slow consent screen
   * would silently start sweeping attempts belonging to users who were still on Google's page.
   */
  async saveOauthAttempt(attempt: {
    id: string;
    stateProof: string;
    codeVerifier: string;
    nonce: string;
    expiresAt: number;
  }): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare("DELETE FROM identity_oauth_attempts WHERE expires_at <= ?")
        .bind(attempt.expiresAt - ATTEMPT_LIFETIME_MS),
      this.database
        .prepare(
          "INSERT INTO identity_oauth_attempts (id,state_proof,code_verifier,nonce,expires_at) VALUES (?,?,?,?,?)",
        )
        .bind(
          attempt.id,
          attempt.stateProof,
          attempt.codeVerifier,
          attempt.nonce,
          attempt.expiresAt,
        ),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`D1 failed to save sign-in attempt: ${failed.error ?? "unknown error"}`);
  }

  /**
   * Spend whichever of this browser's attempts the `state` proof identifies, or refuse.
   *
   * `DELETE … RETURNING` rather than a read followed by a delete: a callback replayed twice, or
   * two callbacks racing, must produce exactly one success, and only a single statement can
   * promise that. Everything the caller needs comes back in the same round trip. A wrong
   * `state_proof`, an expired attempt and an already-spent one are one indistinguishable refusal,
   * which is the correct amount to tell whoever is trying.
   *
   * **Several ids, one proof** (issue #166). A browser may hold up to
   * `MAX_OUTSTANDING_ATTEMPTS` sign-ins in flight, and the callback does not know which of them
   * it belongs to; the proof does, because it is an HMAC of 32 random bytes minted per attempt.
   * The `IN` list is the browser-binding half of the CSRF defence and the proof is the
   * identifying half, so widening the list to the attempts this browser actually started widens
   * nothing else. Two ids cannot both match: a collision would need two attempts to have been
   * minted with the same `state`.
   *
   * The id set is bounded by the cookie parser, well inside D1's 100-parameter limit.
   */
  async consumeOauthAttempt(
    ids: readonly string[],
    stateProof: string,
    now: number,
  ): Promise<{ id: string; codeVerifier: string; nonce: string } | null> {
    if (ids.length === 0) return null;
    const result = await this.database
      .prepare(
        `DELETE FROM identity_oauth_attempts WHERE id IN (${ids.map(() => "?").join(",")}) AND state_proof=? AND expires_at>? RETURNING id, code_verifier, nonce`,
      )
      .bind(...ids, stateProof, now)
      .all<{ id: string; code_verifier: string; nonce: string }>();
    if (!result.success)
      throw new Error(`D1 failed to consume sign-in attempt: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? { id: row.id, codeVerifier: row.code_verifier, nonce: row.nonce } : null;
  }

  async findByProviderAccount(provider: "google", subject: string): Promise<Actor | null> {
    const users = await this.database
      .prepare(
        "SELECT u.id, u.name, u.persona FROM users u JOIN identity_provider_accounts a ON a.user_id = u.id WHERE a.provider = ? AND a.subject = ? LIMIT 1",
      )
      .bind(provider, subject)
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve provider account: ${users.error ?? "unknown error"}`);
    return users.results?.[0] ? this.resolve(users.results[0]) : null;
  }

  /**
   * Link a provider account to an existing identity, ignoring a link that is already there.
   *
   * **`DO NOTHING` is safe only while one provider subject resolves to exactly one user**, and
   * that is worth writing down because it is an assumption rather than a guarantee. Today it
   * holds: `signInWithGoogle` looks up `(provider, subject)` first and only falls through to the
   * address when that finds nothing, one Google account has one verified address at a time, and
   * `identity_emails.email` is `UNIQUE` — so two callbacks racing on one subject resolve the
   * *same* user, and the losing insert suppresses a write that was already correct.
   *
   * It stops holding the day there is a second provider, manual account linking, or any path by
   * which one subject can reach two users. At that point this must return the winning row and the
   * caller must refuse to issue a session that disagrees with it, because otherwise the durable
   * link and the session say different things and nothing notices. Raised by the automated review
   * on #162 and rejected on exactly the reasoning above; kept here so the next person meets the
   * condition rather than the conclusion.
   */
  async linkProviderAccount(input: {
    provider: "google";
    subject: string;
    userId: string;
    linkedAt: number;
  }): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO identity_provider_accounts (provider,subject,user_id,linked_at) VALUES (?,?,?,?) ON CONFLICT(provider,subject) DO NOTHING",
      )
      .bind(input.provider, input.subject, input.userId, input.linkedAt)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to link provider account: ${result.error ?? "unknown error"}`);
  }

  /**
   * The whole identity half of a self-serve signup, in one batch.
   *
   * Four rows across four tables that are only meaningful together — an account with no address
   * cannot be written to, and one with no membership has a console it cannot use. D1 applies a
   * batch atomically, so the alternative to this is a user who can sign in to nothing.
   */
  async createSelfServeIdentity(input: {
    userId: string;
    name: string;
    email: string;
    provider: "google";
    subject: string;
    linkedAt: number;
    organizationId: string;
  }): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare("INSERT INTO users (id,name,persona) VALUES (?,?,'organizer')")
        .bind(input.userId, input.name),
      this.database
        .prepare("INSERT INTO identity_emails (user_id,email) VALUES (?,?)")
        .bind(input.userId, input.email.trim().toLowerCase()),
      this.database
        .prepare(
          "INSERT INTO identity_provider_accounts (provider,subject,user_id,linked_at) VALUES (?,?,?,?)",
        )
        .bind(input.provider, input.subject, input.userId, input.linkedAt),
      this.database
        .prepare(
          "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (?,?,'organizer')",
        )
        .bind(input.organizationId, input.userId),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`D1 failed to provision identity: ${failed.error ?? "unknown error"}`);
  }

  async findByEmail(email: string): Promise<Actor | null> {
    const users = await this.database
      .prepare(
        "SELECT u.id, u.name, u.persona FROM users u JOIN identity_emails e ON e.user_id = u.id WHERE e.email = ? LIMIT 1",
      )
      .bind(email.trim().toLowerCase())
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve identity email: ${users.error ?? "unknown error"}`);
    return users.results?.[0] ? this.resolve(users.results[0]) : null;
  }

  /**
   * The capabilities and field policies of every custom role this actor holds, in one round trip.
   *
   * Resolved with the actor rather than on demand, because `fieldAccessFor` has to be a pure
   * function of the actor: a projection, an export and a report all ask the same question, and a
   * lookup at each call site is how they come to disagree. `resolveUserSession` re-derives the
   * actor from D1 on every request, so a role edited a moment ago takes effect on the next
   * authorized read with no session recreation and nothing cached to leak.
   *
   * One `UNION ALL` rather than two statements: the two child tables answer the same question
   * about the same small id set, and a role with capabilities but no policies must still produce
   * rows.
   */
  private async resolveCustomGrants(
    roleIds: readonly string[],
  ): Promise<
    Map<
      string,
      { capabilities: Capability[]; fieldPolicies: Map<string, "view" | "lock" | "hide"> }
    >
  > {
    const grants = new Map<
      string,
      { capabilities: Capability[]; fieldPolicies: Map<string, "view" | "lock" | "hide"> }
    >();
    if (roleIds.length === 0) return grants;
    const ids = JSON.stringify([...new Set(roleIds)]);
    const rows = await this.database
      .prepare(
        "SELECT role_id, capability, NULL AS subject, NULL AS field, NULL AS policy " +
          "FROM event_custom_role_capabilities WHERE role_id IN (SELECT value FROM json_each(?)) " +
          "UNION ALL " +
          "SELECT role_id, NULL AS capability, subject, field, policy " +
          "FROM event_custom_role_field_policies WHERE role_id IN (SELECT value FROM json_each(?))",
      )
      .bind(ids, ids)
      .all<CustomGrantRow>();
    if (!rows.success)
      throw new Error(`D1 failed to resolve custom role grants: ${rows.error ?? "unknown error"}`);
    for (const id of new Set(roleIds))
      grants.set(id, { capabilities: [], fieldPolicies: new Map() });
    for (const row of rows.results ?? []) {
      const grant = grants.get(row.role_id);
      if (!grant) continue;
      if (row.capability) grant.capabilities.push(row.capability as Capability);
      else if (row.subject && row.field && row.policy)
        grant.fieldPolicies.set(
          `${row.subject}:${row.field}`,
          row.policy as "view" | "lock" | "hide",
        );
    }
    return grants;
  }

  private async resolve(user: UserRow): Promise<Actor> {
    const [organizations, roles] = await Promise.all([
      this.database
        .prepare(
          "SELECT organization_id FROM organization_memberships WHERE user_id = ? AND role = 'organizer' ORDER BY organization_id",
        )
        .bind(user.id)
        .all<MembershipRow>(),
      this.database
        .prepare(
          "SELECT r.event_id, r.role, r.custom_role_id, c.name AS custom_role_name FROM event_roles r " +
            "LEFT JOIN event_custom_roles c ON c.id = r.custom_role_id " +
            "WHERE r.user_id = ? ORDER BY r.event_id, r.role",
        )
        .bind(user.id)
        .all<EventRoleRow>(),
    ]);
    if (!organizations.success)
      throw new Error(
        `D1 failed to resolve memberships: ${organizations.error ?? "unknown error"}`,
      );
    if (!roles.success)
      throw new Error(`D1 failed to resolve event roles: ${roles.error ?? "unknown error"}`);
    const organizationList = (organizations.results ?? []).map(({ organization_id }) => ({
      id: organization_id,
    }));
    const customGrants = await this.resolveCustomGrants(
      (roles.results ?? [])
        .map((role) => role.custom_role_id)
        .filter((id): id is string => id !== null),
    );
    const eventAccess = (roles.results ?? []).map((role) => {
      if (role.role !== "custom" || !role.custom_role_id)
        return {
          eventId: role.event_id,
          role: role.role,
          capabilities: new Set(eventCapabilities[role.role]),
        };
      const grant = customGrants.get(role.custom_role_id);
      return {
        eventId: role.event_id,
        role: role.role,
        capabilities: new Set(grant?.capabilities ?? []),
        customRole: { id: role.custom_role_id, name: role.custom_role_name ?? "Custom role" },
        // Always present on a custom grant, empty map included: its *absence* is what
        // `fieldAccessFor` reads as "this grant is a built-in role and governs nothing", so a
        // custom role with no policies must still carry one.
        fieldPolicies: grant?.fieldPolicies ?? new Map<string, "view" | "lock" | "hide">(),
      };
    });
    const capabilities = new Set<Capability>();
    if (organizationList.length) {
      capabilities.add("events:read");
      capabilities.add("events:create");
      capabilities.add("communications:manage");
      capabilities.add("agenda:manage");
    }
    for (const access of eventAccess)
      for (const capability of access.capabilities) capabilities.add(capability);
    return {
      id: user.id,
      name: user.name,
      persona: user.persona,
      organizations: organizationList,
      eventAccess,
      capabilities,
    };
  }

  async isReviewerForEvent(userId: string, eventId: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "SELECT event_id FROM event_roles WHERE user_id = ? AND event_id = ? AND role = 'reviewer' LIMIT 1",
      )
      .bind(userId, eventId)
      .all<{ event_id: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to validate reviewer assignment: ${result.error ?? "unknown error"}`,
      );
    return result.results?.length === 1;
  }
  async isSpeakerForEvent(userId: string, eventId: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "SELECT event_id FROM event_roles WHERE user_id = ? AND event_id = ? AND role = 'speaker' LIMIT 1",
      )
      .bind(userId, eventId)
      .all<{ event_id: string }>();
    if (!result.success)
      throw new Error(`D1 failed to validate speaker access: ${result.error ?? "unknown error"}`);
    return result.results?.length === 1;
  }
  async listReviewersForEvent(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT u.id, u.name FROM users u JOIN event_roles r ON r.user_id = u.id WHERE r.event_id = ? AND r.role = 'reviewer' ORDER BY u.name, u.id",
      )
      .bind(eventId)
      .all<{ id: string; name: string }>();
    if (!result.success)
      throw new Error(`D1 failed to list event reviewers: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  /**
   * The event's speakers and how to reach them.
   *
   * `LEFT JOIN` on the address: a speaker with no linked identity email is still a speaker and
   * still belongs in the list, so the caller can say "3 of 4 are reachable" instead of silently
   * addressing fewer people than the organizer thinks.
   */
  async listSpeakersForEvent(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT DISTINCT u.id, u.name, e.email FROM users u JOIN event_roles r ON r.user_id = u.id LEFT JOIN identity_emails e ON e.user_id = u.id WHERE r.event_id = ? AND r.role = 'speaker' ORDER BY u.name, u.id",
      )
      .bind(eventId)
      .all<{ id: string; name: string; email: string | null }>();
    if (!result.success)
      throw new Error(`D1 failed to list event speakers: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map((row) => ({ ...row, email: row.email ?? null }));
  }

  async findRecipient(userId: string) {
    const result = await this.database
      .prepare(
        "SELECT u.id, u.name, e.email FROM users u LEFT JOIN identity_emails e ON e.user_id = u.id WHERE u.id = ? LIMIT 1",
      )
      .bind(userId)
      .all<{ id: string; name: string; email: string | null }>();
    if (!result.success)
      throw new Error(`D1 failed to find recipient: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? { ...row, email: row.email ?? null } : null;
  }

  /**
   * The event's staff. `DISTINCT` because a user may hold both roles on one event, and the
   * `event_id` predicate is what keeps the list event-scoped: a role held on another event
   * never appears here.
   */
  async listAssignableOwnersForEvent(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT DISTINCT u.id, u.name FROM users u JOIN event_roles r ON r.user_id = u.id WHERE r.event_id = ? AND r.role IN ('organizer','reviewer') ORDER BY u.name, u.id",
      )
      .bind(eventId)
      .all<{ id: string; name: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to list assignable event owners: ${result.error ?? "unknown error"}`,
      );
    return result.results ?? [];
  }

  async grantOrganizer(eventId: string, userId: string): Promise<void> {
    const result = await this.database.prepare(GRANT_ORGANIZER).bind(eventId, userId).run();
    if (!result.success)
      throw new Error(`D1 failed to grant event organizer: ${result.error ?? "unknown error"}`);
  }

  /**
   * How many people belong to this organization.
   *
   * Self-serve signup asks it to tell its own new workspace from one it was merely added to
   * (`completeWorkspace`). A count rather than a list, because that is the whole question and a
   * list of members is somebody's data.
   */
  async countOrganizationMembers(organizationId: string): Promise<number> {
    const result = await this.database
      .prepare("SELECT COUNT(*) AS total FROM organization_memberships WHERE organization_id = ?")
      .bind(organizationId)
      .all<{ total: number }>();
    if (!result.success)
      throw new Error(
        `D1 failed to count organization members: ${result.error ?? "unknown error"}`,
      );
    return result.results?.[0]?.total ?? 0;
  }

  async provisionSpeaker(userId: string, name: string, eventId: string): Promise<void> {
    const results = await this.database.batch([
      // ERROR-INTENT: a duplicate ID means a concurrent conversion already provisioned this identity.
      this.database
        .prepare("INSERT OR IGNORE INTO users (id,name,persona) VALUES (?,?,'speaker')")
        .bind(userId, name),
      // ERROR-INTENT: a duplicate event role means the canonical speaker already has access.
      this.database
        .prepare("INSERT OR IGNORE INTO event_roles (event_id,user_id,role) VALUES (?,?,'speaker')")
        .bind(eventId, userId),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(
        `D1 failed to provision speaker identity: ${failed.error ?? "unknown error"}`,
      );
  }
}
