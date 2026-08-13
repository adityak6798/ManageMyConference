/**
 * Organization-scoped machine credentials.
 *
 * The hot authentication path is read-only: there is intentionally no `last_used_at`. Writing
 * one on every authenticated read would turn all API traffic into D1 write traffic. Revocation,
 * expiry, creator grants, scopes, and event allowlists are instead re-read on every request.
 *
 * @spec PRD-IAM-001 PRD-IAM-002 ARC-AUTH-001
 */
import { type Actor, type Capability, CapabilityDeniedError, requireCapability } from "./actor";
import type { AuditContext } from "./audit";
import { isDemoPersonaId } from "./demo-session";

export interface ApiClientRecord {
  id: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  secretHash: string;
  previousSecretHash: string | null;
  previousSecretExpiresAt: number | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  scopes: readonly Capability[];
  eventIds: readonly string[];
}

export type PublicApiClient = Omit<
  ApiClientRecord,
  "secretHash" | "previousSecretHash" | "previousSecretExpiresAt"
>;

export interface ApiClientRepository {
  findByPrefix(prefix: string): Promise<ApiClientRecord | null>;
  list(organizationId: string): Promise<readonly ApiClientRecord[]>;
  create(client: ApiClientRecord, context: AuditContext): Promise<void>;
  rotate(input: {
    organizationId: string;
    clientId: string;
    secretHash: string;
    overlapExpiresAt: number;
    now: number;
    context: AuditContext;
  }): Promise<number>;
  revoke(input: {
    organizationId: string;
    clientId: string;
    now: number;
    context: AuditContext;
  }): Promise<number>;
}

export interface ApiClientEventDirectory {
  listEventIdsInOrganization(
    organizationId: string,
    candidateIds: readonly string[],
  ): Promise<readonly string[]>;
}

export class ApiClientNotFoundError extends Error {}
export class ApiClientConflictError extends Error {}
export class ApiClientInputError extends Error {}

const ROTATION_OVERLAP_MS = 86_400_000;
const CAPABILITIES: ReadonlySet<string> = new Set<Capability>([
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
  "review:evaluate",
  "identity:manage",
]);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export async function hashApiClientSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mintApiClientCredential(): Promise<{
  credential: string;
  prefix: string;
  secretHash: string;
}> {
  const prefix = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return {
    credential: `grn_${prefix}.${secret}`,
    prefix,
    secretHash: await hashApiClientSecret(secret),
  };
}

export function parseApiClientCredential(
  credential: string,
): { prefix: string; secret: string } | null {
  const match = credential.match(/^grn_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/);
  const prefix = match?.[1];
  const secret = match?.[2];
  return prefix && secret ? { prefix, secret } : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1)
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export class ApiClientResolver {
  constructor(
    private readonly dependencies: {
      repository: ApiClientRepository;
      resolveCreator(userId: string): Promise<Actor | null>;
      events: ApiClientEventDirectory;
      now: () => number;
    },
  ) {}

  async resolve(credential: string): Promise<Actor | null> {
    const parsed = parseApiClientCredential(credential);
    if (!parsed) return null;
    const client = await this.dependencies.repository.findByPrefix(parsed.prefix);
    if (!client || client.revokedAt !== null) return null;
    const now = this.dependencies.now();
    if (client.expiresAt !== null && client.expiresAt <= now) return null;
    const presentedHash = await hashApiClientSecret(parsed.secret);
    const currentMatches = constantTimeEqual(presentedHash, client.secretHash);
    const previousMatches =
      client.previousSecretHash !== null &&
      client.previousSecretExpiresAt !== null &&
      client.previousSecretExpiresAt > now &&
      constantTimeEqual(presentedHash, client.previousSecretHash);
    if (!currentMatches && !previousMatches) return null;

    const creator = await this.dependencies.resolveCreator(client.createdBy);
    if (!creator?.organizations.some(({ id }) => id === client.organizationId)) return null;
    const organizationEventIds = new Set(
      await this.dependencies.events.listEventIdsInOrganization(
        client.organizationId,
        client.eventIds,
      ),
    );
    const allowedEvents = new Set(client.eventIds.filter((id) => organizationEventIds.has(id)));
    const scopes = new Set(client.scopes);
    const organizationCapabilities = new Set<Capability>();
    if (scopes.has("events:create") && creator.capabilities.has("events:create"))
      organizationCapabilities.add("events:create");
    const eventAccess = creator.eventAccess
      .filter(({ eventId }) => allowedEvents.has(eventId))
      .map((access) => ({
        ...access,
        capabilities: new Set([...access.capabilities].filter((value) => scopes.has(value))),
      }));
    const capabilities = new Set<Capability>();
    for (const capability of organizationCapabilities) capabilities.add(capability);
    for (const access of eventAccess)
      for (const capability of access.capabilities) capabilities.add(capability);
    return {
      id: client.id,
      name: client.name,
      persona: creator.persona,
      organizations: [{ id: client.organizationId }],
      organizationAccess: [{ id: client.organizationId, capabilities: organizationCapabilities }],
      roleGrantSubjectId: creator.id,
      eventAccess,
      capabilities,
    };
  }
}

export class ApiClientService {
  constructor(
    private readonly dependencies: {
      repository: ApiClientRepository;
      events: ApiClientEventDirectory;
      newId: () => string;
      now: () => number;
      mintCredential: typeof mintApiClientCredential;
    },
  ) {}

  private async requireOrganization(actor: Actor | null, organizationId: string): Promise<Actor> {
    const authorized = requireCapability(actor, "identity:manage");
    if (isDemoPersonaId(authorized.id))
      throw new CapabilityDeniedError("A demo persona cannot administer API clients");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const candidates = authorized.eventAccess
      .filter(({ capabilities }) => capabilities.has("identity:manage"))
      .map(({ eventId }) => eventId);
    if (
      (await this.dependencies.events.listEventIdsInOrganization(organizationId, candidates))
        .length === 0
    )
      throw new CapabilityDeniedError("Actor lacks identity:manage inside this organization");
    return authorized;
  }

  async create(
    actor: Actor | null,
    organizationId: string,
    command: {
      name: string;
      scopes: readonly Capability[];
      eventIds: readonly string[];
      expiresAt?: number | undefined;
    },
    context: AuditContext,
  ): Promise<{ client: PublicApiClient; credential: string }> {
    const authorized = await this.requireOrganization(actor, organizationId);
    const now = this.dependencies.now();
    if (command.expiresAt !== undefined && command.expiresAt <= now)
      throw new ApiClientInputError("Expiry must be in the future");
    if (command.scopes.some((scope) => !CAPABILITIES.has(scope)))
      throw new ApiClientInputError("Unknown capability scope");
    if (command.scopes.some((scope) => !authorized.capabilities.has(scope)))
      throw new CapabilityDeniedError("A client cannot receive a capability its creator lacks");
    const creatorEvents = new Set(authorized.eventAccess.map(({ eventId }) => eventId));
    if (command.eventIds.some((eventId) => !creatorEvents.has(eventId)))
      throw new CapabilityDeniedError("A client cannot receive an event its creator cannot access");
    const organizationEvents = new Set(
      await this.dependencies.events.listEventIdsInOrganization(organizationId, command.eventIds),
    );
    if (command.eventIds.some((eventId) => !organizationEvents.has(eventId)))
      throw new CapabilityDeniedError("An event is outside this organization");
    const minted = await this.dependencies.mintCredential();
    const client: ApiClientRecord = {
      id: this.dependencies.newId(),
      organizationId,
      name: command.name.trim(),
      keyPrefix: minted.prefix,
      secretHash: minted.secretHash,
      previousSecretHash: null,
      previousSecretExpiresAt: null,
      createdBy: authorized.id,
      createdAt: now,
      expiresAt: command.expiresAt ?? null,
      revokedAt: null,
      scopes: [...new Set(command.scopes)],
      eventIds: [...new Set(command.eventIds)],
    };
    await this.dependencies.repository.create(client, context);
    return { client: publicClient(client), credential: minted.credential };
  }

  async list(actor: Actor | null, organizationId: string): Promise<readonly PublicApiClient[]> {
    await this.requireOrganization(actor, organizationId);
    return (await this.dependencies.repository.list(organizationId)).map(publicClient);
  }

  async rotate(
    actor: Actor | null,
    organizationId: string,
    clientId: string,
    context: AuditContext,
  ): Promise<{ credential: string; previousCredentialExpiresAt: number }> {
    await this.requireOrganization(actor, organizationId);
    const now = this.dependencies.now();
    const minted = await this.dependencies.mintCredential();
    const overlapExpiresAt = now + ROTATION_OVERLAP_MS;
    const changed = await this.dependencies.repository.rotate({
      organizationId,
      clientId,
      secretHash: minted.secretHash,
      overlapExpiresAt,
      now,
      context,
    });
    if (changed === 0) throw new ApiClientNotFoundError("API client not found or inactive");
    return { credential: minted.credential, previousCredentialExpiresAt: overlapExpiresAt };
  }

  async revoke(
    actor: Actor | null,
    organizationId: string,
    clientId: string,
    context: AuditContext,
  ): Promise<void> {
    await this.requireOrganization(actor, organizationId);
    const changed = await this.dependencies.repository.revoke({
      organizationId,
      clientId,
      now: this.dependencies.now(),
      context,
    });
    if (changed === 0)
      throw new ApiClientConflictError("API client is already revoked or not yours");
  }
}

const publicClient = (client: ApiClientRecord): PublicApiClient => {
  const {
    secretHash: _secret,
    previousSecretHash: _previous,
    previousSecretExpiresAt: _until,
    ...safe
  } = client;
  return safe;
};
