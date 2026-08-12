import type { IdentityDirectory } from "../../application/identity/identity-directory";
import type { DemoPersona } from "../../application/identity/demo-session";
import type { Actor, Capability, EventAccess } from "../../application/identity/actor";

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
}

const eventCapabilities: Record<EventAccess["role"], readonly Capability[]> = {
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

  private async resolve(user: UserRow): Promise<Actor> {
    const [organizations, roles] = await Promise.all([
      this.database
        .prepare(
          "SELECT organization_id FROM organization_memberships WHERE user_id = ? AND role = 'organizer' ORDER BY organization_id",
        )
        .bind(user.id)
        .all<MembershipRow>(),
      this.database
        .prepare("SELECT event_id, role FROM event_roles WHERE user_id = ? ORDER BY event_id, role")
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
    const eventAccess = (roles.results ?? []).map((role) => ({
      eventId: role.event_id,
      role: role.role,
      capabilities: new Set(eventCapabilities[role.role]),
    }));
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
    const result = await this.database
      .prepare(
        "INSERT OR IGNORE INTO event_roles (event_id, user_id, role) VALUES (?, ?, 'organizer')",
      )
      .bind(eventId, userId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to grant event organizer: ${result.error ?? "unknown error"}`);
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
