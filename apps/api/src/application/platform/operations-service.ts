/**
 * The platform domain's operational read surface.
 *
 * One service rather than several, because search and the inbox compose the same set of domain
 * reads under the same per-source authorization rule, and because the transport takes exactly
 * one named dependency for the whole of this lane. Each capability lives in its own module; this
 * composes them and is what the composition root constructs.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
import type { Actor } from "../identity/actor";
import type { InboxDismissal, InboxDismissalStore, PlatformInboxAnswer } from "./inbox-service";
import { PlatformInboxService } from "./inbox-service";
import type { PlatformSearchAnswer } from "./search-service";
import { PlatformSearchService } from "./search-service";
import type { PlatformSources } from "./sources";

export interface PlatformOperationsDependencies {
  readonly sources: PlatformSources;
  readonly dismissals: InboxDismissalStore;
  readonly now: () => Date;
}

export class PlatformOperationsService {
  private readonly searchService: PlatformSearchService;
  private readonly inboxService: PlatformInboxService;

  constructor(dependencies: PlatformOperationsDependencies) {
    this.searchService = new PlatformSearchService(dependencies.sources);
    this.inboxService = new PlatformInboxService(dependencies);
  }

  search(
    actor: Actor | null,
    eventId: string,
    query: string,
    limit: number,
  ): Promise<PlatformSearchAnswer> {
    return this.searchService.search(actor, eventId, query, limit);
  }

  inbox(actor: Actor | null, eventId: string): Promise<PlatformInboxAnswer> {
    return this.inboxService.inbox(actor, eventId);
  }

  dismissInboxItem(actor: Actor | null, eventId: string, itemKey: string): Promise<InboxDismissal> {
    return this.inboxService.dismiss(actor, eventId, itemKey);
  }

  restoreInboxItem(actor: Actor | null, eventId: string, itemKey: string): Promise<void> {
    return this.inboxService.restore(actor, eventId, itemKey);
  }
}
