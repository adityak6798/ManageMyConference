import { z } from "zod";

// @spec PRD-EVT-001
export const createEventInputSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, "Event name is required").max(120),
  timezone: z.string().trim().min(1).default("America/Los_Angeles"),
});

export const updateEventInputSchema = z.object({
  name: z.string().trim().min(1, "Event name is required").max(120),
  timezone: z
    .string()
    .trim()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
      } catch {
        // ERROR-INTENT: Intl reports unsupported IANA zones by throwing.
        return false;
      }
    }, "Timezone must be a valid IANA time zone"),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  createdAt: z.string().datetime(),
});

export type EventDto = z.infer<typeof eventSchema>;
export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() });

export const eventListResponseSchema = z.object({ events: z.array(eventSchema) });
export const createEventResponseSchema = z.object({ event: eventSchema });
export const updateEventResponseSchema = createEventResponseSchema;

/*
 * Reusable event templates (`PRD-EVT-002`).
 *
 * Two things this surface deliberately does not carry. There is no destination *event* here:
 * a template is applied to an event that already exists, because the organizer grant created
 * with an event does not reach the actor already resolved for the in-flight request, so
 * creating and configuring in one call would deny itself. And the stored slice payloads never
 * cross this boundary — a version is described by which categories it holds, not by their
 * contents, which belong to the domains that wrote them.
 */

export const organizationIdParamsSchema = z.object({ organizationId: z.string().uuid() });
export const eventTemplateIdParamsSchema = z.object({ templateId: z.string().uuid() });

export const eventTemplateSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  state: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EventTemplateDto = z.infer<typeof eventTemplateSchema>;

export const eventTemplateVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  sourceEventId: z.string().uuid(),
  sourceEventName: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  /**
   * What the capturing account is *called*, resolved through identity, or null when identity
   * holds no such user — or when a deployment composes no directory for this service at all.
   *
   * The id stays beside it rather than being replaced. A console prints the name and falls back
   * to naming the id as an account, which is what issue #154 established for content revisions
   * and what issue #176 asked for here: "by account 7f3c-…" is a true sentence about a stored
   * value, where "by 7f3c-…" reads as somebody's name.
   */
  createdByName: z.string().nullable(),
  /** The slice keys this version actually carries a payload for. */
  slices: z.array(z.string()),
});
export type EventTemplateVersionDto = z.infer<typeof eventTemplateVersionSchema>;

const sliceEntrySchema = z.object({ id: z.string(), label: z.string() });

export const sliceCaptureReportSchema = z.object({
  key: z.string(),
  label: z.string(),
  outcome: z.enum(["captured", "empty", "unauthorized", "failed"]),
  reason: z.string(),
});

export const slicePreviewSchema = z.object({
  key: z.string(),
  label: z.string(),
  outcome: z.enum(["copies", "skipped", "incompatible", "unauthorized", "failed"]),
  reason: z.string(),
  copies: z.array(sliceEntrySchema),
  excludes: z.array(sliceEntrySchema),
  incompatible: z.array(sliceEntrySchema),
});

export const sliceResultSchema = z.object({
  key: z.string(),
  label: z.string(),
  outcome: z.enum(["applied", "skipped", "incompatible", "unauthorized", "failed"]),
  reason: z.string(),
  applied: z.array(sliceEntrySchema),
  incompatible: z.array(sliceEntrySchema),
});

const templateApplicationIdentitySchema = z.object({
  templateId: z.string().uuid(),
  templateName: z.string(),
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  sourceEventId: z.string().uuid(),
  sourceEventName: z.string(),
  eventId: z.string().uuid(),
  destination: z.object({ startsOn: z.string(), endsOn: z.string() }),
});

export const templateApplicationPlanSchema = templateApplicationIdentitySchema.extend({
  slices: z.array(slicePreviewSchema),
});

export const templateApplicationResultSchema = templateApplicationIdentitySchema.extend({
  appliedAt: z.string().datetime(),
  /**
   * `partial` is a real, reachable answer, not a defensive default. Nothing in this repository
   * spans a transaction across seven domains, so a slice that fails leaves the ones that
   * already succeeded in place; re-applying is the repair (`ARC-FLOW-006`).
   *
   * `applied` therefore means every selected category arrived: one the destination refused or
   * the account may not write is `partial` too, because a console that renders a plain success
   * over a clone whose routing was dropped has told the organizer something untrue. `skipped`
   * is an application that wrote nothing and refused nothing — every category unselected or
   * carrying no payload — which is not a success and is not a failure either.
   */
  outcome: z.enum(["applied", "partial", "failed", "skipped"]),
  slices: z.array(sliceResultSchema),
});

/**
 * One application of one template version to one event, read back from storage.
 *
 * This is what closes issue #175. The per-category outcome was written to
 * `event_template_applications.outcome_json` on every apply and no query ever selected it, so a
 * category that did not land was reported once — in the response to the click — and never
 * mentioned again. An organizer who closed the tab had no way to learn that their event was
 * configured in part, and a partial application looks exactly like a complete one from every
 * other surface.
 *
 * `destination` is carried because the repair needs it. The range is a parameter of the clone
 * rather than a property of the event, so nothing else could reconstruct it, and re-applying is
 * only "one action away" if the action does not begin by asking for two dates again.
 */
export const eventTemplateApplicationSchema = z.object({
  templateId: z.string().uuid(),
  templateName: z.string(),
  /** An archived template cannot be applied, so a repair offered against one would 409. */
  templateState: z.enum(["active", "archived"]),
  templateVersionId: z.string().uuid(),
  version: z.number().int().positive(),
  appliedAt: z.string().datetime(),
  appliedBy: z.string(),
  /** Resolved through identity, null when unresolvable. Same rule as `createdByName`. */
  appliedByName: z.string().nullable(),
  outcome: z.enum(["applied", "partial", "failed", "skipped"]),
  destination: z.object({ startsOn: z.string(), endsOn: z.string() }),
  /**
   * The categories the original command named. Absent when it named none, which means every
   * category the version carries — so a repair repeats the request that was actually made
   * rather than a wider one.
   */
  selection: z.array(z.string()).optional(),
  slices: z.array(sliceResultSchema),
});
export type EventTemplateApplicationDto = z.infer<typeof eventTemplateApplicationSchema>;

const templateNameSchema = z.string().trim().min(1, "Template name is required").max(120);

export const saveEventTemplateInputSchema = z.object({
  name: templateNameSchema,
  sourceEventId: z.string().uuid(),
});
export type SaveEventTemplateInput = z.infer<typeof saveEventTemplateInputSchema>;

export const captureEventTemplateVersionInputSchema = z.object({
  sourceEventId: z.string().uuid(),
});
export type CaptureEventTemplateVersionInput = z.infer<
  typeof captureEventTemplateVersionInputSchema
>;

export const updateEventTemplateInputSchema = z
  .object({
    name: templateNameSchema.optional(),
    state: z.enum(["active", "archived"]).optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.state !== undefined,
    "Send a new name, a new state, or both",
  );
export type UpdateEventTemplateInput = z.infer<typeof updateEventTemplateInputSchema>;

export const duplicateEventTemplateInputSchema = z.object({ name: templateNameSchema });
export type DuplicateEventTemplateInput = z.infer<typeof duplicateEventTemplateInputSchema>;

/**
 * The destination range is required and is a parameter of the clone, not a property of the
 * event: nothing in `events` carries a start or end date today, and adding one ripples into
 * publishing's date-resolution rule. Recorded in the pull request and in `ARC-FLOW-006`.
 */
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD for the destination dates");

export const applyEventTemplateInputSchema = z.object({
  templateId: z.string().uuid(),
  /** Explicit. "Latest" would make the same request produce a different event next week. */
  version: z.number().int().positive(),
  destination: z.object({ startsOn: calendarDateSchema, endsOn: calendarDateSchema }),
  /**
   * Omitted clones every category the version carries; a list clones only those keys.
   *
   * Which keys exist is a property of the deployment's composition rather than of this schema,
   * so the server is what refuses one it does not compose — with a 400 naming the key and the
   * ones that do exist. It cannot be checked here without this package learning the slice list.
   */
  slices: z.array(z.string().min(1, "A category key cannot be empty")).optional(),
});
export type ApplyEventTemplateInput = z.infer<typeof applyEventTemplateInputSchema>;

export const eventTemplateListResponseSchema = z.object({
  templates: z.array(eventTemplateSchema),
});
export const eventTemplateResponseSchema = z.object({ template: eventTemplateSchema });
export const eventTemplateDetailResponseSchema = z.object({
  template: eventTemplateSchema,
  versions: z.array(eventTemplateVersionSchema),
});
export const eventTemplateCaptureResponseSchema = z.object({
  template: eventTemplateSchema,
  version: eventTemplateVersionSchema,
  slices: z.array(sliceCaptureReportSchema),
});
export const templateApplicationPlanResponseSchema = z.object({
  plan: templateApplicationPlanSchema,
});
export const templateApplicationResponseSchema = z.object({
  application: templateApplicationResultSchema,
});
export const eventTemplateApplicationListResponseSchema = z.object({
  /** Newest first. Every version this event was configured from, not only the last one. */
  applications: z.array(eventTemplateApplicationSchema),
});
