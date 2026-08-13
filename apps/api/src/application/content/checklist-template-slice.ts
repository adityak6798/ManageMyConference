/**
 * Content's speaker task checklists, as a reusable event template.
 *
 * A checklist line is what an organizer asks every speaker for — a headshot, a slide deck by
 * the Friday before — expressed once, as event configuration, rather than re-typed per person
 * per year. That is exactly the shape a template wants, and it is why the concept exists as its
 * own table: `speaker_tasks.speaker_profile_id` is `NOT NULL`, so the only thing that could
 * have been copied before this slice was somebody's actual homework.
 *
 * Which is what this slice refuses to do. It copies the lines and never the assignments: no
 * task, no due date somebody is working towards, and nobody's name. Instantiating the checklist
 * against real speakers is a separate, deliberate command an organizer runs on the destination
 * (`ContentService.assignTaskChecklist`), because turning a clone into thirty people's work
 * without anybody asking is not a thing a clone should do.
 *
 * Keyed separately from `content-resources` so an organizer can take the portal shelf without
 * the checklist, or the checklist without the shelf.
 *
 * @spec PRD-SPK-002 PRD-CNT-001 PRD-EVT-002 ARC-DOM-001
 */
import type {
  EventConfigurationSlice,
  SliceEntry,
  SlicePreview,
  SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import type {
  ContentImportRow,
  ContentService,
  SpeakerTaskTemplateImport,
} from "./content-service";

export const CONTENT_CHECKLIST_TEMPLATE_SLICE_KEY = "content-checklists";

interface ContentChecklistTemplatePayload {
  readonly templates: readonly SpeakerTaskTemplateImport[];
}

type ContentChecklistTemplateCommands = Pick<
  ContentService,
  "importTaskTemplates" | "taskTemplates"
>;

/**
 * The two things this deliberately leaves behind, named so the omission is visible.
 *
 * Assigned tasks are the important one: a template that carried them would hand the destination
 * a pile of work belonging to speakers who have not been invited to it yet.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "assignments", label: "Tasks already assigned to speakers, and what they have completed" },
  { id: "speakers", label: "The speakers a checklist would be assigned to" },
];

export function speakerChecklistTemplateSlice(
  service: ContentChecklistTemplateCommands,
): EventConfigurationSlice {
  return {
    key: CONTENT_CHECKLIST_TEMPLATE_SLICE_KEY,
    label: "Speaker task checklists",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const templates = await service.taskTemplates(actor, eventId);
      if (templates.length === 0) return null;
      // No id, no `createdAt`: both are facts about the source event's rows. The destination
      // mints its own, and a line it already has keeps the date it was actually declared on.
      const payload: ContentChecklistTemplatePayload = {
        templates: templates.map(({ title, description, sortOrder, dueOffsetDays }) => ({
          title,
          description,
          sortOrder,
          dueOffsetDays,
        })),
      };
      return payload;
    },

    async preview(actor: Actor | null, eventId: string, raw: unknown): Promise<SlicePreview> {
      const payload = readPayload(raw);
      if (payload.templates.length === 0)
        return {
          outcome: "skipped",
          reason: "This template carries no speaker checklist.",
          copies: [],
          excludes: EXCLUDED,
          incompatible: [],
        };
      // The real import in its writing-nothing form, so a preview cannot describe a different
      // outcome from the one applying would produce.
      const { rows } = await service.importTaskTemplates(actor, {
        eventId,
        templates: payload.templates,
        commit: false,
      });
      return {
        outcome: "copies",
        reason: reasonFor(rows),
        copies: rows.map(entry),
        excludes: EXCLUDED,
        incompatible: [],
      };
    },

    async apply(actor: Actor | null, eventId: string, raw: unknown): Promise<SliceResult> {
      const payload = readPayload(raw);
      if (payload.templates.length === 0)
        return {
          outcome: "skipped",
          reason: "This template carries no speaker checklist.",
          applied: [],
          incompatible: [],
        };
      const command = { eventId, templates: payload.templates };
      const planned = await service.importTaskTemplates(actor, { ...command, commit: false });
      // Compare first, exactly as the resources slice does and for the same reason: applying a
      // second time must converge *and* write nothing, so "apply twice, then compare" is an
      // assertion about the destination rather than about a re-stamped row.
      if (writable(planned.rows).length === 0)
        return {
          outcome: "applied",
          reason:
            "The destination's checklist already matches this template; nothing needed to be written.",
          applied: planned.rows.map(entry),
          incompatible: [],
        };
      const { rows } = await service.importTaskTemplates(actor, { ...command, commit: true });
      return {
        outcome: "applied",
        reason: reasonFor(rows),
        applied: rows.map(entry),
        incompatible: [],
      };
    },
  };
}

const entry = (row: ContentImportRow): SliceEntry => ({
  id: row.key,
  label: `Checklist line: ${row.label}`,
});

const writable = (rows: readonly ContentImportRow[]): readonly ContentImportRow[] =>
  rows.filter(({ disposition }) => disposition === "created" || disposition === "updated");

function reasonFor(rows: readonly ContentImportRow[]): string {
  return writable(rows).length === 0
    ? "The destination's checklist already matches this template; applying writes nothing."
    : "Copies the checklist itself. Nobody is assigned anything until an organizer says so.";
}

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * Same standing as the resources payload: serialized by this slice, since at rest in a table an
 * operator can write to, and reaching a write command that no HTTP schema guards.
 */
function readPayload(raw: unknown): ContentChecklistTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.templates)) throw unreadable();
  return { templates: candidate.templates.map(readTemplate) };
}

function readTemplate(raw: unknown): SpeakerTaskTemplateImport {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.title !== "string" ||
    // The title is the line's identity in an event (`UNIQUE(event_id, title)`); a blank one is
    // not an identity, and two of them would collide.
    candidate.title.trim() === "" ||
    typeof candidate.description !== "string" ||
    typeof candidate.sortOrder !== "number" ||
    !Number.isFinite(candidate.sortOrder) ||
    // A whole number of days. A fractional offset would derive a due date at an arbitrary hour
    // nobody chose, and `INTEGER` is what the column stores.
    typeof candidate.dueOffsetDays !== "number" ||
    !Number.isInteger(candidate.dueOffsetDays)
  )
    throw unreadable();
  return {
    title: candidate.title,
    description: candidate.description,
    sortOrder: candidate.sortOrder,
    dueOffsetDays: candidate.dueOffsetDays,
  };
}

function unreadable(): Error {
  return new Error("This template's stored speaker checklist could not be read.");
}
