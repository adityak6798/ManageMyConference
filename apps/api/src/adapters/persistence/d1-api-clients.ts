/** D1 persistence for identity-owned API clients. No authentication read writes usage state. */
import type { Capability } from "../../application/identity/actor";
import type { ApiClientRecord, ApiClientRepository } from "../../application/identity/api-clients";
import type { AuditContext } from "../../application/identity/audit";
import { type AuditDatabasePort, auditEventStatement } from "./d1-identity-audit";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface Statement {
  bind(...values: unknown[]): Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface ApiClientDatabasePort extends AuditDatabasePort {
  prepare(query: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface ClientRow {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: number | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

interface ClientScopeRow {
  client_id: string;
  capability: Capability;
}

interface ClientEventRow {
  client_id: string;
  event_id: string;
}

const SELECT_CLIENT =
  "SELECT id, organization_id, name, key_prefix, secret_hash, previous_secret_hash, " +
  "previous_secret_expires_at, created_by, created_at, expires_at, revoked_at FROM api_clients";

export class D1ApiClientRepository implements ApiClientRepository {
  constructor(private readonly database: ApiClientDatabasePort) {}

  async findByPrefix(prefix: string): Promise<ApiClientRecord | null> {
    const found = await this.database
      .prepare(`${SELECT_CLIENT} WHERE key_prefix = ?`)
      .bind(prefix)
      .all<ClientRow>();
    this.assertRead(found, "find an API client");
    const row = found.results?.[0];
    return row ? this.hydrate(row) : null;
  }

  async findKeyPrefix(organizationId: string, clientId: string): Promise<string | null> {
    const found = await this.database
      .prepare("SELECT key_prefix FROM api_clients WHERE organization_id = ? AND id = ?")
      .bind(organizationId, clientId)
      .all<{ key_prefix: string }>();
    this.assertRead(found, "find an API client prefix");
    return found.results?.[0]?.key_prefix ?? null;
  }

  async findRevocationState(
    organizationId: string,
    clientId: string,
  ): Promise<{ revokedAt: number | null } | null> {
    const found = await this.database
      .prepare("SELECT revoked_at FROM api_clients WHERE organization_id = ? AND id = ?")
      .bind(organizationId, clientId)
      .all<{ revoked_at: number | null }>();
    this.assertRead(found, "find API client revocation state");
    const row = found.results?.[0];
    return row ? { revokedAt: row.revoked_at } : null;
  }

  async list(organizationId: string): Promise<readonly ApiClientRecord[]> {
    const found = await this.database
      .prepare(`${SELECT_CLIENT} WHERE organization_id = ? ORDER BY created_at DESC, id`)
      .bind(organizationId)
      .all<ClientRow>();
    this.assertRead(found, "list API clients");
    return this.hydrateMany(found.results ?? []);
  }

  async create(client: ApiClientRecord, context: AuditContext): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO api_clients (id, organization_id, name, key_prefix, secret_hash, previous_secret_hash, previous_secret_expires_at, created_by, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          client.id,
          client.organizationId,
          client.name,
          client.keyPrefix,
          client.secretHash,
          null,
          null,
          client.createdBy,
          client.createdAt,
          client.expiresAt,
          null,
        ),
      this.database
        .prepare(
          "INSERT INTO api_client_scopes (client_id, capability) SELECT ?, value FROM json_each(?)",
        )
        .bind(client.id, JSON.stringify(client.scopes)),
      this.database
        .prepare(
          "INSERT INTO api_client_events (client_id, event_id) SELECT ?, value FROM json_each(?)",
        )
        .bind(client.id, JSON.stringify(client.eventIds)),
      auditEventStatement(
        this.database,
        {
          action: "api_client.created",
          outcome: "succeeded",
          occurredAt: client.createdAt,
          organizationId: client.organizationId,
          detail: {
            clientId: client.id,
            name: client.name,
            scopes: client.scopes,
            eventIds: client.eventIds,
            expiresAt: client.expiresAt,
          },
        },
        context,
      ),
    ]);
    this.assertBatch(results, "create an API client");
  }

  async rotate(input: {
    organizationId: string;
    clientId: string;
    secretHash: string;
    overlapExpiresAt: number;
    now: number;
    context: AuditContext;
  }): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE api_clients SET previous_secret_hash = secret_hash, previous_secret_expires_at = ?, secret_hash = ? " +
            "WHERE id = ? AND organization_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .bind(
          input.overlapExpiresAt,
          input.secretHash,
          input.clientId,
          input.organizationId,
          input.now,
        ),
      auditEventStatement(
        this.database,
        {
          action: "api_client.rotated",
          outcome: "succeeded",
          occurredAt: input.now,
          organizationId: input.organizationId,
          detail: { clientId: input.clientId, overlapExpiresAt: input.overlapExpiresAt },
        },
        input.context,
        { onlyWhenChanged: true },
      ),
    ]);
    this.assertBatch(results, "rotate an API client");
    const write = results[0];
    if (!write) throw new Error("D1 returned no result while attempting to rotate an API client");
    return changedRows(write, "rotate an API client");
  }

  async revoke(input: {
    organizationId: string;
    clientId: string;
    now: number;
    context: AuditContext;
  }): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "UPDATE api_clients SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL",
        )
        .bind(input.now, input.clientId, input.organizationId),
      auditEventStatement(
        this.database,
        {
          action: "api_client.revoked",
          outcome: "succeeded",
          occurredAt: input.now,
          organizationId: input.organizationId,
          detail: { clientId: input.clientId },
        },
        input.context,
        { onlyWhenChanged: true },
      ),
    ]);
    this.assertBatch(results, "revoke an API client");
    const write = results[0];
    if (!write) throw new Error("D1 returned no result while attempting to revoke an API client");
    return changedRows(write, "revoke an API client");
  }

  private async hydrate(row: ClientRow): Promise<ApiClientRecord> {
    const [scopes, events] = await Promise.all([
      this.database
        .prepare("SELECT capability FROM api_client_scopes WHERE client_id = ? ORDER BY capability")
        .bind(row.id)
        .all<{ capability: Capability }>(),
      this.database
        .prepare("SELECT event_id FROM api_client_events WHERE client_id = ? ORDER BY event_id")
        .bind(row.id)
        .all<{ event_id: string }>(),
    ]);
    this.assertRead(scopes, "load API client scopes");
    this.assertRead(events, "load API client events");
    return this.toRecord(
      row,
      (scopes.results ?? []).map(({ capability }) => capability),
      (events.results ?? []).map(({ event_id }) => event_id),
    );
  }

  private async hydrateMany(rows: readonly ClientRow[]): Promise<readonly ApiClientRecord[]> {
    if (rows.length === 0) return [];
    const clientIds = rows.map(({ id }) => id);
    const [scopes, events] = await Promise.all([
      this.database
        .prepare(
          "SELECT client_id, capability FROM api_client_scopes " +
            "WHERE client_id IN (SELECT value FROM json_each(?)) ORDER BY client_id, capability",
        )
        .bind(JSON.stringify(clientIds))
        .all<ClientScopeRow>(),
      this.database
        .prepare(
          "SELECT client_id, event_id FROM api_client_events " +
            "WHERE client_id IN (SELECT value FROM json_each(?)) ORDER BY client_id, event_id",
        )
        .bind(JSON.stringify(clientIds))
        .all<ClientEventRow>(),
    ]);
    this.assertRead(scopes, "load API client scopes");
    this.assertRead(events, "load API client events");

    const scopesByClient = new Map<string, Capability[]>();
    for (const { client_id: clientId, capability } of scopes.results ?? []) {
      const values = scopesByClient.get(clientId) ?? [];
      values.push(capability);
      scopesByClient.set(clientId, values);
    }
    const eventsByClient = new Map<string, string[]>();
    for (const { client_id: clientId, event_id: eventId } of events.results ?? []) {
      const values = eventsByClient.get(clientId) ?? [];
      values.push(eventId);
      eventsByClient.set(clientId, values);
    }
    return rows.map((row) =>
      this.toRecord(row, scopesByClient.get(row.id) ?? [], eventsByClient.get(row.id) ?? []),
    );
  }

  private toRecord(
    row: ClientRow,
    scopes: readonly Capability[],
    eventIds: readonly string[],
  ): ApiClientRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      secretHash: row.secret_hash,
      previousSecretHash: row.previous_secret_hash,
      previousSecretExpiresAt: row.previous_secret_expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      scopes,
      eventIds,
    };
  }

  private assertRead(result: { success: boolean; error?: string }, operation: string): void {
    if (!result.success)
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
  }

  private assertBatch(results: readonly D1WriteResult[], operation: string): void {
    const failed = results.find((result) => !result.success);
    if (failed) throw new Error(`D1 failed to ${operation}: ${failed.error ?? "unknown error"}`);
  }
}
