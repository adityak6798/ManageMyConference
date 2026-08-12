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
