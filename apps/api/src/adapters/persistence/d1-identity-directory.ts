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
  constructor(private readonly database: IdentityDatabasePort) {}

  async findByPersona(persona: DemoPersona): Promise<Actor | null> {
    const users = await this.database
      .prepare("SELECT id, name, persona FROM users WHERE id = ? AND persona = ? LIMIT 1")
      .bind(`seed-${persona}`, persona)
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve identity: ${users.error ?? "unknown error"}`);
    if (!users.results?.length) return null;
    const user = users.results[0];
    if (!user) return null;

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
