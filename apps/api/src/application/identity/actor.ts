export type Capability =
  | "events:read"
  | "events:create"
  | "events:settings:read"
  | "events:settings:update"
  | "agenda:manage"
  | "crm:manage"
  | "content:read"
  | "content:manage"
  | "review:manage"
  | "review:evaluate";

export interface EventAccess {
  readonly eventId: string;
  readonly role: "organizer" | "reviewer" | "speaker" | "public";
  readonly capabilities: ReadonlySet<Capability>;
}

export interface Actor {
  readonly id: string;
  readonly name: string;
  readonly persona: "organizer" | "reviewer" | "speaker" | "public";
  readonly organizations: readonly { id: string }[];
  readonly eventAccess: readonly EventAccess[];
  readonly capabilities: ReadonlySet<Capability>;
}

export class AuthenticationRequiredError extends Error {}
export class CapabilityDeniedError extends Error {}

export function requireCapability(actor: Actor | null, capability: Capability): Actor {
  if (!actor) throw new AuthenticationRequiredError("Authentication is required");
  if (!actor.capabilities.has(capability)) {
    throw new CapabilityDeniedError(`Actor lacks ${capability}`);
  }
  return actor;
}

export function requireEventCapability(
  actor: Actor | null,
  eventId: string,
  capability: Capability,
): Actor {
  if (!actor) throw new AuthenticationRequiredError("Authentication is required");
  const authorized = actor.eventAccess.some(
    (candidate) => candidate.eventId === eventId && candidate.capabilities.has(capability),
  );
  if (!authorized) {
    throw new CapabilityDeniedError(`Actor lacks ${capability} for event`);
  }
  return actor;
}
