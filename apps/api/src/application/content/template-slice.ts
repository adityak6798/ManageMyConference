/**
 * Content's speaker-portal resources, as a reusable event template.
 *
 * Resources are the part of a speaker portal that is genuinely the same conference year after
 * year: the travel guide, the recording checklist, the brand kit. Nothing else content owns is
 * — a speaker profile is a person, a task is that person's work, an upload is their file — so
 * this slice copies the shelf and never the people standing at it, and says which is which in
 * `excludes` rather than leaving the omission to be noticed.
 *
 * Two things make it safe to apply twice. Resources are written at their `(event_id, slug)`
 * identity, so the second application converges instead of raising the unique violation an
 * insert would; and the markup is re-sanitized on the way in, because by the time a template is
 * applied its payload has been at rest in a table an operator can write to. Both live in
 * `ContentService.importSpeakerResources`, which is the only door this slice knocks on.
 *
 * @spec PRD-CNT-001 PRD-EVT-002 ARC-DOM-001
 */
import type { ResourceVisibility } from "../../domain/content/content";
import {
  type EventConfigurationSlice,
  type SliceEntry,
  type SlicePreview,
  SliceRefusalError,
  type SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import type { ContentImportRow, ContentService, SpeakerResourceImport } from "./content-service";

export const CONTENT_RESOURCE_TEMPLATE_SLICE_KEY = "content-resources";

interface ContentResourceTemplatePayload {
  readonly resources: readonly SpeakerResourceImport[];
}

type ContentResourceTemplateCommands = Pick<ContentService, "importSpeakerResources" | "workspace">;

/**
 * Everything else the content workspace holds, named rather than merely left behind.
 *
 * A category nobody can see was excluded reads as one that was copied, and here the difference
 * matters more than anywhere else in the system: these are real people, their unpublished
 * files, and messages already sent to them. A clone that quietly carried them into a second
 * event would be a disclosure, not a convenience.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "sessions", label: "Accepted sessions, which come from this event's own CFP" },
  { id: "speakers", label: "Speaker profiles and everyone behind them" },
  { id: "tasks", label: "Assigned speaker tasks and their due dates" },
  { id: "assets", label: "Uploaded deliverables and the comments on them" },
  { id: "messages", label: "Messages already sent to speakers" },
];

/**
 * @param embedAllowedHosts the *destination's* embed allowlist, supplied by the composition
 * root. Deliberately not read from the payload: a stored template that could name its own
 * allowed hosts would be a stored payload authorizing its own iframe, which is the whole thing
 * the allowlist exists to prevent. A deployment that names none refuses every embed and says
 * so, which is the safe direction to fail in.
 */
export function speakerResourceTemplateSlice(
  service: ContentResourceTemplateCommands,
  embedAllowedHosts: readonly string[] = [],
): EventConfigurationSlice {
  return {
    key: CONTENT_RESOURCE_TEMPLATE_SLICE_KEY,
    label: "Speaker portal resources",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const workspace = await service.workspace(actor, eventId);
      const resources = workspace.resources ?? [];
      if (resources.length === 0) return null;
      // Ids are dropped: they belong to the source event, and a payload carrying them would
      // invite an import to write at a destination row it was never shown.
      const payload: ContentResourceTemplatePayload = {
        resources: resources.map(({ title, slug, bodyHtml, embedHtml, visibility, sortOrder }) => ({
          title,
          slug,
          bodyHtml,
          embedHtml,
          visibility,
          sortOrder,
        })),
      };
      return payload;
    },

    async preview(actor: Actor | null, eventId: string, raw: unknown): Promise<SlicePreview> {
      const payload = readPayload(raw);
      if (payload.resources.length === 0)
        return {
          outcome: "skipped",
          reason: "This template carries no speaker resources.",
          copies: [],
          excludes: EXCLUDED,
          incompatible: [],
        };
      // `commit: false` runs the real import — sanitizer, slug lookup and all — and writes
      // nothing, so the preview and the write it describes cannot drift apart.
      const { rows } = await service.importSpeakerResources(actor, {
        eventId,
        resources: payload.resources,
        embedAllowedHosts,
        commit: false,
      });
      // A row the destination already holds is still a copy this template accounts for, which
      // is how `apply` counts it too. Counting only what would be written made a second preview
      // of an applied template answer `incompatible` — while `apply` answered `applied` for
      // that same state, and while this very list named two resources.
      const copies = [...writable(rows), ...unchanged(rows)];
      return {
        outcome: copies.length === 0 ? "incompatible" : "copies",
        reason: reasonFor(rows),
        copies,
        excludes: EXCLUDED,
        incompatible: refused(rows),
      };
    },

    async apply(actor: Actor | null, eventId: string, raw: unknown): Promise<SliceResult> {
      const payload = readPayload(raw);
      if (payload.resources.length === 0)
        return {
          outcome: "skipped",
          reason: "This template carries no speaker resources.",
          applied: [],
          incompatible: [],
        };
      const command = {
        eventId,
        resources: payload.resources,
        embedAllowedHosts,
      };
      const planned = await service.importSpeakerResources(actor, { ...command, commit: false });
      /*
       * Compare before writing, and return early when there is nothing to write.
       *
       * Without this, applying the same template twice would rewrite every row with the bytes
       * it already holds. Nothing in `speaker_resources` records that today, but every other
       * service command in this repository stamps a version or a timestamp, and "apply twice,
       * then compare" should be an assertion that holds without an exception carved out for a
       * counter nobody changed.
       */
      if (writable(planned.rows).length === 0)
        return {
          outcome: unchanged(planned.rows).length > 0 ? "applied" : "incompatible",
          reason:
            unchanged(planned.rows).length > 0
              ? "The destination's resources already match this template; nothing needed to be written."
              : "No resource could be copied; each is named with the destination's own refusal.",
          applied: unchanged(planned.rows),
          incompatible: refused(planned.rows),
        };
      const { rows } = await service.importSpeakerResources(actor, { ...command, commit: true });
      return {
        outcome: "applied",
        reason: reasonFor(rows),
        applied: [...writable(rows), ...unchanged(rows)],
        incompatible: refused(rows),
      };
    },
  };
}

const entry = (row: ContentImportRow): SliceEntry => ({ id: row.key, label: row.label });

const writable = (rows: readonly ContentImportRow[]): SliceEntry[] =>
  rows
    .filter(({ disposition }) => disposition === "created" || disposition === "updated")
    .map(entry);

const unchanged = (rows: readonly ContentImportRow[]): SliceEntry[] =>
  rows.filter(({ disposition }) => disposition === "unchanged").map(entry);

/** The refusal's own words travel in the label, because they are what an organizer must act on. */
const refused = (rows: readonly ContentImportRow[]): SliceEntry[] =>
  rows
    .filter(({ disposition }) => disposition === "refused")
    .map((row) => ({ id: row.key, label: `${row.label}: ${row.reason ?? "refused"}` }));

function reasonFor(rows: readonly ContentImportRow[]): string {
  const left = refused(rows).length;
  const named = `${left === 1 ? "One resource" : `${left} resources`} the destination will not host ${left === 1 ? "is" : "are"} left out and named.`;
  // `apply` returns early rather than committing a plan with nothing in it, so this branch is
  // the preview's: it states what those early returns state, in the tense of a write that has
  // not happened. Saying "copies the portal resources" here claimed work nobody would do.
  if (writable(rows).length === 0)
    return unchanged(rows).length === 0
      ? "No resource could be copied; each is named with the destination's own refusal."
      : `The destination's resources already match this template; applying writes nothing.${left === 0 ? "" : ` ${named}`}`;
  return left === 0
    ? "Copies the portal resources. Speakers, their tasks and their files stay put."
    : `Copies the portal resources. ${named}`;
}

const VISIBILITIES: readonly ResourceVisibility[] = ["hidden", "visible"];

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * This one was serialized by this slice, but it has since been at rest in a table an operator
 * can write to, and it reaches a write command without passing the Zod schema that guards the
 * HTTP resource composer. So it is validated here instead of trusted here — and validation is
 * only half the job: the markup itself is re-sanitized inside `importSpeakerResources`, where
 * no caller can skip it.
 */
function readPayload(raw: unknown): ContentResourceTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.resources)) throw unreadable();
  const resources: readonly SpeakerResourceImport[] = candidate.resources.map(readResource);
  // Two entries at one slug are the blank-slug collision below with a name on it: the second
  // overwrites the first at `(event_id, slug)`, so both are reported written on every run and
  // the payload never converges. Refused whole rather than deduplicated — which of the two the
  // organizer meant is not something the payload says.
  if (new Set(resources.map(({ slug }) => slug)).size !== resources.length) throw unreadable();
  return { resources };
}

function readResource(raw: unknown): SpeakerResourceImport {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.slug !== "string" ||
    // A blank slug is not an identity: two of them would collide on `UNIQUE(event_id, slug)`
    // and an import has no way to tell which row it just overwrote.
    candidate.slug.trim() === "" ||
    typeof candidate.bodyHtml !== "string" ||
    typeof candidate.embedHtml !== "string" ||
    !VISIBILITIES.includes(candidate.visibility as ResourceVisibility) ||
    typeof candidate.sortOrder !== "number" ||
    !Number.isFinite(candidate.sortOrder)
  )
    throw unreadable();
  return {
    title: candidate.title,
    slug: candidate.slug,
    bodyHtml: candidate.bodyHtml,
    embedHtml: candidate.embedHtml,
    visibility: candidate.visibility as ResourceVisibility,
    sortOrder: candidate.sortOrder,
  };
}

/**
 * A refusal, not a fault: what this reader turns down is a fixed property of bytes already at
 * rest, so the orchestrator's generic "apply this version again" would be false advice and an
 * operator paged for it would find nothing broken. The organizer is told which category of which
 * version to recapture instead, which is the only act that changes the answer.
 */
function unreadable(): SliceRefusalError {
  return new SliceRefusalError("This template's stored speaker resources could not be read.");
}
