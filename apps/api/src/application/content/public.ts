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

/**
 * The calendar-invitation command the transport composes.
 *
 * Re-exported here rather than deep-imported, so the crossing it permits — platform reaching
 * content — is governed by content's declared surface instead of by a path blessed one file at a
 * time. It is a command rather than one of the read queries above, which is why it names the
 * service; everything else about it stays inside the domain.
 */
export {
  CalendarOrganizerUnconfiguredError,
  SpeakerCalendarInviteService,
} from "./speaker-calendar-invites";
