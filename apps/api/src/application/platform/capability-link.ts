/**
 * The capability-URL convention: one durable shape every anonymous share link in this product uses.
 *
 * `DEBT-012` records the first capability URL here — the attendee itinerary — and the condition
 * it sets for the next one: *identity plus revocation and rotation must ship before the payload
 * crosses the named public-data boundary.* Every later link does cross it, so rather than each
 * domain inventing its own token table, this is the one primitive they all address a resource
 * through, and it ships what that entry withholds from the itinerary:
 *
 * - **only a digest is stored**, so a read of the table cannot forge a link;
 * - **an expiry**, so a leaked URL stops working without anybody noticing it leaked;
 * - **a view limit**, spent in the same statement that checks liveness, so two concurrent
 *   resolves of a one-view link cannot both succeed;
 * - **an optional password**, so a URL in a chat log is not on its own the whole credential;
 * - **revocation**, which is the difference between a mistake and an incident.
 *
 * **A link names a resource, never a session.** `resourceKind` says which domain resolves it and
 * `resourceRef` is that domain's own identifier, carried opaquely and with no foreign key —
 * platform does not own reports' or content's rows any more than it owns anybody else's. The
 * resolving domain normally reads under **no human actor at all**. Where a resource needs an
 * application actor (scheduled reports do), its scope carries a bounded snapshot of the
 * creator's event authority; it never restores the creator's session or current identity.
 *
 * **`scope` is the per-kind policy, decided when the link is minted.** A report's link carries
 * `allowPii`; a speaker-portal link will carry whatever that lane decides a visitor may do. It is
 * on the link rather than on the request because the person opening it is anonymous and cannot be
 * asked to hold a capability.
 *
 * `speaker-profile` and `speaker-asset` are declared here and resolved by nothing yet. That is
 * deliberate: issue #189's `GAP-028` residual needs exactly this shape, and a kind declared in
 * advance is a lane adding a resolver instead of a second token table.
 *
 * @spec PRD-OPS-004 PRD-IAM-002 ARC-DOM-001
 */

/**
 * What a link may address. Closed, because a link naming a kind nothing resolves is a link whose
 * refusal would look like a revocation.
 */
export type CapabilityLinkKind = "report" | "speaker-profile" | "speaker-asset";

export const CAPABILITY_LINK_KINDS: readonly CapabilityLinkKind[] = [
  "report",
  "speaker-profile",
  "speaker-asset",
];

export interface CapabilityLink {
  readonly id: string;
  readonly kind: CapabilityLinkKind;
  /** The owning domain's identifier. Opaque here, and deliberately not a foreign key. */
  readonly resourceRef: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Null means unlimited. A number is spent by the resolve, not by the read before it. */
  readonly viewLimit: number | null;
  readonly views: number;
  readonly revokedAt: string | null;
  readonly hasPassword: boolean;
  /** Per-kind policy, interpreted by the resolving domain and by nothing else. */
  readonly scope: Readonly<Record<string, unknown>>;
}

/** A link that is unknown, revoked, expired, out of views, or password-protected and unanswered. */
export class CapabilityLinkUnavailableError extends Error {
  constructor() {
    super("That link is not available.");
  }
}

export interface CapabilityLinkStore {
  create(link: CapabilityLink & { tokenHash: string; passwordHash: string | null }): Promise<void>;
  list(kind: CapabilityLinkKind, resourceRef: string): Promise<readonly CapabilityLink[]>;
  revoke(
    kind: CapabilityLinkKind,
    resourceRef: string,
    linkId: string,
    at: string,
  ): Promise<number>;
  /**
   * Spend one view of the link this digest names, or answer null.
   *
   * Must be **one statement**: it has to test liveness — not revoked, not expired, a view left —
   * and increment the view count together, or two concurrent resolves of a one-view link both
   * pass the test before either writes. Kind and password are predicates of that same statement:
   * a wrong endpoint or password must not consume a limited view.
   */
  spend(
    tokenHash: string,
    kind: CapabilityLinkKind,
    passwordHash: string | null,
    now: string,
  ): Promise<CapabilityLink | null>;
}

/**
 * 32 random bytes, base64url, and the digest the database stores instead of them.
 *
 * The same shape `mintInvitationToken` uses, and deliberately a separate function: an invitation
 * and a share link have different lifetimes and different revocation rules, and one minter would
 * make them look like one thing.
 */
export async function mintCapabilityToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return { token, tokenHash: await hashCapabilityToken(token) };
}

/** SHA-256, hex. What the database holds instead of a token or a link password. */
export async function hashCapabilityToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The longest a link may live. Four weeks; long enough to be useful, short enough to expire. */
export const MAX_CAPABILITY_LINK_HOURS = 720;

/**
 * Spend a link and check its password, or refuse indistinguishably.
 *
 * Shared so that every consumer refuses the same way. An unknown token, a revoked link, an
 * expired one, one out of views and a wrong password are one answer; telling them apart would
 * say whether a guessed token named a real resource.
 */
export async function spendCapabilityLink(
  store: CapabilityLinkStore,
  hash: (value: string) => Promise<string>,
  input: {
    token: string;
    kind: CapabilityLinkKind;
    password?: string | undefined;
    now: string;
  },
): Promise<CapabilityLink> {
  const spent = await store.spend(
    await hash(input.token),
    input.kind,
    input.password ? await hash(input.password) : null,
    input.now,
  );
  if (!spent) throw new CapabilityLinkUnavailableError();
  return spent;
}
