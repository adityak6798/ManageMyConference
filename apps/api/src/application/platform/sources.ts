/**
 * The domain reads platform composes, declared as the narrowest shape each contributes.
 *
 * This is the same inversion `ContentAgendaInterface` and `OutreachDispatchPort` already use,
 * for the same two reasons. It states exactly which fields platform depends on, so widening
 * that dependency is a visible edit in this file instead of a quiet extra read somewhere; and it
 * keeps platform free of another domain's concrete projection types, so a test supplies six
 * small objects rather than six constructed domains. The real services satisfy these
 * structurally, and that is checked where they are bound — the composition root.
 *
 * One declaration per source, shared by every capability that reads it. Search and the inbox ask
 * different questions of the same six calls, and giving each its own copy of the port would let
 * the two drift into disagreeing about what a session is.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
import type { Actor } from "../identity/actor";

export interface EventOrganizationSource {
  organizationOf(eventId: string): Promise<string | null>;
}

export interface ContentSource {
  workspace(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    readonly sessions: readonly {
      readonly id: string;
      readonly title: string;
      readonly abstract: string;
      readonly format: string;
      readonly tracks: readonly string[];
    }[];
    readonly speakers: readonly {
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly bio: string;
      readonly organization: string;
    }[];
    readonly tasks: readonly {
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly dueAt: string;
      readonly speakerProfileId: string;
      readonly instructions?: string | undefined;
    }[];
  }>;
}

export interface ReviewSource {
  organizerWorkspace(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    readonly proposals: readonly {
      readonly id: string;
      readonly title: string;
      readonly abstract: string;
      readonly submitterName: string;
      readonly status: string;
    }[];
    readonly assignments: readonly {
      readonly id: string;
      readonly proposalId: string;
      readonly reviewerId: string;
      readonly createdAt: string;
    }[];
    readonly evaluations: readonly {
      readonly assignmentId: string;
      readonly state: string;
    }[];
    readonly reviewerDirectory: readonly { readonly id: string; readonly name: string }[];
  }>;
  /** The masked projection. Nothing here has a field for the submitter's contact details. */
  reviewerQueue(
    actor: Actor | null,
    eventId: string,
  ): Promise<
    readonly {
      readonly proposal: { readonly id: string; readonly title: string; readonly abstract: string };
      readonly evaluation?: { readonly state: string } | null | undefined;
    }[]
  >;
}

export interface AgendaSource {
  draft(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    readonly rooms: readonly { readonly id: string; readonly name: string }[];
    readonly slots: readonly {
      readonly id: string;
      readonly startsAt: string;
      readonly endsAt: string;
    }[];
    readonly sessions: readonly { readonly id: string; readonly title: string }[];
    readonly placements: readonly {
      readonly id: string;
      readonly sessionId: string;
      readonly roomId: string;
      readonly slotId: string;
    }[];
    /**
     * When each session's placements last changed, in board revisions.
     *
     * Required rather than optional, and that is the point of stating ports here: this number is
     * what separates "still unplaced" from "placed and taken off again", and the inbox's
     * dismissal key is built from it. If the agenda ever stopped answering it, the binding in the
     * composition root would stop compiling instead of the inbox quietly going back to hiding a
     * recreated condition behind an old dismissal (issue #180).
     *
     * The board also carries a number per retimed slot, which is deliberately not declared here:
     * a conflict's own `occurrence` already folds in the slots its placements sit in, and platform
     * has no use for the raw map. A port states the narrowest shape its holder actually reads.
     */
    readonly occurrences: {
      readonly sessions: Readonly<Record<string, number>>;
    };
    readonly conflicts?:
      | readonly {
          readonly kind: string;
          readonly placementId: string;
          readonly conflictingPlacementId: string;
          readonly message: string;
          /** The revision at which this clash began. Same three ids, later number, new clash. */
          readonly occurrence: number;
        }[]
      | undefined;
  }>;
}

export interface PublishingSource {
  /**
   * The publication as the organizer's own preview shows it.
   *
   * Both projections are carried because the inbox's question is whether they differ, and only
   * the two together can answer it. They are opaque here on purpose: what a public page contains
   * is publishing's business, and platform only needs to know that this copy is not that one.
   */
  preview(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    readonly state: string;
    readonly slug: string;
    readonly draft: unknown;
    readonly published: unknown;
  } | null>;
}

export interface CommunicationsSource {
  history(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    page: { limit: number },
  ): Promise<{
    readonly history: readonly {
      readonly delivery: {
        readonly id: string;
        readonly recipientRef: string;
        readonly renderedSubject: string | null;
        readonly triggerType: string;
        readonly state: string;
        readonly attemptCount: number;
        readonly updatedAt: string;
      };
    }[];
  }>;
}

export interface CrmSource {
  list(
    actor: Actor | null,
    eventId: string,
    filters: Record<string, never>,
  ): Promise<
    readonly {
      readonly id: string;
      readonly name: string;
      readonly stage: string;
      readonly contacts: readonly { readonly email: string }[];
    }[]
  >;
  listContacts(
    actor: Actor | null,
    organizationId: string,
    query: { search?: string | undefined; eventId?: string | undefined },
  ): Promise<{
    readonly contacts: readonly {
      readonly id: string;
      readonly name: string;
      readonly company: string | null;
    }[];
  }>;
}

/**
 * Configuration this event was cloned into and never finished receiving.
 *
 * Issue #203's third residual, and the one #188 deliberately left: a partial template
 * application is surfaced in the templates workspace, which an organizer reaches on purpose, and
 * an operator who never opens that page is told nothing. This is that decision taken — a sixth
 * inbox category — and the shape is the reason it is cheap now. The events domain folds the
 * answer itself (`outstandingConfiguration`), so platform declares one call and holds no
 * knowledge of templates, versions or slices beyond what an item has to say.
 *
 * `events:settings:read` on the events side, which is narrower than the `events:read` the inbox
 * itself needs — so this category degrades to `unauthorized` for a role that can open the inbox
 * and may not read an event's settings, exactly as the other five degrade.
 */
export interface EventConfigurationSource {
  outstandingConfiguration(
    actor: Actor | null,
    eventId: string,
  ): Promise<
    readonly {
      readonly key: string;
      readonly label: string;
      readonly outcome: string;
      readonly reason: string;
      readonly templateName: string;
      readonly outstandingSince: string;
    }[]
  >;
}

/**
 * Every source platform composes, by name.
 *
 * All but `events` are optional because a deployment or a test may compose only some of them; a
 * source that is absent degrades its own section and says so, rather than answering empty — an
 * empty section and a missing one look identical to the person reading it.
 */
export interface PlatformSources {
  readonly events: EventOrganizationSource;
  readonly content?: ContentSource | undefined;
  readonly review?: ReviewSource | undefined;
  readonly agenda?: AgendaSource | undefined;
  readonly publishing?: PublishingSource | undefined;
  readonly communications?: CommunicationsSource | undefined;
  readonly crm?: CrmSource | undefined;
  readonly eventConfiguration?: EventConfigurationSource | undefined;
}
