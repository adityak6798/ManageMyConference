import type {
  SpeakerConversionCommand,
  SpeakerConversionPort,
} from "../../application/content/speaker-conversion";
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
}
// @spec ARC-FLOW-003 PRD-SPK-001
export class D1SpeakerConversion implements SpeakerConversionPort {
  constructor(
    private readonly database: D1DatabasePort,
    private readonly newId: () => string,
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
    const candidate = this.newId();
    const result = await this.database
      .prepare("INSERT OR IGNORE INTO speaker_profiles (id,event_id,name,email) VALUES (?,?,?,?)")
      .bind(candidate, command.eventId, command.name, command.email)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to convert speaker: ${result.error ?? "unknown error"}`);
    const created = await this.database
      .prepare("SELECT id FROM speaker_profiles WHERE event_id=? AND email=? LIMIT 1")
      .bind(command.eventId, command.email)
      .all<SpeakerRow>();
    const speakerId = created.results?.[0]?.id;
    if (!speakerId) throw new Error("D1 conversion did not produce a speaker");
    const linked = await this.database
      .prepare(
        "INSERT OR IGNORE INTO speaker_conversion_sources (event_id,source_kind,source_id,speaker_id) VALUES (?,?,?,?)",
      )
      .bind(command.eventId, command.source.kind, command.source.id, speakerId)
      .run();
    if (!linked.success)
      throw new Error(`D1 failed to link speaker provenance: ${linked.error ?? "unknown error"}`);
    return { speakerId };
  }
}
