import type {
  SpeakerConversionCommand,
  SpeakerConversionPort,
} from "../../application/content/speaker-conversion";
import type { IdentityDirectory } from "../../application/identity/identity-directory";
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
interface D1DatabasePort {
  prepare(query: string): D1Statement;
}

interface SpeakerRow {
  id: string;
  user_id?: string;
}
interface ClaimRow {
  normalized_email: string;
  speaker_id: string;
  user_id: string;
}
// @spec ARC-FLOW-003 PRD-SPK-001
export class D1SpeakerConversion implements SpeakerConversionPort {
  constructor(
    private readonly database: D1DatabasePort,
    private readonly newId: () => string,
    private readonly identities: Pick<IdentityDirectory, "provisionSpeaker">,
  ) {}
  async createOrLink(command: SpeakerConversionCommand) {
    const existing = await this.database
      .prepare(
        "SELECT speaker_id AS id FROM speaker_conversion_sources WHERE event_id=? AND source_kind=? AND source_id=? LIMIT 1",
      )
      .bind(command.eventId, command.source.kind, command.source.id)
      .all<SpeakerRow>();
    if (!existing.success) throw new Error("D1 failed to resolve speaker provenance");
    if (existing.results?.[0]) return { speakerId: existing.results[0].id };
    const normalizedEmail = command.email.trim().toLowerCase();
    const candidateSpeakerId = this.newId();
    const candidateUserId = this.newId();
    // ERROR-INTENT: a source conflict means another caller already chose this conversion's durable claim.
    const sourceClaimResult = await this.database
      .prepare(
        "INSERT OR IGNORE INTO speaker_conversion_claims (event_id,source_kind,source_id,normalized_email,speaker_id,user_id) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        command.eventId,
        command.source.kind,
        command.source.id,
        normalizedEmail,
        candidateSpeakerId,
        candidateUserId,
      )
      .run();
    if (!sourceClaimResult.success) throw new Error("D1 failed to claim speaker conversion");
    const sourceClaims = await this.database
      .prepare(
        "SELECT normalized_email,speaker_id,user_id FROM speaker_conversion_claims WHERE event_id=? AND source_kind=? AND source_id=? LIMIT 1",
      )
      .bind(command.eventId, command.source.kind, command.source.id)
      .all<ClaimRow>();
    const sourceClaim = sourceClaims.results?.[0];
    if (!sourceClaims.success || !sourceClaim)
      throw new Error("D1 conversion claim was not durable");
    const matching = await this.database
      .prepare(
        "SELECT id,user_id FROM speaker_profiles WHERE event_id=? AND lower(email)=? ORDER BY id LIMIT 1",
      )
      .bind(command.eventId, sourceClaim.normalized_email)
      .all<SpeakerRow>();
    if (!matching.success) throw new Error("D1 failed to match an existing speaker");
    const matched = matching.results?.[0];
    const claimedSpeakerId = matched?.id ?? sourceClaim.speaker_id;
    const claimedUserId = matched?.user_id ?? sourceClaim.user_id;
    // ERROR-INTENT: an email conflict means another source already claimed the canonical event speaker.
    const emailClaimResult = await this.database
      .prepare(
        "INSERT OR IGNORE INTO speaker_email_claims (event_id,normalized_email,speaker_id,user_id) VALUES (?,?,?,?)",
      )
      .bind(command.eventId, sourceClaim.normalized_email, claimedSpeakerId, claimedUserId)
      .run();
    if (!emailClaimResult.success) throw new Error("D1 failed to claim canonical speaker email");
    const emailClaims = await this.database
      .prepare(
        "SELECT normalized_email,speaker_id,user_id FROM speaker_email_claims WHERE event_id=? AND normalized_email=? LIMIT 1",
      )
      .bind(command.eventId, sourceClaim.normalized_email)
      .all<ClaimRow>();
    const canonicalClaim = emailClaims.results?.[0];
    if (!emailClaims.success || !canonicalClaim)
      throw new Error("D1 speaker email claim was not durable");
    const aligned = await this.database
      .prepare(
        "UPDATE speaker_conversion_claims SET speaker_id=?,user_id=? WHERE event_id=? AND source_kind=? AND source_id=?",
      )
      .bind(
        canonicalClaim.speaker_id,
        canonicalClaim.user_id,
        command.eventId,
        command.source.kind,
        command.source.id,
      )
      .run();
    if (!aligned.success) throw new Error("D1 failed to align conversion claims");
    await this.identities.provisionSpeaker(canonicalClaim.user_id, command.name, command.eventId);
    // ERROR-INTENT: the canonical ID/source conflict means a concurrent caller already created this profile.
    const profile = await this.database
      .prepare(
        "INSERT OR IGNORE INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES (?,?,?,?,?,?,?,?,?,NULL)",
      )
      .bind(
        canonicalClaim.speaker_id,
        command.eventId,
        canonicalClaim.user_id,
        `crm-email:${canonicalClaim.normalized_email}`,
        command.name,
        canonicalClaim.normalized_email,
        "",
        "",
        "",
      )
      .run();
    if (!profile.success)
      throw new Error(`D1 failed to convert speaker: ${profile.error ?? "unknown error"}`);
    const speakerId = canonicalClaim.speaker_id;
    // ERROR-INTENT: a provenance conflict means a concurrent conversion already established the canonical link.
    const linked = await this.database
      .prepare(
        "INSERT OR IGNORE INTO speaker_conversion_sources (event_id,source_kind,source_id,speaker_id) VALUES (?,?,?,?)",
      )
      .bind(command.eventId, command.source.kind, command.source.id, speakerId)
      .run();
    if (!linked.success)
      throw new Error(`D1 failed to link speaker provenance: ${linked.error ?? "unknown error"}`);
    const canonical = await this.database
      .prepare(
        "SELECT speaker_id AS id FROM speaker_conversion_sources WHERE event_id=? AND source_kind=? AND source_id=? LIMIT 1",
      )
      .bind(command.eventId, command.source.kind, command.source.id)
      .all<SpeakerRow>();
    const canonicalSpeakerId = canonical.results?.[0]?.id;
    if (!canonical.success || !canonicalSpeakerId)
      throw new Error("D1 conversion did not persist speaker provenance");
    return { speakerId: canonicalSpeakerId };
  }
}
