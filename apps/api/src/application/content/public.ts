export interface AgendaContentQuery {
  listSchedulableSessions(eventId: string): Promise<
    readonly {
      id: string;
      title: string;
      speakerProfileIds: readonly string[];
      tracks: readonly string[];
    }[]
  >;
}
export class FixtureSchedulableContentQuery implements AgendaContentQuery {
  constructor(
    private readonly data: ReadonlyMap<
      string,
      readonly { id: string; title: string; speakerIds: readonly string[] }[]
    >,
  ) {}
  async listSchedulableSessions(eventId: string) {
    return (this.data.get(eventId) ?? []).map(({ id, title, speakerIds }) => ({
      id,
      title,
      speakerProfileIds: [...speakerIds],
      tracks: [],
    }));
  }
}
export interface PublishingContentQuery {
  publishedEventContent(eventId: string): Promise<{
    sessions: readonly {
      id: string;
      title: string;
      abstract: string;
      format: string;
      speakerProfileIds: readonly string[];
      tags: readonly string[];
      tracks: readonly string[];
    }[];
    speakers: readonly {
      id: string;
      name: string;
      bio: string;
      pronouns: string;
      organization: string;
      photoAssetId?: string;
    }[];
    assets: readonly { id: string; speakerProfileId: string; name: string; contentType: string }[];
  }>;
}
export interface CrmContentQuery {
  findSpeakerOrigin(
    eventId: string,
    sourcePersonId: string,
  ): Promise<{ profileId: string; userId: string; name: string; email: string } | null>;
}
export interface CommunicationsContentQuery {
  listOpenSpeakerWork(eventId: string): Promise<
    readonly {
      profileId: string;
      userId: string;
      email: string;
      taskId: string;
      title: string;
      dueAt: string;
    }[]
  >;
}
