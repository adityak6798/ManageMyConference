/**
 * Where a speaker came from. CRM conversion (`ARC-FLOW-003`) and CFP acceptance
 * (`ARC-FLOW-001`) are the two doors into an event's speaker roster; both land on the same
 * profile when they name the same address, which is what `PRD-SPK-001`'s "one event-scoped
 * speaker profile" means in practice.
 */
export type SpeakerConversionSourceKind = "crm-prospect" | "cfp-proposal" | "csv";

export interface SpeakerConversionCommand {
  readonly eventId: string;
  readonly source: { readonly kind: SpeakerConversionSourceKind; readonly id: string };
  readonly name: string;
  readonly email: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

// Content owns the implementation and public speaker shape. CRM only invokes this command.
export interface SpeakerConversionPort {
  createOrLink(command: SpeakerConversionCommand): Promise<{ readonly speakerId: string }>;
}
