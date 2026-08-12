export * from "./domains/agenda";
export * from "./domains/cfp";
export * from "./domains/communications-integrations";
export * from "./domains/content";
export * from "./domains/crm";
export * from "./domains/events";
export * from "./domains/identity-access";
export * from "./domains/platform";
export * from "./domains/publishing";
export * from "./domains/review";

import { z } from "zod";
import { agendaDraftSchema } from "./domains/agenda";
import { contentWorkspaceSchema } from "./domains/content";
import { apiErrorEnvelopeSchema } from "./domains/platform";
import { publicationPreviewResponseSchema } from "./domains/publishing";
import { organizerReviewWorkspaceSchema } from "./domains/review";

const overviewPanel = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: apiErrorEnvelopeSchema.shape.error }),
  ]);

/** One request, with independently degradable domain results, for the organizer landing page. */
export const organizerOverviewResponseSchema = z.object({
  content: overviewPanel(contentWorkspaceSchema),
  review: overviewPanel(organizerReviewWorkspaceSchema),
  agenda: overviewPanel(agendaDraftSchema),
  publication: overviewPanel(publicationPreviewResponseSchema.shape.publication),
});
export type OrganizerOverviewDto = z.infer<typeof organizerOverviewResponseSchema>;
