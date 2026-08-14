/**
 * The operational inbox: everything on this event that is waiting for somebody.
 *
 * **Items are derived, and that is the whole design.** Nothing here writes an item, marks one
 * done, or reconciles a queue against the world. Each item is computed from the domains' own
 * reads on every request, so resolving the underlying condition — completing the task, placing
 * the session, retrying the delivery, publishing the page — removes the item with no database
 * edit anywhere and no chance of the inbox and the truth disagreeing. A stored work queue would
 * need every one of those writes to remember to close a row, and the first one that forgot would
 * leave an operator chasing work that was already finished.
 *
 * The one thing that *is* stored is a **dismissal**, because "I have seen this and I am choosing
 * not to act" is a fact about a person and cannot be derived from anything else. Its key carries
 * the occurrence rather than the record — the task's due date, the delivery's attempt count —
 * so a re-derived identical item stays dismissed while a genuinely new occurrence of the same
 * condition comes back.
 *
 * Authorization and degradation follow `PRD-OPS-001` exactly as search does: the request needs
 * `events:read`, each category is composed under its owning domain's capability, and a category
 * the caller may not read is omitted and named rather than refused.
 *
 * @spec PRD-OPS-002 ARC-DOM-001
 */
import { AgendaNotFoundError } from "../agenda/public";
import {
  type Actor,
  CapabilityDeniedError,
  hasEventRoleCapability,
  requireEventCapability,
} from "../identity/actor";
import { readSource, requireSource } from "./section";
import type { PlatformSources } from "./sources";

export type InboxCategoryKey =
  | "reviews"
  | "speakerWork"
  | "programme"
  | "deliveries"
  | "publication"
  | "configuration";

export const INBOX_CATEGORY_KEYS: readonly InboxCategoryKey[] = [
  "reviews",
  "speakerWork",
  "programme",
  "deliveries",
  "publication",
  "configuration",
];

/** How much of the operator's attention this is asking for. Never a due date in disguise. */
export type InboxPriority = "high" | "normal" | "low";

export interface InboxItem {
  /**
   * Identity *and* occurrence.
   *
   * A dismissal is stored against this string, so it has to change exactly when the operator
   * would want to be told again. A task's key carries its deadline: moving the deadline is a new
   * thing to know about, while re-deriving the same task on the next request is not.
   */
  readonly key: string;
  readonly category: InboxCategoryKey;
  readonly title: string;
  readonly subtitle?: string;
  readonly priority: InboxPriority;
  /** `open` unless this actor has dismissed this exact occurrence. */
  readonly status: "open" | "dismissed";
  /** Who the condition is waiting on, when the source names somebody. */
  readonly owner?: string;
  readonly dueAt?: string;
  /** Console path plus `?event=`, produced here for the same reason a search hit's is. */
  readonly href: string;
  readonly dismissedAt?: string;
}

export type InboxSection =
  | { readonly state: "ok"; readonly items: readonly InboxItem[] }
  | { readonly state: "unauthorized" }
  | { readonly state: "failed"; readonly reason: unknown };

export interface PlatformInboxAnswer {
  readonly categories: Readonly<Record<InboxCategoryKey, InboxSection>>;
  /** When the answer was derived. Every relative label on the surface is measured from it. */
  readonly derivedAt: string;
}

export interface InboxDismissal {
  readonly eventId: string;
  readonly itemKey: string;
  readonly actorId: string;
  readonly dismissedAt: string;
}

/**
 * Where dismissals live.
 *
 * Per actor, deliberately. A dismissal is one person deciding they have seen something; letting
 * it hide the item from every other organizer would make one operator able to silently remove
 * work from a colleague's list, which is the opposite of what an inbox is for.
 */
export interface InboxDismissalStore {
  list(eventId: string, actorId: string): Promise<readonly InboxDismissal[]>;
  dismiss(dismissal: InboxDismissal): Promise<void>;
  restore(eventId: string, itemKey: string, actorId: string): Promise<boolean>;
}

/** The item key names no such condition on this event right now. */
export class InboxItemNotFoundError extends Error {}

export interface PlatformInboxDependencies {
  readonly sources: PlatformSources;
  readonly dismissals: InboxDismissalStore;
  readonly now: () => Date;
}

const consoleHref = (path: string, eventId: string) =>
  `${path}?event=${encodeURIComponent(eventId)}`;

/**
 * Two JSON trees, compared as values rather than as bytes.
 *
 * The draft projection is composed live on every preview while the published one is parsed out
 * of storage, so their key order is not guaranteed to match even when they say the same thing.
 * Comparing the serialized forms directly would report "unpublished changes" on an event nobody
 * has touched — the sort is what makes the comparison about content.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export class PlatformInboxService {
  constructor(private readonly dependencies: PlatformInboxDependencies) {}

  /**
   * Everything waiting on this event, as this actor.
   *
   * The dismissal read happens once and is shared by every category, because a dismissal is
   * keyed by item rather than by source and asking six times would be six reads of one row set.
   */
  async inbox(actor: Actor | null, eventId: string): Promise<PlatformInboxAnswer> {
    const authorized = requireEventCapability(actor, eventId, "events:read");
    const now = this.dependencies.now();
    const dismissals = new Map(
      (await this.dependencies.dismissals.list(eventId, authorized.id)).map((dismissal) => [
        dismissal.itemKey,
        dismissal.dismissedAt,
      ]),
    );
    const mark = (items: readonly InboxItem[]): readonly InboxItem[] =>
      items.map((item) => {
        const dismissedAt = dismissals.get(item.key);
        return dismissedAt ? { ...item, status: "dismissed" as const, dismissedAt } : item;
      });
    const section = async (read: () => Promise<readonly InboxItem[]>): Promise<InboxSection> => {
      const outcome = await readSource(read);
      return outcome.state === "ok" ? { state: "ok", items: mark(outcome.value) } : outcome;
    };
    const [reviews, speakerWork, programme, deliveries, publication, configuration] =
      await Promise.all([
        section(() => this.reviews(authorized, eventId)),
        section(() => this.speakerWork(authorized, eventId, now)),
        section(() => this.programme(authorized, eventId)),
        section(() => this.deliveries(authorized, eventId)),
        section(() => this.publication(authorized, eventId)),
        section(() => this.configuration(authorized, eventId)),
      ]);
    return {
      categories: { reviews, speakerWork, programme, deliveries, publication, configuration },
      derivedAt: now.toISOString(),
    };
  }

  /**
   * Record that this actor has seen an occurrence and is not acting on it.
   *
   * The key is checked against the inbox this actor can actually derive right now, so a caller
   * cannot store a dismissal for a condition that does not exist, for a category their role
   * cannot read, or for another event's item. That check costs one composition, which is the
   * same work the surface in front of it has already done.
   */
  async dismiss(actor: Actor | null, eventId: string, itemKey: string): Promise<InboxDismissal> {
    const authorized = requireEventCapability(actor, eventId, "events:read");
    const answer = await this.inbox(authorized, eventId);
    const known = INBOX_CATEGORY_KEYS.some((key) => {
      const category = answer.categories[key];
      return category.state === "ok" && category.items.some((item) => item.key === itemKey);
    });
    if (!known) throw new InboxItemNotFoundError("No such item on this event");
    const dismissal = {
      eventId,
      itemKey,
      actorId: authorized.id,
      dismissedAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.dismissals.dismiss(dismissal);
    return dismissal;
  }

  /** Undo a dismissal. Absent is not an error: the caller wanted it gone, and it is gone. */
  async restore(actor: Actor | null, eventId: string, itemKey: string): Promise<void> {
    const authorized = requireEventCapability(actor, eventId, "events:read");
    await this.dependencies.dismissals.restore(eventId, itemKey, authorized.id);
  }

  /**
   * Evaluations nobody has finished, through the projection this role is allowed to read.
   *
   * An organizer is shown every outstanding assignment on the event and who holds it; a reviewer
   * is shown their own, from the masked queue. The path is chosen by role rather than attempted
   * and recovered from, which is what keeps blind review structural here exactly as it is in
   * search: a reviewer never reaches the organizer projection, so no refusal has to be caught
   * correctly for the submitter to stay masked.
   */
  private async reviews(actor: Actor, eventId: string): Promise<readonly InboxItem[]> {
    const review = requireSource(this.dependencies.sources.review, "Review");
    if (!hasEventRoleCapability(actor, eventId, "organizer", "review:manage")) {
      if (!hasEventRoleCapability(actor, eventId, "reviewer", "review:evaluate"))
        throw new CapabilityDeniedError("Review work is not visible to this role");
      const queue = await review.reviewerQueue(actor, eventId);
      const href = consoleHref("/reviews", eventId);
      return queue
        .filter((entry) => entry.evaluation?.state !== "completed")
        .map((entry) => ({
          key: `review-queue:${entry.proposal.id}`,
          category: "reviews" as const,
          title: entry.proposal.title,
          subtitle: entry.evaluation ? "Draft saved, not completed" : "Not started",
          priority: "normal" as const,
          status: "open" as const,
          href,
        }));
    }
    const workspace = await review.organizerWorkspace(actor, eventId);
    const completed = new Set(
      workspace.evaluations
        .filter((evaluation) => evaluation.state === "completed")
        .map((evaluation) => evaluation.assignmentId),
    );
    const proposalTitle = new Map(
      workspace.proposals.map((proposal) => [proposal.id, proposal.title]),
    );
    const reviewerName = new Map(
      workspace.reviewerDirectory.map((reviewer) => [reviewer.id, reviewer.name]),
    );
    const href = consoleHref("/abstracts", eventId);
    return workspace.assignments
      .filter((assignment) => !completed.has(assignment.id))
      .map((assignment) => ({
        key: `review-assignment:${assignment.id}`,
        category: "reviews" as const,
        title: proposalTitle.get(assignment.proposalId) ?? "Assigned proposal",
        subtitle: "Assigned, not yet evaluated",
        priority: "normal" as const,
        status: "open" as const,
        owner: reviewerName.get(assignment.reviewerId) ?? assignment.reviewerId,
        href,
      }));
  }

  /** Open speaker tasks. Overdue ones are the same condition, reported louder. */
  private async speakerWork(
    actor: Actor,
    eventId: string,
    now: Date,
  ): Promise<readonly InboxItem[]> {
    const content = requireSource(this.dependencies.sources.content, "Content");
    const workspace = await content.workspace(actor, eventId);
    const speakerName = new Map(workspace.speakers.map((speaker) => [speaker.id, speaker.name]));
    const href = consoleHref("/sessions", eventId);
    return workspace.tasks
      .filter((task) => task.status !== "complete")
      .map((task) => {
        const overdue = Date.parse(task.dueAt) < now.getTime();
        return {
          // The deadline is part of the key: moving it is a new thing to be told about, and a
          // dismissal of the old deadline should not silence the new one.
          key: `speaker-task:${task.id}:${task.dueAt}`,
          category: "speakerWork" as const,
          title: task.title,
          subtitle: overdue ? "Overdue" : "Open",
          priority: overdue ? ("high" as const) : ("normal" as const),
          status: "open" as const,
          owner: speakerName.get(task.speakerProfileId) ?? task.speakerProfileId,
          dueAt: task.dueAt,
          href,
        };
      });
  }

  /**
   * The programme's own two problems: a placement that clashes, and a session with no place.
   *
   * Both are agenda questions and both are read under `agenda:manage`, but they are not the same
   * kind of thing — a conflict blocks publication outright, while an unplaced session is simply
   * work left to do — so they carry different priorities rather than one undifferentiated count.
   *
   * **Both keys carry the agenda's own occurrence**, which is the one thing this category used to
   * be missing (`GAP-022`, issue #180). A conflict is identified by its kind and the two
   * placements it names, and an unplaced session by its id — identifiers a resolved condition
   * reuses exactly when it comes back, so a dismissal used to outlive the thing it was about and
   * hide the recreated one. The agenda now says at which board revision each session's placements
   * last changed and at which revision each clash began, so "the same unplaced session" and "this
   * session, taken off the board again" are different strings.
   */
  private async programme(actor: Actor, eventId: string): Promise<readonly InboxItem[]> {
    const agenda = requireSource(this.dependencies.sources.agenda, "Agenda");
    // An event with no board yet has nothing waiting on it, which is an empty category rather
    // than a degraded one: nobody has failed to do anything.
    const draft = await agenda.draft(actor, eventId).catch((error: unknown) => {
      if (error instanceof AgendaNotFoundError) return null;
      throw error;
    });
    if (!draft) return [];
    const href = consoleHref("/agenda", eventId);
    const placed = new Set(draft.placements.map((placement) => placement.sessionId));
    const conflicts = (draft.conflicts ?? []).map((conflict) => ({
      key: `agenda-conflict:${conflict.kind}:${conflict.placementId}:${conflict.conflictingPlacementId}:${conflict.occurrence}`,
      category: "programme" as const,
      title: conflict.message,
      subtitle: "Blocks publication of the schedule",
      priority: "high" as const,
      status: "open" as const,
      href,
    }));
    const unplaced = draft.sessions
      .filter((session) => !placed.has(session.id))
      .map((session) => ({
        // The revision at which this session's placements last changed is the occurrence: a
        // session that has never been placed reads 0 and keeps its dismissal across every
        // unrelated edit to the board, while one that was placed and taken off again comes back
        // under a new key. A session the organizer has not touched is not news twice.
        key: `agenda-unplaced:${session.id}:${draft.occurrences.sessions[session.id] ?? 0}`,
        category: "programme" as const,
        title: session.title,
        subtitle: "Not on the board yet",
        priority: "normal" as const,
        status: "open" as const,
        href,
      }));
    return [...conflicts, ...unplaced];
  }

  /** Deliveries that did not reach anybody. `succeeded` and `queued` are nobody's problem. */
  private async deliveries(actor: Actor, eventId: string): Promise<readonly InboxItem[]> {
    const communications = requireSource(
      this.dependencies.sources.communications,
      "Communications",
    );
    const organizationId = await this.dependencies.sources.events.organizationOf(eventId);
    if (!organizationId) return [];
    const { history } = await communications.history(actor, organizationId, eventId, { limit: 50 });
    const href = consoleHref("/communications", eventId);
    return history
      .filter(({ delivery }) => delivery.state === "retrying" || delivery.state === "terminal")
      .map(({ delivery }) => ({
        // The attempt count is the occurrence: a delivery that failed again after a retry is
        // news, even though the row and its address have not changed.
        key: `delivery:${delivery.id}:${delivery.attemptCount}`,
        category: "deliveries" as const,
        title: delivery.renderedSubject ?? delivery.triggerType,
        subtitle: delivery.state === "terminal" ? "Gave up" : "Retrying",
        priority: delivery.state === "terminal" ? ("high" as const) : ("normal" as const),
        status: "open" as const,
        owner: delivery.recipientRef,
        href,
      }));
  }

  /** The public page, when it is behind what the organizer has composed. */
  private async publication(actor: Actor, eventId: string): Promise<readonly InboxItem[]> {
    const publishing = requireSource(this.dependencies.sources.publishing, "Publishing");
    const publication = await publishing.preview(actor, eventId);
    if (!publication) return [];
    const href = consoleHref("/publishing", eventId);
    if (publication.state !== "published")
      return [
        {
          key: `publication-state:${eventId}:${publication.state}`,
          category: "publication" as const,
          title: "The public page is not live",
          subtitle:
            publication.state === "unpublished"
              ? "It was withdrawn and nothing is served at its address"
              : "It has never been published",
          priority: "normal" as const,
          status: "open" as const,
          href,
        },
      ];
    const draft = canonical(publication.draft);
    if (draft === canonical(publication.published)) return [];
    return [
      {
        // The draft's own content is the occurrence, so a dismissal survives a re-read and ends
        // the moment the organizer edits the page again or publishes it.
        key: `publication-draft:${eventId}:${fingerprint(draft)}`,
        category: "publication" as const,
        title: "The public page has unpublished changes",
        subtitle: "Visitors are still seeing the last published snapshot",
        priority: "normal" as const,
        status: "open" as const,
        href,
      },
    ];
  }

  /**
   * Configuration this event was cloned into and never finished receiving.
   *
   * The sixth category, and it closes issue #203's third residual: a partial template
   * application was surfaced only in the templates workspace, a page an organizer opens on
   * purpose, so an operator who never went there was never told. Everything derived here is
   * derived by the events domain — this asks one question and renders the answer.
   *
   * **The key carries the deciding application's instant, which is the occurrence.** A dismissal
   * says "I have seen that this event's agenda category did not arrive and I am not acting on
   * it". Applying the template again and having the same category refused again is a *new* thing
   * to know, and it writes a new application row with a new instant, so the item returns. A
   * re-derivation of the same refusal does not.
   *
   * That is also this category's answer to the issue's second residual. An organizer who repairs
   * the refused category by hand — creating the room a slot wanted, granting a capability —
   * still holds a stored outcome that says the category was refused, because nothing re-reads
   * the destination to find out otherwise. Dismissing is how they say so, and it costs them one
   * click instead of a re-application they did not need.
   *
   * `high` rather than `normal`, unlike everything else in this file that is not overdue: an
   * event configured in part is wrong in a way nothing else on the console reveals, and the
   * operator reading the inbox is the only person who will meet it.
   */
  private async configuration(actor: Actor, eventId: string): Promise<readonly InboxItem[]> {
    const events = requireSource(this.dependencies.sources.eventConfiguration, "Events");
    const href = consoleHref("/event-templates", eventId);
    return (await events.outstandingConfiguration(actor, eventId)).map((category) => ({
      key: `template-category:${eventId}:${category.key}:${category.outstandingSince}`,
      category: "configuration" as const,
      title: `${category.label} was not configured from “${category.templateName}”`,
      subtitle: category.reason,
      priority: "high" as const,
      status: "open" as const,
      href,
    }));
  }
}

/**
 * A short, stable stand-in for a whole projection.
 *
 * Only ever compared with itself, and only to decide whether the same draft is being looked at
 * again, so a 32-bit hash is the right size: a collision would silence one dismissal, and there
 * is no security property here to lose.
 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
