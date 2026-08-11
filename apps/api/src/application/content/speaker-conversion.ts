export interface SpeakerConversionCommand {
  readonly eventId: string;
  readonly source: { readonly kind: "crm-prospect"; readonly id: string };
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
