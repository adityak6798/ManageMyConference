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
}
export interface IdentityDatabasePort {
  prepare(query: string): D1Statement;
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
  organizer: ["events:read", "events:settings:read", "events:settings:update"],
  reviewer: ["events:read"],
  speaker: ["events:read"],
  public: [],
};

// @spec PRD-IAM-001 PRD-EVT-001
export class D1IdentityDirectory implements IdentityDirectory {
  constructor(private readonly database: IdentityDatabasePort) {}

  async findByPersona(persona: DemoPersona): Promise<Actor | null> {
    const users = await this.database
      .prepare("SELECT id, name, persona FROM users WHERE persona = ? ORDER BY id LIMIT 2")
      .bind(persona)
      .all<UserRow>();
    if (!users.success)
      throw new Error(`D1 failed to resolve identity: ${users.error ?? "unknown error"}`);
    if (!users.results?.length) return null;
    if (users.results.length !== 1) throw new Error(`Demo persona ${persona} is not unique`);
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
      capabilities.add("communications:manage");
    }
    if (eventAccess.some(({ capabilities: assigned }) => assigned.has("events:read"))) {
      capabilities.add("events:read");
    }
    return {
      id: user.id,
      name: user.name,
      persona: user.persona,
      organizations: organizationList,
      eventAccess,
      capabilities,
    };
  }
}
