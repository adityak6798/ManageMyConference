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
/**
 * What communications needs to remind a speaker about work that is coming due.
 *
 * Not scoped to one event, deliberately. The caller is a one-minute cron tick with no request
 * and no event in hand, and the alternative — enumerate every event, then ask about each — makes
 * the number of reads grow with the conference schedule to answer a question that is one index
 * scan on `due_at`. Nothing here is organization-scoped either; the caller resolves that from
 * the event, because content does not own which organization runs an event.
 *
 * The declaration this replaces (`listOpenSpeakerWork(eventId)`) had no implementation and no
 * caller; issue #52's reminder rules are its first, and they need this shape.
 */
export interface CommunicationsContentQuery {
  /**
   * Open speaker tasks falling due at or before `dueBefore`, oldest first.
   *
   * Overdue tasks are included rather than filtered out: from a reminder's point of view "due
   * tomorrow" and "was due last week" are the same fact, and excluding the second would mean a
   * task nobody was ever reminded about simply because the cron was not running that day.
   *
   * A speaker whose profile carries no address is omitted — there is nobody to remind, and a
   * delivery to an empty string would burn attempts to reach nobody.
   */
  listOpenSpeakerWork(
    dueBefore: string,
    limit: number,
  ): Promise<
    readonly {
      eventId: string;
      profileId: string;
      userId: string;
      speakerName: string;
      email: string;
      taskId: string;
      title: string;
      dueAt: string;
    }[]
  >;
}
