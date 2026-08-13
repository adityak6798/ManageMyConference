/*
 * Inbox dismissals against D1.
 *
 * The whole of platform's storage. Every other thing the operational surfaces show is derived
 * from another domain's read at request time, which is why this adapter has three methods and no
 * projection to maintain.
 *
 * @spec PRD-OPS-001
 */
import type { InboxDismissal, InboxDismissalStore } from "../../application/platform/public";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<D1WriteResult>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
type Database = { prepare(query: string): Statement };

interface DismissalRow {
  event_id: string;
  item_key: string;
  actor_id: string;
  dismissed_at: string;
}

export class D1InboxDismissalStore implements InboxDismissalStore {
  constructor(private readonly database: Database) {}

  async list(eventId: string, actorId: string): Promise<readonly InboxDismissal[]> {
    const result = await this.database
      .prepare(
        "SELECT event_id, item_key, actor_id, dismissed_at FROM platform_inbox_dismissals WHERE event_id = ? AND actor_id = ?",
      )
      .bind(eventId, actorId)
      .all<DismissalRow>();
    if (!result.success) throw new Error("Failed to read inbox dismissals");
    return (result.results ?? []).map((row) => ({
      eventId: row.event_id,
      itemKey: row.item_key,
      actorId: row.actor_id,
      dismissedAt: row.dismissed_at,
    }));
  }

  /**
   * Idempotent by primary key.
   *
   * Dismissing something already dismissed keeps the first decision's timestamp rather than
   * refreshing it: the surface shows when the operator set it aside, and a double click on a
   * list that had not repainted yet must not rewrite that answer.
   */
  async dismiss(dismissal: InboxDismissal): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO platform_inbox_dismissals (event_id, item_key, actor_id, dismissed_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, item_key, actor_id) DO NOTHING",
      )
      .bind(dismissal.eventId, dismissal.itemKey, dismissal.actorId, dismissal.dismissedAt)
      .run();
    if (!result.success) throw new Error("Failed to record inbox dismissal");
    // Counted rather than assumed: `DO NOTHING` and a refused write both answer success, and a
    // driver that cannot say how many rows it touched is a failure rather than a silent zero.
    changedRows(result, "record an inbox dismissal");
  }

  /** True when a dismissal was actually removed, so a caller can tell undo from nothing-to-undo. */
  async restore(eventId: string, itemKey: string, actorId: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "DELETE FROM platform_inbox_dismissals WHERE event_id = ? AND item_key = ? AND actor_id = ?",
      )
      .bind(eventId, itemKey, actorId)
      .run();
    if (!result.success) throw new Error("Failed to restore inbox item");
    return changedRows(result, "restore an inbox item") > 0;
  }
}

/** The in-memory twin the service suites drive, following the `memory-*` convention. */
export class MemoryInboxDismissalStore implements InboxDismissalStore {
  private readonly rows = new Map<string, InboxDismissal>();

  /**
   * The composite primary key, as one map key.
   *
   * Serialized rather than joined by a separator: an item key is opaque text produced by five
   * different derivations, so any character chosen as a separator is one an item key could
   * legitimately contain, and two different triples would then collide into one row.
   */
  private static key(eventId: string, itemKey: string, actorId: string) {
    return JSON.stringify([eventId, itemKey, actorId]);
  }

  async list(eventId: string, actorId: string): Promise<readonly InboxDismissal[]> {
    return [...this.rows.values()].filter(
      (row) => row.eventId === eventId && row.actorId === actorId,
    );
  }

  async dismiss(dismissal: InboxDismissal): Promise<void> {
    const key = MemoryInboxDismissalStore.key(
      dismissal.eventId,
      dismissal.itemKey,
      dismissal.actorId,
    );
    if (!this.rows.has(key)) this.rows.set(key, dismissal);
  }

  async restore(eventId: string, itemKey: string, actorId: string): Promise<boolean> {
    return this.rows.delete(MemoryInboxDismissalStore.key(eventId, itemKey, actorId));
  }
}
