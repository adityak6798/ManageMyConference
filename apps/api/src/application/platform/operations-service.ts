/**
 * The platform domain's operational read surface.
 *
 * One service rather than three, because search, the inbox and the audit timeline compose the
 * same set of domain reads under the same per-source authorization rule, and because the
 * transport takes exactly one named dependency for the whole of this lane. Each capability
 * lives in its own module; this composes them and is what the composition root constructs.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
import type { Actor } from "../identity/actor";
import type { PlatformSearchAnswer, PlatformSearchDependencies } from "./search-service";
import { PlatformSearchService } from "./search-service";

export interface PlatformOperationsDependencies extends PlatformSearchDependencies {}

export class PlatformOperationsService {
  private readonly searchService: PlatformSearchService;

  constructor(dependencies: PlatformOperationsDependencies) {
    this.searchService = new PlatformSearchService(dependencies);
  }

  search(
    actor: Actor | null,
    eventId: string,
    query: string,
    limit: number,
  ): Promise<PlatformSearchAnswer> {
    return this.searchService.search(actor, eventId, query, limit);
  }
}
