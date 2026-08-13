import {
  type AnySQLiteColumn,
  index,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Platform's own storage, which is deliberately almost nothing.
 *
 * The operational inbox derives every item from the owning domains' reads on each request, so
 * there is no work queue here to keep in step with the world. What cannot be derived is one
 * person's decision to stop being shown an occurrence, and that is the single table below.
 */
export function definePlatformSchema(references: {
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-OPS-001
  const platformInboxDismissals = sqliteTable(
    "platform_inbox_dismissals",
    {
      /** Cascades: a dismissal has nothing to say once its event is gone. See migration 1900. */
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      /**
       * Identity *and* occurrence, as an opaque string.
       *
       * Not a foreign key, and it cannot be one: the conditions it names live in five other
       * domains, and a reference into any of them would be platform holding a pointer at another
       * domain's row. The key carries the occurrence — a deadline, an attempt count — so a
       * re-derived identical item stays dismissed while a new occurrence comes back.
       */
      itemKey: text("item_key").notNull(),
      actorId: text("actor_id")
        .notNull()
        .references(() => references.usersId, { onDelete: "cascade" }),
      dismissedAt: text("dismissed_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.itemKey, table.actorId] }),
      index("platform_inbox_dismissals_event_actor_idx").on(table.eventId, table.actorId),
    ],
  );

  return { platformInboxDismissals };
}
