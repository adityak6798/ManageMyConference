import type { Actor } from "./actor";
import type { DemoPersona } from "./demo-session";

// @spec PRD-IAM-001 PRD-IAM-002
export interface IdentityDirectory {
  findByPersona(persona: DemoPersona): Promise<Actor | null>;
  isReviewerForEvent(userId: string, eventId: string): Promise<boolean>;
}
