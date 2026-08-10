export type Capability = "events:read" | "events:create";

export interface Actor {
  readonly id: string;
  readonly persona: "organizer" | "reviewer" | "speaker";
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
