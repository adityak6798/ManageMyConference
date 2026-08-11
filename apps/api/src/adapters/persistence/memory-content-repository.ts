import type {
  ContentRepository,
  AcceptedContent,
} from "../../application/content/content-repository";
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
    this.sessions = [...this.sessions, content.session];
    this.speakers = [...this.speakers, ...content.speakers];
    this.tasks = [...this.tasks, ...content.tasks];
    this.messages = [...this.messages, ...content.messages];
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
