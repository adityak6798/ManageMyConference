/**
 * Permission-aware search across one event's operational surfaces.
 *
 * There is no index and no projection table here, and that is the design rather than a stage
 * on the way to one. Every record this can return is already reachable through the owning
 * domain's public application interface, under the authorization rule that domain enforces —
 * so composing those reads is the only implementation that cannot leak. A search index would
 * be a second copy of private CRM notes, unpublished speaker material and reviewer-hidden
 * aggregates, sitting outside every rule that protects the originals, and it would have to be
 * kept honest by hand on every write in the repository.
 *
 * The cost of that choice is that the answer is bounded by what the projections already carry:
 * this filters in memory over reads the console makes anyway, caps each section, and never
 * paginates deeper. An event large enough for that to matter needs a different design, and
 * `GAP-022` records the point at which it would.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
import { AgendaNotFoundError } from "../agenda/public";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  hasEventRoleCapability,
  requireEventCapability,
} from "../identity/actor";

export type SearchResultKind =
  | "session"
  | "speaker"
  | "proposal"
  | "task"
  | "agenda-item"
  | "delivery"
  | "contact";

export interface SearchResult {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /**
   * Console path plus `?event=`. Produced here, never assembled in the browser.
   *
   * Which surface a hit opens depends on the role that read it — a reviewer's proposal belongs
   * to the review queue and an organizer's to the abstracts board — so a browser that derived
   * the route would send a reviewer somewhere their role cannot open.
   */
  readonly href: string;
}

/**
 * One source's contribution, in three states.
 *
 * `unauthorized` is a fact about the caller and never an outage: a reviewer cannot read the
 * CRM, and reporting that as a failure would describe a working system as broken. `failed`
 * carries the rejection itself rather than a rendered message, because turning a rejection
 * into caller-facing words — with a correlation id, and with a log line — belongs to the
 * transport and not to this layer.
 */
export type SearchSection =
  | { readonly state: "ok"; readonly results: readonly SearchResult[] }
  | { readonly state: "unauthorized" }
  | { readonly state: "failed"; readonly reason: unknown };

export type SearchSectionKey = "content" | "review" | "agenda" | "communications" | "crm";

export const SEARCH_SECTION_KEYS: readonly SearchSectionKey[] = [
  "content",
  "review",
  "agenda",
  "communications",
  "crm",
];

export interface PlatformSearchAnswer {
  readonly query: string;
  readonly limit: number;
  readonly sections: Readonly<Record<SearchSectionKey, SearchSection>>;
}

/** The query was shorter than the shortest query worth running. A caller mistake, never a fault. */
export class SearchQueryTooShortError extends Error {}

/**
 * A source this deployment did not wire.
 *
 * Distinct from `unauthorized`: the caller may well be allowed to read it, and the reason they
 * cannot is a composition bug. It degrades the one section rather than the request, and the
 * transport logs it, so a partially wired test harness stays usable while still reporting that
 * something is missing.
 */
export class SearchSourceUnavailableError extends Error {}

/** The shortest query worth running; one character matches most of a conference. */
export const SEARCH_QUERY_MIN_LENGTH = 2;

/*
 * The sources, declared as the narrowest shape each contributes rather than as the services
 * that satisfy them.
 *
 * This is the same inversion `ContentAgendaInterface` and `OutreachDispatchPort` already use,
 * for the same two reasons. It states exactly which fields platform depends on, so widening
 * that dependency is a visible edit here instead of a quiet extra read; and it keeps this
 * module free of another domain's concrete projection types, so a test supplies six small
 * objects rather than six constructed domains. The real services satisfy these structurally,
 * which is checked where they are bound — the composition root.
 */

export interface EventOrganizationSource {
  organizationOf(eventId: string): Promise<string | null>;
}

export interface ContentSearchSource {
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
      readonly speakerProfileId: string;
      readonly instructions?: string | undefined;
    }[];
  }>;
}

export interface ReviewSearchSource {
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

export interface AgendaSearchSource {
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
  }>;
}

export interface CommunicationsSearchSource {
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
      };
    }[];
  }>;
}

export interface CrmSearchSource {
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
 * Every source composed here, by name.
 *
 * All but `events` are optional because a deployment or a test may compose only some of them;
 * a source that is absent degrades its own section and reports why, rather than being silently
 * empty — an empty section and a missing one look identical to the person searching.
 */
export interface PlatformSearchDependencies {
  readonly events: EventOrganizationSource;
  readonly content?: ContentSearchSource | undefined;
  readonly review?: ReviewSearchSource | undefined;
  readonly agenda?: AgendaSearchSource | undefined;
  readonly communications?: CommunicationsSearchSource | undefined;
  readonly crm?: CrmSearchSource | undefined;
}

const consoleHref = (path: string, eventId: string) =>
  `${path}?event=${encodeURIComponent(eventId)}`;

const hasEventRole = (actor: Actor, eventId: string, role: "organizer" | "reviewer" | "speaker") =>
  actor.eventAccess.some((candidate) => candidate.eventId === eventId && candidate.role === role);

const matches = (needle: string, ...fields: readonly (string | null | undefined)[]) =>
  fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));

/**
 * Take from each kind in turn until the section is full.
 *
 * Concatenating instead would let one kind fill the whole section: an event with forty matching
 * sessions would answer a speaker's name with forty sessions and no speaker, which reads as
 * "no such speaker" to the person typing.
 */
function interleave(groups: readonly (readonly SearchResult[])[], limit: number): SearchResult[] {
  const taken: SearchResult[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest && taken.length < limit; index += 1)
    for (const group of groups) {
      const candidate = group[index];
      if (candidate && taken.length < limit) taken.push(candidate);
    }
  return taken;
}

export class PlatformSearchService {
  constructor(private readonly dependencies: PlatformSearchDependencies) {}

  /**
   * Search one event as this actor.
   *
   * The request itself needs only a session and `events:read` on the named event; everything
   * below that is decided per source, under the capability the owning domain already demands.
   * A source the actor cannot read is omitted with a reason, never refused — refusing would
   * make the whole surface unusable for a reviewer, who legitimately reads two of the five.
   */
  async search(
    actor: Actor | null,
    eventId: string,
    query: string,
    limit: number,
  ): Promise<PlatformSearchAnswer> {
    const authorized = requireEventCapability(actor, eventId, "events:read");
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_QUERY_MIN_LENGTH)
      throw new SearchQueryTooShortError(
        `Search for at least ${SEARCH_QUERY_MIN_LENGTH} characters`,
      );
    const needle = trimmed.toLowerCase();
    const [content, review, agenda, communications, crm] = await Promise.all([
      this.section(() => this.contentSection(authorized, eventId, needle, limit)),
      this.section(() => this.reviewSection(authorized, eventId, needle, limit)),
      this.section(() => this.agendaSection(authorized, eventId, needle, limit)),
      this.section(() => this.communicationsSection(authorized, eventId, needle, limit)),
      this.section(() => this.crmSection(authorized, eventId, needle, limit)),
    ]);
    return {
      query: trimmed,
      limit,
      sections: { content, review, agenda, communications, crm },
    };
  }

  /**
   * Run one source and classify whatever it does.
   *
   * The two identity refusals mean "not yours to see" and become `unauthorized`; anything else
   * is a real rejection and degrades exactly this section. Nothing rethrows, so one broken
   * source can never take the other four with it.
   */
  private async section(read: () => Promise<readonly SearchResult[]>): Promise<SearchSection> {
    try {
      return { state: "ok", results: await read() };
    } catch (error) {
      // ERROR-INTENT: classified, never dropped — a refusal becomes `unauthorized`, and every
      // other rejection leaves here in `reason` for the transport to log and render.
      if (error instanceof AuthenticationRequiredError || error instanceof CapabilityDeniedError)
        return { state: "unauthorized" };
      return { state: "failed", reason: error };
    }
  }

  private async contentSection(
    actor: Actor,
    eventId: string,
    needle: string,
    limit: number,
  ): Promise<readonly SearchResult[]> {
    const content = this.require(this.dependencies.content, "Content");
    const workspace = await content.workspace(actor, eventId);
    // An organizer manages the programme; a speaker sees the same records through their own
    // portal, and the projection they were handed is already scoped to them.
    const href = consoleHref(
      hasEventRole(actor, eventId, "organizer") ? "/sessions" : "/portal",
      eventId,
    );
    const speakerName = new Map(workspace.speakers.map((speaker) => [speaker.id, speaker.name]));
    return interleave(
      [
        workspace.sessions
          .filter((session) =>
            matches(needle, session.title, session.abstract, session.format, ...session.tracks),
          )
          .map((session) => ({
            kind: "session" as const,
            id: session.id,
            title: session.title,
            subtitle: `Session · ${session.format}`,
            href,
          })),
        workspace.speakers
          .filter((speaker) =>
            matches(needle, speaker.name, speaker.organization, speaker.email, speaker.bio),
          )
          .map((speaker) => ({
            kind: "speaker" as const,
            id: speaker.id,
            title: speaker.name,
            subtitle: speaker.organization ? `Speaker · ${speaker.organization}` : "Speaker",
            href,
          })),
        workspace.tasks
          .filter((task) => matches(needle, task.title, task.instructions))
          .map((task) => ({
            kind: "task" as const,
            id: task.id,
            title: task.title,
            subtitle: `${task.status === "complete" ? "Completed task" : "Open task"} · ${
              speakerName.get(task.speakerProfileId) ?? "Unassigned"
            }`,
            href,
          })),
      ],
      limit,
    );
  }

  /**
   * Proposals, through the projection this actor's role is allowed to read.
   *
   * The path is chosen by role rather than attempted and recovered from, which is what keeps
   * blind review structural: a reviewer never reaches the organizer projection at all, so no
   * refusal has to be caught correctly for the submitter to stay masked.
   */
  private async reviewSection(
    actor: Actor,
    eventId: string,
    needle: string,
    limit: number,
  ): Promise<readonly SearchResult[]> {
    const review = this.require(this.dependencies.review, "Review");
    if (hasEventRoleCapability(actor, eventId, "organizer", "review:manage")) {
      const workspace = await review.organizerWorkspace(actor, eventId);
      const href = consoleHref("/abstracts", eventId);
      return workspace.proposals
        .filter((proposal) =>
          matches(needle, proposal.title, proposal.abstract, proposal.submitterName),
        )
        .slice(0, limit)
        .map((proposal) => ({
          kind: "proposal" as const,
          id: proposal.id,
          title: proposal.title,
          subtitle: `${proposal.status} · ${proposal.submitterName}`,
          href,
        }));
    }
    if (!hasEventRoleCapability(actor, eventId, "reviewer", "review:evaluate"))
      throw new CapabilityDeniedError("Proposal search is not available to this role");
    const queue = await review.reviewerQueue(actor, eventId);
    const href = consoleHref("/reviews", eventId);
    return queue
      .filter(({ proposal }) => matches(needle, proposal.title, proposal.abstract))
      .slice(0, limit)
      .map(({ proposal, evaluation }) => ({
        kind: "proposal" as const,
        id: proposal.id,
        title: proposal.title,
        // `submitterName` is the mask on this path and is deliberately not echoed: repeating a
        // constant would suggest the field carries something.
        subtitle: `Assigned for review · ${evaluation?.state ?? "not started"}`,
        href,
      }));
  }

  private async agendaSection(
    actor: Actor,
    eventId: string,
    needle: string,
    limit: number,
  ): Promise<readonly SearchResult[]> {
    const agenda = this.require(this.dependencies.agenda, "Agenda");
    // An event with no board yet has nothing to match, which is an empty answer rather than a
    // degraded section: nobody has failed to do anything.
    const draft = await agenda.draft(actor, eventId).catch((error: unknown) => {
      if (error instanceof AgendaNotFoundError) return null;
      throw error;
    });
    if (!draft) return [];
    const href = consoleHref("/agenda", eventId);
    const rooms = new Map(draft.rooms.map((room) => [room.id, room.name]));
    const slots = new Map(draft.slots.map((slot) => [slot.id, slot]));
    const sessions = new Map(draft.sessions.map((session) => [session.id, session.title]));
    return draft.placements
      .filter((placement) =>
        matches(needle, sessions.get(placement.sessionId), rooms.get(placement.roomId)),
      )
      .slice(0, limit)
      .map((placement) => {
        const slot = slots.get(placement.slotId);
        const room = rooms.get(placement.roomId);
        return {
          kind: "agenda-item" as const,
          id: placement.id,
          title: sessions.get(placement.sessionId) ?? "Placed session",
          subtitle: [room, slot ? `${slot.startsAt} – ${slot.endsAt}` : null]
            .filter(Boolean)
            .join(" · "),
          href,
        };
      });
  }

  private async communicationsSection(
    actor: Actor,
    eventId: string,
    needle: string,
    limit: number,
  ): Promise<readonly SearchResult[]> {
    const communications = this.require(this.dependencies.communications, "Communications");
    const organizationId = await this.dependencies.events.organizationOf(eventId);
    if (!organizationId) return [];
    // One bounded page. Search reads what the history surface itself shows first rather than
    // walking the cursor: an unbounded scan behind a keystroke is how a search box becomes the
    // most expensive request in the product.
    const { history } = await communications.history(actor, organizationId, eventId, {
      limit: 50,
    });
    const href = consoleHref("/communications", eventId);
    return history
      .filter(({ delivery }) =>
        matches(
          needle,
          delivery.recipientRef,
          delivery.renderedSubject,
          delivery.triggerType,
          delivery.state,
        ),
      )
      .slice(0, limit)
      .map(({ delivery }) => ({
        kind: "delivery" as const,
        id: delivery.id,
        title: delivery.renderedSubject ?? delivery.triggerType,
        subtitle: `${delivery.state} · ${delivery.recipientRef}`,
        href,
      }));
  }

  /**
   * Prospects and directory contacts, both event-scoped.
   *
   * The directory is organization-wide, so the event link is passed as a filter rather than
   * trusted to come out right: without it a search on one event would answer with contacts
   * belonging to a sibling event of the same organization.
   */
  private async crmSection(
    actor: Actor,
    eventId: string,
    needle: string,
    limit: number,
  ): Promise<readonly SearchResult[]> {
    const crm = this.require(this.dependencies.crm, "CRM");
    const organizationId = await this.dependencies.events.organizationOf(eventId);
    const prospects = await crm.list(actor, eventId, {});
    const directory = organizationId
      ? (await crm.listContacts(actor, organizationId, { search: needle, eventId })).contacts
      : [];
    const prospectHref = consoleHref("/speakers", eventId);
    const directoryHref = consoleHref("/speaker-directory", eventId);
    return interleave(
      [
        prospects
          .filter((prospect) =>
            matches(
              needle,
              prospect.name,
              prospect.stage,
              ...prospect.contacts.map(({ email }) => email),
            ),
          )
          .map((prospect) => ({
            kind: "contact" as const,
            id: prospect.id,
            title: prospect.name,
            subtitle: `Prospect · ${prospect.stage}`,
            href: prospectHref,
          })),
        directory.map((contact) => ({
          kind: "contact" as const,
          id: contact.id,
          title: contact.name,
          subtitle: contact.company ? `Contact · ${contact.company}` : "Contact",
          href: directoryHref,
        })),
      ],
      limit,
    );
  }

  private require<T>(source: T | undefined, name: string): T {
    if (!source) throw new SearchSourceUnavailableError(`${name} is not configured`);
    return source;
  }
}
