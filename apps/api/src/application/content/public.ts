import type { ContentWorkspace } from "../../domain/content/content";

// Narrow read boundary for agenda, publishing, CRM, and communications consumers.
export interface ContentQuery {
  workspace(eventId: string): Promise<ContentWorkspace>;
}
