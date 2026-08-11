import type { Actor } from "./actor";
import type { DemoPersona } from "./demo-session";

// @spec PRD-IAM-001 PRD-IAM-002
export interface IdentityDirectory {
  findByPersona(persona: DemoPersona): Promise<Actor | null>;
  isReviewerForEvent(userId: string, eventId: string): Promise<boolean>;
  isSpeakerForEvent(userId: string, eventId: string): Promise<boolean>;
  listReviewersForEvent(eventId: string): Promise<readonly { id: string; name: string }[]>;
  grantOrganizer(eventId: string, userId: string): Promise<void>;
  provisionSpeaker(userId: string, name: string, eventId: string): Promise<void>;
}
