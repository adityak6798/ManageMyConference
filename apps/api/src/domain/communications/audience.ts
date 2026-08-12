/**
 * A stable name for "the set of people a send would reach right now".
 *
 * The organizer confirms a send against a count they were shown, and the send then re-resolves
 * the audience independently. A speaker added between the two receives a message under a count
 * nobody approved; one removed makes the approved count false. Neither is caught by the delivery
 * idempotency key, which only stops the *same* recipient being written twice.
 *
 * So the recipient list is issued with a version, the confirmation carries it back, and a send
 * whose audience no longer matches is refused rather than silently sending to a different set of
 * people than the one on screen.
 *
 * ## What this is and is not
 *
 * It is a change detector, not a token. Nothing is authorized by holding it: every path that
 * accepts one has already checked the organization, the event capability, and that the event
 * belongs to the organization, and the audience is re-resolved server-side either way. A caller
 * who forges a version reaches exactly the audience they would have reached without one — the
 * only thing they lose is the protection this exists to give them.
 *
 * That is why a short non-cryptographic digest is enough. It is FNV-1a over the sorted
 * `userId:address` pairs, with the count prefixed so a change in size can never collide with a
 * change in membership.
 *
 * @spec PRD-COM-001
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The version of an audience, derived only from who is in it and how they are addressed.
 *
 * Sorted before hashing, so the same people in a different query order are the same audience —
 * otherwise a change in `ORDER BY` would read as the audience having changed and refuse every
 * confirmed send. Both fields are included: a speaker whose address was corrected is a different
 * audience, because the message will reach somewhere else.
 */
export function audienceVersion(
  recipients: readonly { readonly userId: string; readonly address: string | null }[],
): string {
  const members = recipients
    .map(({ userId, address }) => `${userId}:${address ?? ""}`)
    .sort()
    .join("\n");
  let hash = FNV_OFFSET;
  for (let index = 0; index < members.length; index += 1) {
    hash ^= members.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Unsigned, base 36, and prefixed with the count — so two audiences of different sizes can
  // never share a version however the digest collides.
  return `${recipients.length}-${(hash >>> 0).toString(36)}`;
}
