import {
  type ContentRepository,
  type AcceptedContent,
  ContentConflictError,
} from "../../application/content/content-repository";
import type {
  SpeakerConversionCommand,
  SpeakerConversionPort,
} from "../../application/content/speaker-conversion";
import type {
  ContentWorkspace,
  SpeakerAsset,
  SpeakerProfile,
  SpeakerTask,
} from "../../domain/content/content";

export class MemoryContentRepository implements ContentRepository {
  private sessions: ContentWorkspace["sessions"] = [];
  private speakers: ContentWorkspace["speakers"] = [];
  private tasks: ContentWorkspace["tasks"] = [];
  private assets: ContentWorkspace["assets"] = [];
  private messages: ContentWorkspace["messages"] = [];

  constructor(seed?: ContentWorkspace) {
    if (seed)
      ({
        sessions: this.sessions,
        speakers: this.speakers,
        tasks: this.tasks,
        assets: this.assets,
        messages: this.messages,
      } = seed);
  }
  async findSessionByProposal(eventId: string, proposalId: string) {
    return (
      this.sessions.find((item) => item.eventId === eventId && item.proposalId === proposalId) ??
      null
    );
  }
  async accept(content: AcceptedContent) {
    // Mirrors `UNIQUE(event_id, proposal_id)` in D1 so acceptance idempotency is exercised here
    // and not only against a real database.
    if (await this.findSessionByProposal(content.session.eventId, content.session.proposalId))
      throw new ContentConflictError("UNIQUE constraint failed: content_sessions.proposal_id");
    this.sessions = [...this.sessions, content.session];
    this.speakers = [...this.speakers, ...content.speakers];
    this.tasks = [...this.tasks, ...content.tasks];
    this.messages = [...this.messages, ...content.messages];
  }
  /** Out-of-band profile creation, the way `SpeakerConversionPort` writes one in D1. */
  async addProfile(profile: SpeakerProfile) {
    this.speakers = [...this.speakers, profile];
  }
  async workspace(eventId: string, userId?: string): Promise<ContentWorkspace> {
    const speakers = this.speakers.filter(
      (item) => item.eventId === eventId && (!userId || item.userId === userId),
    );
    const profileIds = new Set(speakers.map(({ id }) => id));
    const sessions = this.sessions.filter(
      (item) =>
        item.eventId === eventId &&
        (!userId || item.speakerProfileIds.some((id) => profileIds.has(id))),
    );
    return {
      sessions,
      speakers,
      tasks: this.tasks.filter((item) => profileIds.has(item.speakerProfileId)),
      assets: this.assets.filter((item) => profileIds.has(item.speakerProfileId)),
      messages: this.messages.filter((item) => profileIds.has(item.speakerProfileId)),
    };
  }
  async updateProfile(profile: SpeakerProfile) {
    this.speakers = this.speakers.map((item) => (item.id === profile.id ? profile : item));
  }
  async updateTask(task: SpeakerTask) {
    this.tasks = this.tasks.map((item) => (item.id === task.id ? task : item));
  }
  async updateSession(session: ContentWorkspace["sessions"][number]) {
    this.sessions = this.sessions.map((item) => (item.id === session.id ? session : item));
  }
  async updateAsset(asset: SpeakerAsset) {
    this.assets = this.assets.map((item) => (item.id === asset.id ? asset : item));
  }
  async addAsset(asset: SpeakerAsset) {
    this.assets = [...this.assets, asset];
  }
  async addTask(task: SpeakerTask) {
    this.tasks = [...this.tasks, task];
  }
  async addMessage(message: ContentWorkspace["messages"][number]) {
    this.messages = [...this.messages, message];
  }
  async findProfile(profileId: string) {
    return this.speakers.find(({ id }) => id === profileId) ?? null;
  }
  async findSession(sessionId: string) {
    return this.sessions.find(({ id }) => id === sessionId) ?? null;
  }
  async findAsset(assetId: string) {
    return this.assets.find(({ id }) => id === assetId) ?? null;
  }
  async findProfileBySource(eventId: string, sourcePersonId: string) {
    return (
      this.speakers.find(
        (profile) => profile.eventId === eventId && profile.sourcePersonId === sourcePersonId,
      ) ?? null
    );
  }
}

/**
 * In-memory `SpeakerConversionPort` with the same contract as `D1SpeakerConversion`: one profile
 * per event per email address, whichever door — CRM conversion or CFP acceptance — arrives first.
 */
export class MemorySpeakerConversion implements SpeakerConversionPort {
  constructor(
    private readonly repository: MemoryContentRepository,
    private readonly newId: () => string,
  ) {}
  async createOrLink(command: SpeakerConversionCommand) {
    const normalizedEmail = command.email.trim().toLowerCase();
    const workspace = await this.repository.workspace(command.eventId);
    const existing = workspace.speakers.find(
      (profile) => profile.email.toLowerCase() === normalizedEmail,
    );
    if (existing) return { speakerId: existing.id };
    const speakerId = this.newId();
    await this.repository.addProfile({
      id: speakerId,
      eventId: command.eventId,
      userId: this.newId(),
      sourcePersonId: `crm-email:${normalizedEmail}`,
      name: command.name,
      email: normalizedEmail,
      bio: "",
      pronouns: "",
      organization: "",
    });
    return { speakerId };
  }
}
