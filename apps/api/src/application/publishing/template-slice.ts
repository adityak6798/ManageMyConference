/**
 * Publishing's contribution to a reusable event template.
 *
 * The public page is the slice whose configuration is entangled with identity. A
 * `public_event_projections` row carries a globally unique `slug`, a second unique index over
 * `json_extract(draft_json,'$.event.slug')`, and the pair of triggers migration 1802 added so a
 * draft cannot reserve an address another event is already serving. Copying the source's
 * address would therefore fail every single time, and #124 made a raced one a 409 rather than a
 * 500 precisely because there is no product-safe way to have two owners.
 *
 * So the template carries only the two fields an organizer types about their own page — the
 * summary and the venue. The address is the destination's own throughout: the one it already
 * holds, or one derived from its own name when it holds none. And the dates are the ones the
 * organizer confirmed for the destination: events hold no range of their own (`PRD-EVT-001`),
 * which is why the clone command takes one and why this is the slice that turns it into stored
 * state.
 *
 * @spec PRD-PUB-001 PRD-EVT-002 ARC-DOM-001
 */
import {
  type PublicationSettings,
  type PublicEventProjection,
  publicEventSlug,
} from "../../domain/publishing/publication";
import type {
  DateRemap,
  EventConfigurationSlice,
  SliceEntry,
  SlicePreview,
  SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import type { PublicationRepository } from "./publication-repository";
import { PublicationSlugTakenError, type PublicationService } from "./publication-service";

export const PUBLISHING_TEMPLATE_SLICE_KEY = "publishing";

interface PublishingTemplatePayload {
  readonly summary: string;
  readonly venue: string;
}

/**
 * The authorizing reads and the one write.
 *
 * Everything that has to answer to an actor goes through the service, because publishing's own
 * rule is stricter than the capability the orchestrator checked: `events:settings:update` has
 * to arrive through an *organizer* grant on the event (`ARC-AUTH-001`), and only
 * `requireOrganizer` knows that.
 */
type PublicationCommands = Pick<PublicationService, "preview" | "updateSettings">;

/**
 * The destination's stored row, read unmerged, and the address reservations.
 *
 * `PublicationService.preview` composes: it fills an empty stored date from the agenda before
 * returning. Comparing against that would call this slice converged whenever the destination's
 * agenda happened to span the confirmed range — which is the *likely* case once agenda's own
 * slice has remapped its slots into it — and the confirmed dates would then never be written
 * anywhere. So the comparison reads what `updateSettings` merges into: the stored draft.
 *
 * `findEventIdBySlug` is the same reservation lookup `updateSettings` performs, used here so a
 * preview can say the address is taken while writing nothing.
 */
type PublicationProjections = Pick<PublicationRepository, "findByEventId" | "findEventIdBySlug">;

/**
 * The destination event's name, which is all a first public address is derived from.
 *
 * A function rather than the events service: publishing needs one string about one event, and
 * taking the service to get it would make this domain depend on another domain's commands. The
 * composition root supplies it; `DateRemap` already carries the destination event id.
 */
export type DestinationEventName = (actor: Actor | null, eventId: string) => Promise<string | null>;

/**
 * What a `public_event_projections` row holds that this slice refuses to carry, named rather
 * than merely omitted: the preview promises a complete category list, and a snapshot nobody can
 * see was excluded reads as one that was copied.
 *
 * Sessions and speakers are not withheld out of caution — they are not publishing's material at
 * all. The destination composes its own from its own content and agenda every time its page is
 * previewed or published, so copying the source's would advertise talks the destination has not
 * accepted and speakers who never agreed to appear on it.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "published", label: "The published page and the date it went live" },
  { id: "sessions", label: "Sessions on the public page" },
  { id: "speakers", label: "The speaker gallery" },
];

export function publishingTemplateSlice(
  publication: PublicationCommands,
  projections: PublicationProjections,
  destinationEventName: DestinationEventName,
): EventConfigurationSlice {
  return {
    key: PUBLISHING_TEMPLATE_SLICE_KEY,
    label: "Public page details",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const current = await publication.preview(actor, eventId);
      if (!current) return null;
      const { summary, venue } = current.draft.event;
      // An event whose organizer has typed neither has nothing to lend a template; saying so
      // is what makes the destination's own summary and venue safe from being cleared.
      if (!summary && !venue) return null;
      const payload: PublishingTemplatePayload = { summary, venue };
      return payload;
    },

    async preview(
      actor: Actor | null,
      eventId: string,
      raw: unknown,
      remap: DateRemap,
    ): Promise<SlicePreview> {
      const payload = readPayload(raw);
      const plan = await planClone(
        projections,
        destinationEventName,
        actor,
        eventId,
        payload,
        remap,
      );
      if (plan.reserved)
        return {
          outcome: "incompatible",
          reason: reserved(plan.slug),
          copies: [],
          excludes: EXCLUDED,
          incompatible: [address(plan.slug)],
        };
      return {
        outcome: "copies",
        reason: plan.unchanged
          ? "The destination's public page already says all of this; applying writes nothing."
          : plan.published
            ? "Writes the destination's draft page. Visitors keep the published page, and the address they were given for it, until it is published again."
            : "Writes the destination's draft page, under its own public address and not the source's.",
        copies: entries(payload, plan.slug, remap.destination),
        excludes: EXCLUDED,
        incompatible: [],
      };
    },

    async apply(
      actor: Actor | null,
      eventId: string,
      raw: unknown,
      remap: DateRemap,
    ): Promise<SliceResult> {
      const payload = readPayload(raw);
      const plan = await planClone(
        projections,
        destinationEventName,
        actor,
        eventId,
        payload,
        remap,
      );
      /*
       * Re-applying converges *and* writes nothing.
       *
       * `saveSettings` replaces `draft_json` wholesale and moves the row's served address while
       * nothing is published, so a second apply of the same template would rewrite the row — and
       * re-run the reservation triggers over it — for a change nobody made. Comparing first is
       * what makes "apply twice, then compare" a meaningful assertion rather than one that has
       * to make an exception for the row it churned.
       */
      if (plan.unchanged)
        return {
          outcome: "applied",
          reason: "Already identical to the template; nothing needed to be written.",
          applied: entries(payload, plan.slug, remap.destination),
          incompatible: [],
        };
      if (plan.reserved)
        return {
          outcome: "incompatible",
          reason: reserved(plan.slug),
          applied: [],
          incompatible: [address(plan.slug)],
        };
      let saved: Awaited<ReturnType<PublicationCommands["updateSettings"]>>;
      try {
        saved = await publication.updateSettings(actor, eventId, plan.settings);
      } catch (error) {
        // ERROR-INTENT: The address checked above can be taken between that read and this
        // write, which is the race #124 turned into a 409 rather than a 500. It is the issue's
        // "incompatible" category and not a fault: the organizer is told which address is gone
        // and asked to choose, with the refusal carried in `reason` rather than swallowed.
        if (error instanceof PublicationSlugTakenError)
          return {
            outcome: "incompatible",
            reason: reserved(plan.slug),
            applied: [],
            incompatible: [address(plan.slug)],
          };
        throw error;
      }
      /*
       * `updateSettings` answers null rather than throwing when publishing cannot resolve the
       * destination event at all — no grant on it, or no composer wired. Nothing was written,
       * so reporting "applied" would be a false statement in a product surface; the orchestrator
       * reports this against this category alone.
       */
      if (!saved)
        throw new Error(
          "The destination event's public page could not be read, so nothing was written.",
        );
      return {
        outcome: "applied",
        reason: plan.published
          ? "Copied onto the destination's draft page. Visitors keep the published page, and the address they were given for it, until it is published again."
          : "Copied onto the destination's draft page.",
        applied: entries(payload, plan.slug, remap.destination),
        incompatible: [],
      };
    },
  };
}

interface ClonePlan {
  /** Exactly what `updateSettings` will be handed, and nothing else. */
  readonly settings: PublicationSettings;
  readonly slug: string;
  /** The destination's stored draft already says all of this. */
  readonly unchanged: boolean;
  /** Another event holds that address, in its live column or in its own draft. */
  readonly reserved: boolean;
  /** The destination is published, so its live address only moves at the next publish. */
  readonly published: boolean;
}

/**
 * What this clone would write, and what the destination says about it as it stands.
 *
 * The address is never carried from the source, and it is only *derived* for a destination that
 * has none of its own. An organizer who typed "pycon-oakland-2027" and handed that URL out is
 * saying something about their own event that no template has any standing to overwrite — and a
 * derived address that a neighbour already holds could otherwise never be escaped, because the
 * refusal asks the organizer to choose an address the next apply would ignore.
 *
 * Where a first address is derived, `publicEventSlug` slugifies the destination's own name and
 * appends a discriminator hashed from its event id, which makes it unique-ish and stable — the
 * same event derives the same address on every apply, so nothing here depends on how many times
 * an organizer pressed the button. Unique-ish is the honest word: the uniqueness this system
 * actually enforces lives in the index and the triggers, and `reserved` is a read of that, not a
 * substitute for it.
 */
async function planClone(
  projections: PublicationProjections,
  destinationEventName: DestinationEventName,
  actor: Actor | null,
  eventId: string,
  payload: PublishingTemplatePayload,
  remap: DateRemap,
): Promise<ClonePlan> {
  const current = await projections.findByEventId(eventId);
  /*
   * The draft's address before the row's served one, the order `PublicationService.preview`
   * reads them in: an address the organizer has edited but not yet published lives only in the
   * draft, and taking the served column first would undo that pending rename.
   */
  const slug =
    current?.draft.event.slug ||
    current?.slug ||
    (await derivedSlug(destinationEventName, actor, remap.destination.eventId));
  const settings: PublicationSettings = {
    summary: payload.summary,
    venue: payload.venue,
    slug,
    // The confirmed destination range, and the one place it becomes stored state.
    startsOn: remap.destination.startsOn,
    endsOn: remap.destination.endsOn,
  };
  const owner = await projections.findEventIdBySlug(slug);
  return {
    settings,
    slug,
    unchanged: current !== null && matches(current.draft, settings, slug),
    reserved: owner !== null && owner !== eventId,
    published: current?.state === "published",
  };
}

/** The address an event with no public page of its own gets, from the only thing it has: a name. */
async function derivedSlug(
  destinationEventName: DestinationEventName,
  actor: Actor | null,
  eventId: string,
): Promise<string> {
  const name = await destinationEventName(actor, eventId);
  if (name === null)
    throw new Error(
      "The destination event could not be read, so its public address has no name to derive from.",
    );
  return publicEventSlug(name, eventId);
}

function matches(
  draft: PublicEventProjection,
  settings: PublicationSettings,
  slug: string,
): boolean {
  return (
    draft.event.summary === settings.summary &&
    draft.event.venue === settings.venue &&
    draft.event.slug === slug &&
    draft.event.startsOn === settings.startsOn &&
    draft.event.endsOn === settings.endsOn &&
    // `applyPublicationSettings` re-derives the call for proposals' link from the address, so a
    // stored draft whose link disagrees with its own slug is a change this must not skip.
    draft.cfp.submissionUrl === `/events/${slug}/cfp`
  );
}

const address = (slug: string): SliceEntry => ({
  id: "address",
  label: `Public address: /events/${slug}`,
});

/**
 * The one refusal an organizer has to act on, so it names an act that changes the outcome:
 * the address this apply would use is settled on the publishing page, and the next apply reuses
 * whatever is chosen there rather than deriving over it again.
 */
const reserved = (slug: string): string =>
  `The public address “${slug}” already belongs to another event. Choose a different public address for this event on its publishing page, then apply the template again.`;

function entries(
  payload: PublishingTemplatePayload,
  slug: string,
  destination: DateRemap["destination"],
): readonly SliceEntry[] {
  return [
    {
      id: "summary",
      label: payload.summary
        ? "Public summary"
        : "Public summary, which this template leaves empty",
    },
    {
      id: "venue",
      label: payload.venue ? `Venue: ${payload.venue}` : "Venue, which this template leaves empty",
    },
    address(slug),
    { id: "dates", label: `Public dates: ${destination.startsOn} to ${destination.endsOn}` },
  ];
}

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * It was serialized by this slice, but it has since been at rest in a table an operator can
 * write to, and it reaches `updateSettings` without passing the Zod schema that guards the HTTP
 * settings form. Reading exactly two strings is also what makes a payload carrying a `slug`,
 * `sessions`, `speakers` or a published snapshot harmless: nothing here looks at them, so no
 * edit to a stored version can smuggle one of them onto a destination's page.
 */
function readPayload(raw: unknown): PublishingTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.summary !== "string" || typeof candidate.venue !== "string")
    throw unreadable();
  return { summary: candidate.summary, venue: candidate.venue };
}

function unreadable(): Error {
  return new Error("This template's stored public page configuration could not be read.");
}
