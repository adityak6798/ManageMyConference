// @spec PRD-COM-001 PRD-INT-001

/**
 * Where a delivery goes.
 *
 * `event` is the odd one and deliberately so. The other three name an outside system this domain
 * calls over HTTP; `event` names no system at all. It carries a domain event that another domain
 * committed — today only `EVT-SCHEDULE-PUBLISHED` — through the same durable machinery, so the
 * announcement of a fact and the fact itself commit together and the announcement is retried,
 * attempted and audited like anything else that has to happen exactly once.
 *
 * Modelling it as an `airtable` delivery instead, which is the shortcut this replaces, would
 * have queued a fabricated push to somebody's Airtable base and written projection state
 * claiming the schedule had been sent there. See issue #22 and PR #113's scoping note.
 */
export type DeliveryChannel = "email" | "airtable" | "accelevents" | "event";
export type DeliveryState = "queued" | "retrying" | "succeeded" | "terminal";
export type TriggerType =
  | "speaker.invited"
  | "reviewer.assigned"
  | "organizer.digest"
  | "projection.requested"
  | "schedule.published"
  | "speaker.scheduled"
  | "speaker.task_assigned"
  | "speaker.task_reminder"
  /** An organizer sending a speaker the iTIP invitation for one of their sessions. */
  | "speaker.calendar_invite"
  | "decision.recorded"
  /**
   * A submitter's own proposal reaching the organizers, confirmed back to the account that wrote
   * it.
   *
   * The recipient is resolved from the session that submitted, never from a form answer, which is
   * what made this message shippable at all — decision `D5` deferred it while the only available
   * address was an unverified field on an anonymous form (`#132`). The anonymous door still sends
   * nothing.
   */
  | "proposal.submitted";

/**
 * Which channels each trigger may legitimately use.
 *
 * One table rather than the four hand-written conditionals this replaces, because those had
 * grown into a rule nobody could state: "email requires a template", "email may not be a
 * projection trigger", "a non-email channel requires a projection trigger", "a non-email channel
 * requires a version" — four negatives that between them encoded a mapping, and that could not
 * express a fifth channel without a fifth conditional. Adding a trigger now means adding a row,
 * and a trigger with no row is a compile error rather than a delivery nothing will send.
 *
 * `speaker.calendar_invite` is `email` on purpose: a calendar invitation reaches Gmail, Outlook
 * and Apple Calendar by arriving as mail whose body part is `text/calendar; method=REQUEST`.
 * A separate calendar channel would need a provider with no protocol to speak.
 */
export const TRIGGER_CHANNELS = {
  "speaker.invited": ["email"],
  "reviewer.assigned": ["email"],
  "organizer.digest": ["email"],
  "speaker.scheduled": ["email"],
  "speaker.task_assigned": ["email"],
  "speaker.task_reminder": ["email"],
  "speaker.calendar_invite": ["email"],
  "decision.recorded": ["email"],
  "proposal.submitted": ["email"],
  "projection.requested": ["airtable", "accelevents"],
  "schedule.published": ["event"],
} as const satisfies Record<TriggerType, readonly DeliveryChannel[]>;

/** True when this trigger may be sent over this channel. */
export const triggerAllowsChannel = (trigger: TriggerType, channel: DeliveryChannel): boolean =>
  (TRIGGER_CHANNELS[trigger] as readonly DeliveryChannel[]).includes(channel);

/** The channels whose success updates outbound projection state. Narrows, so callers keep the type. */
export const isProjectionChannel = (
  channel: DeliveryChannel,
): channel is "airtable" | "accelevents" => channel === "airtable" || channel === "accelevents";

/**
 * Triggers a request may name. `schedule.published` is absent, and that is the point.
 *
 * A domain event records that something already happened inside this system. Letting an HTTP
 * caller mint one would let an organizer announce a schedule publication that never occurred,
 * to consumers whose whole reason for trusting the record is that it was committed in the same
 * transaction as the publication itself.
 */
export const REQUESTABLE_TRIGGERS = (Object.keys(TRIGGER_CHANNELS) as TriggerType[]).filter(
  (trigger) =>
    !triggerAllowsChannel(trigger, "event") &&
    /*
     * `proposal.submitted` is the second exclusion, and it is narrower than the domain-event one.
     * A submission confirmation's recipient is resolved from the session that submitted the
     * proposal — that is the whole property that made it shippable (`#132`, decision `D5`) — so a
     * request naming an arbitrary address would hand back exactly the mail primitive the account
     * binding removes. `requestTriggerTypeSchema` in the contracts package states the same
     * exclusion at the HTTP boundary; this keeps the derived set from disagreeing with it, which
     * it silently did until a review pass compared the two.
     */
    trigger !== "proposal.submitted",
);

/**
 * Which of a subject's two possible addresses a lifecycle message is sent to.
 *
 * Some subjects have both: an address they proved control of by signing in, and an address they
 * typed into a public form. The two are not equally trustworthy, and the difference matters most
 * for the messages that carry something private — an accept or a decline names a decision the
 * organizer has not announced anywhere else.
 *
 * The rule is stated here rather than at each call site, and it is about *which subject* rather
 * than which address: **an account-bound subject is written to at its account, or not at all.**
 * The form address is reached only when there is no account — a guest submission, which is a
 * supported way to apply (`PRD-CFP-002`) and where telling nobody is the only alternative. That
 * remaining guest path is the residue of issue #132, which stays open: closing it needs a
 * per-(event, recipient) cap or a double opt-in, a product decision with storage behind it.
 *
 * An account that holds **no** address therefore yields `null` rather than falling through. That
 * was a fallback once, and it was wrong: an owned proposal's form answer is still an address
 * nobody verified and possibly a stranger's, so using it on the account-bound path reintroduces
 * exactly the misdirection preferring the account removes. The account holder is not left without
 * recourse — a decision is on their own dashboard (`PRD-CFP-004`), which is why the product's
 * guarantee is the dashboard and not the message.
 *
 * `null` means there is nobody to write to, which callers report rather than paper over — a
 * delivery to a non-address burns an attempt and fails with the provider's refusal instead of
 * the reason.
 *
 * **A lookup that failed is not an account with no address, and the difference is the type's.**
 * Collapsing them would let a transient read error choose the *less* trustworthy address — the
 * exact exposure the preference exists to remove — so the account argument carries the outcome of
 * asking rather than an address. `asked: false` yields `null`: nothing is sent, and a human is
 * left to it. Stating that here rather than as a rule each caller must remember is the point; the
 * composition root that resolves the address is not the place to re-decide it.
 */
export type AccountAddressLookup =
  /** Identity answered. `email` is `null` when the account genuinely has none linked. */
  | { readonly asked: true; readonly email: string | null }
  /** Identity could not be asked. Not evidence about the account, and not a reason to fall back. */
  | { readonly asked: false };

/**
 * The rule again, taking the account's **id** rather than a pre-built lookup.
 *
 * `lifecycleRecipient` distinguishes guest from account by whether `account` is present, which
 * means a caller has to encode "there is no account" as an absent field — and the composition root
 * encoded it as `{ asked: true, email: null }` instead. That was right while an account with no
 * address fell through to the form address, and became wrong the instant that fallback was
 * removed: the sentinel is an account object, so every guest decision resolved to `null` and
 * stopped being sent, silently, with nothing failing.
 *
 * This shape removes the encoding step. `accountId === null` *is* the guest case, `askIdentity` is
 * called only when there is somebody to ask, and there is no intermediate value for a caller to
 * get wrong. Prefer it at any call site that starts from an id.
 */
export async function lifecycleRecipientForAccount(subject: {
  /** The account owning the record this message is about, or `null` for a guest. */
  readonly accountId: string | null;
  readonly declaredEmail?: string | null | undefined;
  /** Asks identity for the account's address, reporting whether it could be asked at all. */
  readonly askIdentity: (accountId: string) => Promise<AccountAddressLookup>;
}): Promise<string | null> {
  if (!subject.accountId) return lifecycleRecipient({ declaredEmail: subject.declaredEmail });
  return lifecycleRecipient({
    account: await subject.askIdentity(subject.accountId),
    declaredEmail: subject.declaredEmail,
  });
}

export const lifecycleRecipient = (subject: {
  /** What asking identity for the owning account's address produced, if there is an account. */
  readonly account?: AccountAddressLookup | undefined;
  /** The address a public form collected. Unverified by construction. */
  readonly declaredEmail?: string | null | undefined;
}): string | null => {
  // No account at all — a guest submission. The form address is the only one there is.
  if (!subject.account) return subject.declaredEmail || null;
  // There is an account, so its answer is final and the form address is never consulted again.
  // `asked: false` is not an answer, so it sends nothing.
  return subject.account.asked ? subject.account.email || null : null;
};

export interface MessageTemplate {
  readonly id: string;
  readonly organizationId: string;
  readonly key: string;
  readonly version: number;
  readonly channel: DeliveryChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface Delivery {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly triggerType: TriggerType;
  readonly channel: DeliveryChannel;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly recipientRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * The message as sent, rendered from `templateVersion` against `payload` at enqueue and never
   * re-rendered — a retry three days later sends the text that was composed, not the text the
   * template says today. Null on projection channels, which carry a payload rather than a
   * message, and on any delivery enqueued before migration 1700.
   */
  readonly renderedSubject: string | null;
  readonly renderedBody: string | null;
  readonly projectionVersion: number | null;
  readonly state: DeliveryState;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly leaseToken: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryAttempt {
  readonly id: string;
  readonly deliveryId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "retryable_failure" | "terminal_failure";
  readonly providerReference: string | null;
  readonly errorCode: string | null;
}

export interface ProjectionState {
  readonly destination: "airtable" | "accelevents";
  readonly eventId: string;
  readonly resourceRef: string;
  readonly version: number;
  readonly deliveryId: string;
  readonly projectedAt: string;
}
