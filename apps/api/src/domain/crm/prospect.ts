export const prospectStages = [
  "identified",
  "contacted",
  "engaged",
  "invited",
  "converted",
] as const;
export type ProspectStage = (typeof prospectStages)[number];

export interface ProspectContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly isPrimary: boolean;
}

export interface ProspectActivity {
  readonly id: string;
  readonly kind: "note" | "email" | "call" | "meeting" | "stage-change" | "conversion";
  readonly summary: string;
  readonly private: boolean;
  readonly occurredAt: string;
  readonly actorId: string;
}

// @spec PRD-CRM-001
export interface Prospect {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly stage: ProspectStage;
  readonly ownerId: string;
  readonly nextAction: string | null;
  readonly nextActionAt: string | null;
  readonly contacts: readonly ProspectContact[];
  readonly activities: readonly ProspectActivity[];
  readonly speakerId: string | null;
  readonly convertedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
