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
import type { AuditPage, AuditRecorder, RequestIdentity } from "./audit-service";
import type { InboxDismissal, InboxDismissalStore, PlatformInboxAnswer } from "./inbox-service";
import { PlatformInboxService } from "./inbox-service";
import type { PlatformSearchAnswer } from "./search-service";
import { PlatformSearchService } from "./search-service";
import type { PlatformSources } from "./sources";

export interface PlatformOperationsDependencies {
  readonly sources: PlatformSources;
  readonly dismissals: InboxDismissalStore;
  readonly now: () => Date;
  /**
   * The audit timeline's reader, and the per-request identity its writers attribute to.
   *
   * Optional together: a composition exercising only search and the inbox wires neither, and the
   * audit route then answers as an unconfigured service rather than pretending to have a log.
   */
  readonly audit?: AuditRecorder | undefined;
  readonly identity?: RequestIdentity | undefined;
}

export class PlatformOperationsService {
  private readonly searchService: PlatformSearchService;
  private readonly inboxService: PlatformInboxService;

  constructor(private readonly dependencies: PlatformOperationsDependencies) {
    this.searchService = new PlatformSearchService(dependencies.sources);
    this.inboxService = new PlatformInboxService(dependencies);
  }

  /**
   * Tell platform whose request this is.
   *
   * Called once per request by platform's own transport middleware, which is the first thing the
   * route registry mounts. Everything that records an audit row afterwards is deep inside a
   * domain that has no business being handed an actor, so the identity is held for the length of
   * the request instead of threaded through nine call sites. The Worker builds every service
   * inside `fetch`, so this holder is per invocation and two concurrent requests cannot see each
   * other's.
   */
  observeRequest(actor: Actor | null, correlationId: string | null): void {
    this.dependencies.identity?.set({ actor, correlationId });
  }

  auditTimeline(
    actor: Actor | null,
    eventId: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<AuditPage> {
    if (!this.dependencies.audit) throw new Error("Audit recorder is not configured");
    return this.dependencies.audit.timeline(actor, eventId, page);
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
