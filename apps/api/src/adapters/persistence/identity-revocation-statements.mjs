// @spec PRD-IAM-001 ARC-AUTH-001
/**
 * The SQL an incident revocation runs, owned by the domain that owns the tables.
 *
 * `tools/revoke-sessions.mjs` is the operator's command and belongs to `platform`; these two
 * statements name `identity_sessions` and `identity_audit_events`, which belong to
 * `identity-access` (`table-ownership.json`). Keeping them here rather than in the tool is the
 * same boundary every other cross-domain read respects — the tool asks this domain for its
 * statements instead of writing SQL against its tables.
 *
 * Plain `.mjs` rather than TypeScript, and that is the reason it is not beside the D1 adapters it
 * resembles: this is the one piece of identity SQL that has to be executable from Node with no
 * build step, because the tool that runs it runs outside the Worker.
 *
 * There is no bound-parameter form here, because `wrangler d1 execute` takes a command string.
 * The caller is responsible for having refused any `userId` that is not a plain identifier —
 * `tools/revoke-sessions.mjs` does that with a pattern, and its test covers the injection
 * attempts, because refusing is checkable and escaping is what people get wrong.
 */

/**
 * Revoke first, then record it.
 *
 * The order matters: a failed revocation must leave behind no audit row claiming it happened.
 * The audit row carries `system` as its source and the caller's correlation id, which is how an
 * operator connects the command they ran to what the table shows afterwards.
 */
export function identityRevocationStatements({ userId, now, correlationId, rowId }) {
  const scope = userId ? ` AND user_id = '${userId}'` : "";
  const subject = userId ? `'${userId}'` : "NULL";
  const detail = JSON.stringify({ tool: "revoke-sessions", scope: userId ? "user" : "all" });
  return [
    `UPDATE identity_sessions SET revoked_at = ${now} WHERE revoked_at IS NULL AND expires_at > ${now}${scope}`,
    // `WHERE changes() > 0`, exactly as the in-Worker writers use: a sweep that revoked nothing
    // is a no-op, not an event, and a row claiming otherwise would be both a lie and a way to
    // append to this table at will. `changes()` reports the statement immediately before it, and
    // the two are sent as one command so nothing can run between them.
    //
    // `rowId` is the row's own primary key, separate from `correlationId`: a run repeated with
    // the same correlation id would otherwise collide on the PRIMARY KEY and fail the command
    // rather than recording a second revocation.
    "INSERT INTO identity_audit_events (id, occurred_at, action, outcome, source, actor_user_id, " +
      "subject_user_id, organization_id, event_id, correlation_id, detail) " +
      `SELECT '${rowId}', ${now}, 'session.revoked_all', 'succeeded', 'system', NULL, ` +
      `${subject}, NULL, NULL, '${correlationId}', '${detail}' WHERE changes() > 0`,
  ];
}
