/**
 * `CapabilityLinkStore` against D1 — the one table every anonymous share link in this product
 * addresses a resource through.
 *
 * `spend` is the whole reason this is an adapter rather than three statements at a call site.
 * Every liveness condition is in one `UPDATE … RETURNING`: not revoked, not expired, and either
 * unlimited or with a view left. A read followed by a write would let two concurrent resolves of
 * a one-view link both pass the test before either wrote, and there is no arrangement of two
 * statements that fixes it.
 *
 * A link that fails any condition matches no row, which is one indistinguishable refusal — a
 * caller cannot tell an expired link from an unknown one, and neither can a scanner.
 *
 * @spec PRD-OPS-004 ARC-003
 */
import type {
  CapabilityLink,
  CapabilityLinkKind,
  CapabilityLinkStore,
} from "../../application/platform/capability-link";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface CapabilityLinkDatabasePort {
  prepare(query: string): D1Statement;
}

interface LinkRow {
  id: string;
  resource_kind: CapabilityLinkKind;
  resource_ref: string;
  organization_id: string;
  event_id: string;
  password_hash: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  view_limit: number | null;
  views: number;
  revoked_at: string | null;
  scope_json: string;
}

const COLUMNS =
  "id, resource_kind, resource_ref, organization_id, event_id, password_hash, created_by, created_at, expires_at, view_limit, views, revoked_at, scope_json";

const toLink = (row: LinkRow): CapabilityLink => ({
  id: row.id,
  kind: row.resource_kind,
  resourceRef: row.resource_ref,
  organizationId: row.organization_id,
  eventId: row.event_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  viewLimit: row.view_limit,
  views: row.views,
  revokedAt: row.revoked_at,
  hasPassword: row.password_hash !== null,
  scope: JSON.parse(row.scope_json) as Record<string, unknown>,
});

export class D1CapabilityLinkStore implements CapabilityLinkStore {
  constructor(private readonly database: CapabilityLinkDatabasePort) {}

  private async rows<T>(query: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<T>();
    if (!result.success)
      throw new Error(`D1 failed to read capability links: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  async create(
    link: CapabilityLink & { tokenHash: string; passwordHash: string | null },
  ): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO capability_links (id, resource_kind, resource_ref, organization_id, event_id, token_hash, password_hash, created_by, created_at, expires_at, view_limit, views, revoked_at, scope_json) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        link.id,
        link.kind,
        link.resourceRef,
        link.organizationId,
        link.eventId,
        link.tokenHash,
        link.passwordHash,
        link.createdBy,
        link.createdAt,
        link.expiresAt,
        link.viewLimit,
        link.views,
        link.revokedAt,
        JSON.stringify(link.scope),
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create a capability link: ${result.error ?? "unknown error"}`);
  }

  async list(kind: CapabilityLinkKind, resourceRef: string): Promise<readonly CapabilityLink[]> {
    return (
      await this.rows<LinkRow>(
        `SELECT ${COLUMNS} FROM capability_links WHERE resource_kind = ? AND resource_ref = ? ORDER BY created_at DESC, id`,
        kind,
        resourceRef,
      )
    ).map(toLink);
  }

  async revoke(
    kind: CapabilityLinkKind,
    resourceRef: string,
    linkId: string,
    at: string,
  ): Promise<number> {
    const result = await this.database
      .prepare(
        "UPDATE capability_links SET revoked_at = ? WHERE id = ? AND resource_kind = ? AND resource_ref = ? AND revoked_at IS NULL",
      )
      .bind(at, linkId, kind, resourceRef)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to revoke a capability link: ${result.error ?? "unknown error"}`);
    return changedRows(result, "revoke a capability link");
  }

  async spend(
    tokenHash: string,
    now: string,
  ): Promise<{ link: CapabilityLink; passwordHash: string | null } | null> {
    const spent = await this.rows<LinkRow>(
      "UPDATE capability_links SET views = views + 1 " +
        "WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? " +
        "AND (view_limit IS NULL OR views < view_limit) " +
        `RETURNING ${COLUMNS}`,
      tokenHash,
      now,
    );
    const row = spent[0];
    return row ? { link: toLink(row), passwordHash: row.password_hash } : null;
  }
}
