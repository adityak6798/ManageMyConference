// @spec PRD-PUB-001
export interface PublicSpeaker {
  readonly slug: string;
  readonly name: string;
  readonly bio: string;
  readonly headline: string;
  readonly photoUrl?: string;
}

export interface PublicSession {
  readonly slug: string;
  readonly title: string;
  readonly abstract: string;
  readonly format: string;
  readonly track: string;
  readonly speakerSlugs: readonly string[];
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly room?: string;
}

export interface PublicEventProjection {
  readonly event: {
    readonly slug: string;
    readonly name: string;
    readonly summary: string;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly timezone: string;
    readonly venue: string;
  };
  readonly cfp: {
    readonly title: string;
    readonly description: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly submissionUrl: string;
  };
  readonly sessions: readonly PublicSession[];
  readonly speakers: readonly PublicSpeaker[];
}

export interface Publication {
  readonly eventId: string;
  readonly slug: string;
  readonly state: "draft" | "published" | "unpublished";
  readonly draft: PublicEventProjection;
  readonly published: PublicEventProjection | null;
  readonly publishedAt: string | null;
}
