import {
  CFP_DRAFT_STATUS,
  type CfpField,
  type CfpForm,
  type CfpCondition,
  type CfpEffectiveState,
  type CfpRoutingRule,
  type CfpSubmissionWindow,
  cfpEffectiveState,
  cfpFieldMaxLength,
  type ProposalLifecycle,
  type ProposalSubmission,
  proposalTitleOf,
} from "../../domain/cfp/cfp";
import type { Actor } from "../identity/actor";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireEventCapability,
} from "../identity/actor";
import type { CfpRepository, ProposalOwnerWrite, ProposalSubmitWrite } from "./cfp-repository";
import type { SubmittedProposalReference } from "./public";
import type { SubmittedProposalQuery } from "./submitted-proposal-interface";

export class CfpUnavailableError extends Error {}
export class CfpStateError extends Error {}
export class CfpRoutingConfigurationError extends Error {}
export class CfpDraftConflictError extends Error {}
/**
 * The proposal is no longer in the state the write was built for.
 *
 * Its own type rather than a `CfpStateError`, because the transport answers that one with **400
 * `VALIDATION_FAILED`** — "your input was wrong" — and this is a conflict with the resource's
 * state, exactly like a stale revision or a closed call, both of which answer `409`. Two earlier
 * repairs on this branch were about precisely that mismatch on sibling paths; reaching for the
 * nearest existing error class would have made it three.
 */
export class CfpProposalStateConflictError extends Error {}
/** The call is not taking writes: not yet open, closed by the organizer, or past its deadline. */
export class CfpClosedError extends Error {
  constructor(
    message: string,
    readonly effectiveState: CfpEffectiveState,
  ) {
    super(message);
  }
}
/**
 * The proposal does not exist *for this caller*.
 *
 * One error for "no such proposal" and "not yours", because they must be indistinguishable: a
 * submitter who could tell the difference could enumerate another submitter's proposal ids
 * (`ARC-AUTH-001`, and the same rule `ReviewService.acceptedProposal` follows for events).
 */
export class CfpProposalNotFoundError extends Error {}
export class CfpValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super("Proposal validation failed");
  }
}
const organizerFor = (actor: Actor | null, eventId: string) => {
  try {
    requireEventCapability(actor, eventId, "events:settings:update");
  } catch (error) {
    if (error instanceof CapabilityDeniedError)
      throw new CapabilityDeniedError("Organizer event access denied");
    throw error;
  }
};

/**
 * The one authorization rule for a submitter, and it is deliberately not a capability.
 *
 * A person proposing a talk holds no role on the conference — that is the whole point of the
 * public call — so `requireEventCapability` is the wrong instrument: it would either refuse
 * everybody or force the product to grant an event role to anyone who opens the form. What
 * authorizes a proposal write is instead *ownership of the row*, checked in the same statement
 * that performs the write (`ProposalOwnerWrite`). This function establishes only the first half:
 * there is an account to own anything at all.
 *
 * Recorded here because it is the place a later reader will look for the missing capability
 * check and conclude one was forgotten.
 */
export const submitterFor = (actor: Actor | null): Actor => {
  if (!actor)
    throw new AuthenticationRequiredError("Sign in to keep a proposal against your account");
  return actor;
};

/**
 * What a submitter is told their proposal's state is.
 *
 * Narrower than the organizer's triage status on purpose. Triage keys are organizer vocabulary —
 * an event may configure "shortlist_maybe" or "second_round" — and forwarding them to applicants
 * would publish the inside of a review process nobody agreed to publish. Only the two decisions
 * that have been communicated anyway pass through; everything else is one honest word.
 */
export type SubmitterProposalState = "draft" | "under_consideration" | "accepted" | "declined";

/**
 * The review domain's reserved decision statuses, restated rather than imported.
 *
 * Migration `0021` writes both keys for every event with a status set. CFP may not reach into
 * review's modules (`ARC-DOM-001`), and `MemorySubmittedProposalAdapter` mirrors the same two
 * literals for the same reason.
 */
const ACCEPTED_STATUS = "accepted";
const DECLINED_STATUS = "declined";
/** A status only a recorded decision may put a proposal into. Never a routing destination. */
const isDecisionStatus = (status: string): boolean =>
  status === ACCEPTED_STATUS || status === DECLINED_STATUS;

const submitterStateOf = (proposal: ProposalSubmission): SubmitterProposalState => {
  if (proposal.lifecycle === "draft") return "draft";
  if (proposal.status === ACCEPTED_STATUS) return ACCEPTED_STATUS;
  if (proposal.status === DECLINED_STATUS) return DECLINED_STATUS;
  return "under_consideration";
};

/** One row of the submitter's dashboard. Carries no triage status and no reviewer material. */
export interface SubmitterProposalView {
  readonly id: string;
  readonly eventId: string;
  readonly lifecycle: "draft" | "submitted";
  readonly state: SubmitterProposalState;
  readonly title: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly updatedAt: string;
  /** Null while the proposal is a draft: nothing has been submitted, so nothing is confirmed. */
  readonly submittedAt: string | null;
}

/**
 * Told when a submitter's own proposal reaches the organizers.
 *
 * The fact carries the submitter's **user id**, never an address. Resolving it to a mailbox is the
 * composition root's job, through identity's directory, and that is the whole of what narrows
 * `#132` here: the recipient of a confirmation is derived from the session that wrote the
 * proposal and can never be named by the request. See `docs/architecture/data-flows.md`.
 *
 * An implementation must not throw — the proposal is already durable by the time this is called,
 * and failing here would report a submission that happened as one that did not. `notifyLifecycle`
 * in `index.ts` is the wrapper that guarantees it.
 */
export interface CfpNotificationPort {
  proposalSubmitted(fact: {
    readonly eventId: string;
    readonly proposalId: string;
    readonly submitterUserId: string;
    readonly proposalTitle: string | null;
  }): Promise<void>;
}

/**
 * `live` is the currently published form's fields, used only for a draft.
 *
 * A draft stores no field snapshot — it has not met a published form yet, and freezing one at
 * creation would name a title from a question the organizer has since replaced. A submitted
 * proposal carries its own snapshot and that is what its title comes from, which is why the
 * dashboard keeps naming a proposal correctly after the form moves on beneath it.
 */
const viewOf = (
  proposal: ProposalSubmission,
  live: readonly CfpField[] = [],
): SubmitterProposalView => ({
  id: proposal.id,
  eventId: proposal.eventId,
  lifecycle: proposal.lifecycle ?? "submitted",
  state: submitterStateOf(proposal),
  title: proposalTitleOf(proposal.fields.length ? proposal.fields : live, proposal.answers),
  answers: proposal.answers,
  revision: proposal.revision ?? 1,
  updatedAt: proposal.updatedAt ?? proposal.submittedAt,
  submittedAt: proposal.lifecycle === "draft" ? null : proposal.submittedAt,
});

// @spec PRD-CFP-001 PRD-CFP-002
export class CfpService {
  constructor(
    private readonly repository: CfpRepository,
    private readonly newId: () => string,
    private readonly now: () => Date,
    private readonly proposals?: Pick<SubmittedProposalQuery, "listStatuses">,
    private readonly notifications?: CfpNotificationPort,
  ) {}
  async routingStatuses(actor: Actor | null, eventId: string) {
    organizerFor(actor, eventId);
    return this.proposals?.listStatuses(eventId) ?? [];
  }
  async getForOrganizer(actor: Actor | null, eventId: string) {
    organizerFor(actor, eventId);
    const [form, published] = await Promise.all([
      this.repository.findForm(eventId),
      this.repository.findPublished(eventId),
    ]);
    if (!form) return null;
    const publishedStatus =
      published?.status === "open" || published?.status === "closed" ? published.status : null;
    return this.withEffectiveStatus({ ...form, publishedStatus }, publishedStatus ?? "draft");
  }
  /**
   * Attach the state applicants are actually in, to every form this service hands out.
   *
   * `live` is the status the *published* call is in, which the caller has to supply because the
   * two shapes disagree about where it lives: an organizer's editable form carries the draft's own
   * `status` and the live one in `publishedStatus`, while a published snapshot's `status` **is** the
   * live one. Deriving it from one field here would have been silently wrong for one of the two —
   * and reading `publishedStatus` off a snapshot written before that field existed would report a
   * published call as unpublished.
   *
   * The composer needs this because "Published · open" was true and misleading from the moment a
   * deadline existed; the applicant surface needs it because a browser must not be the thing that
   * decides whether a deadline has passed.
   */
  private withEffectiveStatus<T extends CfpForm>(
    form: T,
    live: CfpForm["status"],
  ): T & { effectiveStatus: CfpEffectiveState } {
    return {
      ...form,
      effectiveStatus: cfpEffectiveState(
        { status: live, opensAt: form.opensAt, closesAt: form.closesAt },
        this.now(),
      ),
    };
  }
  /**
   * Replace the scheduled submission window.
   *
   * Its own command rather than a field of `save`, because the window is live state: an organizer
   * extending a deadline must not thereby publish whatever unrelated edits are sitting in the
   * composer, and closing early must not need a republish at all. The same reason `close` and
   * `reopen` are not fields of `save`.
   */
  async saveWindow(
    actor: Actor | null,
    eventId: string,
    window: CfpSubmissionWindow,
  ): Promise<CfpForm & { effectiveStatus: CfpEffectiveState }> {
    organizerFor(actor, eventId);
    const normalized = {
      opensAt: normalizeInstant(window.opensAt, "opensAt"),
      closesAt: normalizeInstant(window.closesAt, "closesAt"),
    };
    if (
      normalized.opensAt &&
      normalized.closesAt &&
      Date.parse(normalized.closesAt) <= Date.parse(normalized.opensAt)
    )
      throw new CfpValidationError({
        closesAt: ["The call has to close after it opens."],
      });
    if (!(await this.repository.saveWindow(eventId, normalized)))
      throw new CfpUnavailableError("Create the CFP before scheduling its submission window");
    const form = await this.getForOrganizer(actor, eventId);
    if (!form)
      throw new CfpUnavailableError("Create the CFP before scheduling its submission window");
    return form;
  }
  async save(
    actor: Actor | null,
    input: Omit<
      CfpForm,
      "status" | "version" | "publishedAt" | "publishedStatus" | "opensAt" | "closesAt"
    > & {
      expectedVersion: number;
    },
  ): Promise<CfpForm & { effectiveStatus: CfpEffectiveState }> {
    organizerFor(actor, input.eventId);
    // The window is read but never written here: `saveForm` writes the form's own columns, and a
    // response that reported no deadline while one was live would be a lie the composer renders.
    const [published, current] = await Promise.all([
      this.repository.findPublished(input.eventId),
      this.repository.findForm(input.eventId),
    ]);
    const { expectedVersion, ...editable } = input;
    if (editable.routing?.length) {
      const configured = new Set(
        (await this.routingStatuses(actor, input.eventId)).map(({ key }) => key),
      );
      const invalid = editable.routing.find(({ routeTo }) => !configured.has(routeTo.status));
      if (invalid)
        throw new CfpRoutingConfigurationError(
          `Choose a configured proposal status for routing rule ${invalid.id}`,
        );
      /*
       * Routing may not name a decision, and this is the third door onto the same rule.
       *
       * `accepted` and `declined` are configured on every event (migration `0021`), so they passed
       * the check above and were offered in the composer's dropdown. Reaching one is the *effect* of
       * a recorded decision — `bulkTransition` refuses a transition straight into it for exactly
       * that reason — and routing was the way in that nobody had closed, because until this issue
       * nothing showed the applicant what their triage status was. Now the submitter's dashboard
       * reads it, so a rule like "track = Keynote → Accepted" tells an applicant they were accepted
       * with no decision recorded, no session created and no organizer having decided anything.
       */
      const decided = editable.routing.find(({ routeTo }) => isDecisionStatus(routeTo.status));
      if (decided)
        throw new CfpRoutingConfigurationError(
          `Routing rule ${decided.id} cannot route to “${decided.routeTo.status}”: an accept or decline is recorded as a decision, which creates the session and tells the submitter. Route to a triage status instead.`,
        );
    }
    const form: CfpForm = {
      ...editable,
      status: "draft",
      version: expectedVersion + 1,
      publishedAt: null,
      publishedStatus:
        published?.status === "open" || published?.status === "closed" ? published.status : null,
      opensAt: current?.opensAt ?? null,
      closesAt: current?.closesAt ?? null,
    };
    try {
      if (!(await this.repository.saveForm(form, expectedVersion)))
        throw new CfpDraftConflictError("This CFP draft changed in another editor");
    } catch (error) {
      if (String(error).includes("CFP_ROUTE_STATUS_NOT_CONFIGURED"))
        throw new CfpRoutingConfigurationError("Choose a configured proposal status");
      throw error;
    }
    return this.withEffectiveStatus(form, form.publishedStatus ?? "draft");
  }
  async changeState(
    actor: Actor | null,
    eventId: string,
    state: "publish" | "close" | "reopen",
  ): Promise<CfpForm & { effectiveStatus: CfpEffectiveState }> {
    organizerFor(actor, eventId);
    const draft = await this.repository.findForm(eventId);
    if (!draft) throw new CfpUnavailableError("Create the CFP before changing its state");
    const published = await this.repository.findPublished(eventId);
    if (state === "close" && published?.status !== "open")
      throw new CfpStateError("Only an open CFP can be closed");
    if (state === "reopen" && published?.status !== "closed")
      throw new CfpStateError("Only a closed CFP can be reopened");
    /*
     * A reopen the schedule would immediately undo is refused, rather than answered 200.
     *
     * `cfpEffectiveState` requires both gates to permit, so reopening a call whose deadline has
     * passed changes a column and nothing an applicant can see — the surface would report "Published
     * · open" over a form that still refuses every submission. Moving the deadline is the act that
     * actually reopens the call, and it is also the only one that is honest about what applicants
     * were told, so the refusal names it.
     *
     * A *future* `opensAt` is deliberately not refused: reopening then scheduling an opening is a
     * real intention, and the call correctly reads `scheduled` until that instant arrives.
     */
    if (state === "reopen" && draft.closesAt && Date.parse(draft.closesAt) <= this.now().getTime())
      throw new CfpStateError(
        "This call's submission deadline has passed. Move or clear the deadline to take submissions again.",
      );
    const source = state === "publish" ? draft : published;
    if (!source) throw new CfpUnavailableError("Publish the CFP before changing its state");
    /*
     * Publishing changes the form applicants see. It does not decide whether they may submit.
     *
     * Republishing used to overwrite a `closed` publication with `open`, so an organizer who
     * had closed submissions after the deadline and later fixed a typo reopened the call by
     * accident — silently, since the only message named the new version of the form. Open and
     * closed is what "Close live CFP" and "Reopen live CFP" are for, and those two are the only
     * things that may change it. A first publication has no live state to preserve and opens.
     */
    const live: "open" | "closed" = published?.status === "closed" ? "closed" : "open";
    const status = state === "publish" ? live : state === "close" ? "closed" : "open";
    const form: CfpForm = {
      ...source,
      status,
      publishedAt: source.publishedAt ?? this.now().toISOString(),
      publishedStatus: status,
    };
    if (
      !(await this.repository.savePublished(
        form,
        state === "publish" || draft.status !== "draft",
        draft.version,
      ))
    )
      throw new CfpDraftConflictError("This CFP draft changed in another editor");
    return (await this.getForOrganizer(actor, eventId)) ?? this.withEffectiveStatus(form, status);
  }
  /**
   * The published form as applicants see it, plus the one thing they cannot compute themselves.
   *
   * `effectiveStatus` is on the wire rather than derived in the browser because deriving it there
   * would put a visitor's own clock in charge of whether a deadline has passed — a skewed laptop
   * would render an open form over a call the server refuses, and the applicant would find out by
   * losing a submission.
   */
  async getPublished(eventId: string): Promise<CfpForm & { effectiveStatus: CfpEffectiveState }> {
    const form = await this.repository.findPublished(eventId);
    if (!form) throw new CfpUnavailableError("The CFP is not published");
    // A published snapshot's own `status` is the live one, which is why it is passed rather than
    // `publishedStatus` — a snapshot written before that field existed carries no such key.
    return this.withEffectiveStatus(form, form.status);
  }
  /** The published form, refusing every state but `open`, with the reason it refused. */
  private async openForm(eventId: string) {
    const form = await this.getPublished(eventId);
    if (form.effectiveStatus === "open") return form;
    throw new CfpClosedError(
      form.effectiveStatus === "scheduled"
        ? "This call is not open for submissions yet."
        : "This call for proposals is closed.",
      form.effectiveStatus,
    );
  }
  /**
   * The anonymous door, and it stays open.
   *
   * `PRD-CFP-002` still describes the unauthenticated write and a real conference may want both
   * doors. What this one cannot produce is an *owner*: the proposal it writes carries
   * `submitter_user_id = NULL`, so it appears on nobody's dashboard, cannot be edited afterwards,
   * and sends no confirmation. That is the guest-submission rule stated as code rather than as
   * policy — there is no path here that turns an address somebody typed into ownership of
   * anything, which is what `#132` is about.
   */
  async submit(
    eventId: string,
    idempotencyKey: string,
    answers: Record<string, string>,
  ): Promise<ProposalSubmission> {
    // Only an anonymous, already-submitted proposal counts as this call's own retry. Reading the
    // key unscoped answered a guest with whatever else held it — including an account's unsent
    // draft, handed back as a confirmation identifier for something nobody submitted.
    const prior = await this.repository.findAnonymousSubmission(eventId, idempotencyKey);
    if (prior) return prior;
    const form = await this.openForm(eventId);
    const fieldErrors = validateAnswers(form.fields, answers);
    if (Object.keys(fieldErrors).length) throw new CfpValidationError(fieldErrors);
    const resolvedRoute = resolveRoute(form.routing ?? [], answers);
    const at = this.now().toISOString();
    const created = await this.repository.createSubmission({
      id: this.newId(),
      eventId,
      cfpVersion: form.version,
      idempotencyKey,
      answers,
      fields: form.fields,
      resolvedRoute,
      submittedAt: at,
      updatedAt: at,
      lifecycle: "submitted",
      submitterUserId: null,
    });
    /*
     * The same 409 the owned writes answer, and for the same reason.
     *
     * Several things make this insert match nothing — the storage guard saw a call that is no
     * longer open, the published version moved between the read above and the write, or the
     * idempotency key is held by a row this caller cannot converge on — and every one of them is
     * a conflict with the resource's state rather than a fault in the request. The refusal below
     * says which of those is *not* worth guessing at. A `CfpStateError`
     * here reached the transport as a 400 `VALIDATION_FAILED`, so a guest who submitted as the
     * organizer closed the call was told their form answers were wrong. `createDraft` was
     * repaired for exactly this; the anonymous door is its sibling.
     */
    if (!created) {
      const live = await this.getPublished(eventId);
      /*
       * Says what is true of every cause rather than naming one, unlike `createDraft`'s, which
       * genuinely has one.
       *
       * This insert misses for at least three reasons: the call closed, the organizer republished
       * (it carries a version predicate the owned writes do not), or the idempotency key is
       * already held by a row this caller cannot converge on — an owned proposal or a draft, the
       * squatting residual `GAP-027` records. Borrowing `createDraft`'s sentence told a guest who
       * raced a republish that the call was closed while it was open. Enumerating instead would
       * be the same mistake with a longer list, and nothing here can tell which happened without
       * a second read that would be racing too — so the message describes the shape of the answer
       * (something moved, reload) and the status code carries the rest.
       */
      throw new CfpClosedError(
        "This call for proposals changed before the proposal was saved. Reload the form and try again.",
        live.effectiveStatus,
      );
    }
    return created;
  }

  // ---- the submitter's own proposals -----------------------------------------------------
  //
  // Four commands, all authorized the same way: an account, and ownership of the row asserted
  // inside the write rather than checked before it. See `submitterFor`.

  /** Every proposal this account owns for this event, drafts included. */
  async myProposals(
    actor: Actor | null,
    eventId: string,
  ): Promise<readonly SubmitterProposalView[]> {
    const submitter = submitterFor(actor);
    const [proposals, published] = await Promise.all([
      this.repository.listProposalsForOwner(eventId, submitter.id),
      this.repository.findPublished(eventId),
    ]);
    return proposals.map((proposal) => viewOf(proposal, published?.fields ?? []));
  }
  /**
   * Start a proposal without finishing it.
   *
   * A draft is held to the shape of the published form but not to its *completeness*: an applicant
   * who has a title and nothing else must be able to leave and come back, which is the whole
   * feature. Everything that makes an answer wrong rather than absent — a field the form does not
   * have, one the applicant's own answers hide, an over-long value, a malformed address — is
   * refused here, because storing it would only move the refusal to the moment they press Submit.
   *
   * `idempotencyKey` is the CFP command's existing deterministic key (`PRD-CFP-002`), reused
   * rather than joined by a second one: a retried create converges on the draft the first attempt
   * made instead of leaving two half-written proposals on the dashboard.
   *
   * **It is namespaced by owner before it is stored**, and that is a fix rather than a flourish.
   * `UNIQUE (event_id, idempotency_key)` is not owner-scoped and the key comes from the request, so
   * two accounts naming the same key on one event collided: the second `INSERT OR IGNORE` was
   * skipped as a duplicate and the second caller was handed the *first account's* proposal — id,
   * answers and decision state. Two independent reviewers reproduced it. Scoping the convergence
   * read (`findOwnedProposalByKey`) makes that a refusal instead of a disclosure; namespacing the
   * stored key means the collision cannot happen between accounts in the first place, so an
   * unlucky choice of key does not lock somebody out of creating a draft at all.
   */
  async createDraft(
    actor: Actor | null,
    eventId: string,
    idempotencyKey: string,
    answers: Record<string, string>,
  ): Promise<SubmitterProposalView> {
    const submitter = submitterFor(actor);
    const form = await this.openForm(eventId);
    const fieldErrors = validateAnswers(form.fields, answers, { requireComplete: false });
    if (Object.keys(fieldErrors).length) throw new CfpValidationError(fieldErrors);
    const at = this.now().toISOString();
    const created = await this.repository.createDraft({
      id: this.newId(),
      eventId,
      cfpVersion: form.version,
      idempotencyKey: ownedProposalKey(submitter.id, idempotencyKey),
      answers,
      fields: [],
      resolvedRoute: null,
      submittedAt: at,
      updatedAt: at,
      lifecycle: "draft",
      revision: 1,
      status: CFP_DRAFT_STATUS,
      submitterUserId: submitter.id,
      at,
    });
    // Only one cause is left: the storage guard saw a call that is no longer open. The window is the
    // one member of that conjunction the service read *before* the write, and a call closing in
    // between is a conflict with the resource's state — the same 409 the other two writes answer,
    // rather than the 400 this used to give, which told the applicant their input was wrong.
    if (!created) {
      const live = await this.getPublished(eventId);
      throw new CfpClosedError(
        "This call for proposals closed before the draft was saved.",
        live.effectiveStatus,
      );
    }
    return viewOf(created, form.fields);
  }
  /** One proposal this account owns, or an indistinguishable 404. */
  async myProposal(
    actor: Actor | null,
    eventId: string,
    proposalId: string,
  ): Promise<SubmitterProposalView> {
    const submitter = submitterFor(actor);
    const [proposal, published] = await Promise.all([
      this.repository.findProposalForOwner(eventId, proposalId, submitter.id),
      this.repository.findPublished(eventId),
    ]);
    if (!proposal) throw new CfpProposalNotFoundError("Proposal not found");
    return viewOf(proposal, published?.fields ?? []);
  }
  /**
   * Revise a proposal, draft or submitted, while the call is open.
   *
   * A submitted proposal is held to the whole form: it is in front of reviewers, and an edit that
   * emptied a required answer would leave them reading a proposal the form would have refused. A
   * draft is held to the same shape rules and not to completeness, exactly as when it was created.
   */
  async saveProposal(
    actor: Actor | null,
    eventId: string,
    proposalId: string,
    answers: Record<string, string>,
    expectedRevision: number,
  ): Promise<SubmitterProposalView> {
    const submitter = submitterFor(actor);
    const form = await this.openForm(eventId);
    const existing = await this.owned(eventId, proposalId, submitter.id);
    const fieldErrors = validateAnswers(form.fields, answers, {
      requireComplete: existing.lifecycle !== "draft",
    });
    if (Object.keys(fieldErrors).length) throw new CfpValidationError(fieldErrors);
    // One reading of the clock for both fields. Two calls could straddle a millisecond and record
    // a row whose `updated_at` is not the instant its window guard was judged against.
    const at = this.now().toISOString();
    const write: ProposalOwnerWrite = {
      eventId,
      proposalId,
      submitterUserId: submitter.id,
      answers,
      expectedRevision,
      updatedAt: at,
      at,
      /*
       * The form these answers were just validated against — stored with them, for a **submitted**
       * proposal only.
       *
       * A submitted proposal is read through its own snapshot everywhere: every organizer and
       * reviewer projection resolves an answer by looking its field up there, so answers written
       * against a republished form under the old snapshot render as an empty proposal. Writing
       * both together is what keeps them agreeing.
       *
       * A draft is the opposite case and keeps its empty snapshot, which is `viewOf`'s stated
       * invariant: a draft has not met a published form yet, so it is named from the live one, and
       * freezing a snapshot on its first revision would name it from a question the organizer has
       * since replaced. Passing `form.fields` unconditionally quietly ended that — the first
       * revision froze it — which a review pass caught by reading the comment that governs it.
       */
      ...(existing.lifecycle === "draft"
        ? { cfpVersion: existing.cfpVersion, fields: [] }
        : { cfpVersion: form.version, fields: form.fields }),
      // And the write asserts the lifecycle the branch above was chosen for, so a row that moved
      // between that read and this write matches nothing rather than being written under a
      // decision that no longer applies to it.
      lifecycle: existing.lifecycle ?? "submitted",
    };
    if (!(await this.repository.saveProposalAnswers(write)))
      await this.explainRefusedWrite(
        eventId,
        proposalId,
        submitter.id,
        expectedRevision,
        write.lifecycle,
      );
    return this.myProposal(actor, eventId, proposalId);
  }
  /**
   * Submit a draft: the answers on screen, validated in full, against the form as it is now.
   *
   * The answers travel with the command rather than being read back from the draft, and that is
   * deliberate. A draft can outlive the form it was started against — an organizer may have
   * replaced a question in between — so submitting the stored copy could send an answer to a
   * question that no longer exists and fail with a validation error naming a field the applicant
   * cannot see. Submitting what is on screen means the client's own rendering of the current form
   * is what gets validated, and the snapshot stored beside it is the form that was actually
   * answered.
   */
  async submitProposal(
    actor: Actor | null,
    eventId: string,
    proposalId: string,
    answers: Record<string, string>,
    expectedRevision: number,
  ): Promise<SubmitterProposalView> {
    const submitter = submitterFor(actor);
    const form = await this.openForm(eventId);
    const existing = await this.owned(eventId, proposalId, submitter.id);
    if (existing.lifecycle !== "draft")
      // The same 409 the storage guard's explainer gives for the same fact — a proposal that has
      // moved on is a conflict with the resource's state, not a fault in the request. This is the
      // branch a double-click on Submit actually reaches, since the pre-read sees the row the
      // first click submitted.
      throw new CfpProposalStateConflictError("This proposal has already been submitted.");
    const fieldErrors = validateAnswers(form.fields, answers);
    if (Object.keys(fieldErrors).length) throw new CfpValidationError(fieldErrors);
    const at = this.now().toISOString();
    const resolvedRoute = resolveRoute(form.routing ?? [], answers);
    const write: ProposalSubmitWrite = {
      eventId,
      proposalId,
      submitterUserId: submitter.id,
      answers,
      expectedRevision,
      updatedAt: at,
      at,
      cfpVersion: form.version,
      fields: form.fields,
      resolvedRoute,
      status: resolvedRoute?.status ?? "submitted",
      submittedAt: at,
    };
    if (!(await this.repository.submitProposal(write)))
      await this.explainRefusedWrite(eventId, proposalId, submitter.id, expectedRevision, "draft");
    /*
     * Announced from the write, and *before* the read-back.
     *
     * Everything the confirmation needs is already here — this is the write that just committed —
     * so making the announcement wait on a second read put a fallible step between a one-way
     * action and the message that tells somebody it happened. A transient read failure there
     * answered 500 over a submission that had committed, and the applicant's retry is then
     * refused with "already submitted", so no confirmation would ever have been queued. That is
     * the same shape the composition root's `recipientFor` exists to prevent, reproduced one
     * layer up. The read-back below is now only for the view that is returned.
     */
    await this.announce(
      { ...write, id: proposalId, fields: write.fields, answers: write.answers },
      submitter.id,
    );
    const submitted = await this.owned(eventId, proposalId, submitter.id);
    return viewOf(submitted, form.fields);
  }
  async proposalReference(
    proposalId: string,
    eventId: string,
  ): Promise<SubmittedProposalReference | null> {
    const proposal = await this.repository.findSubmissionById(eventId, proposalId);
    return proposal
      ? { proposalId, eventId, cfpVersion: proposal.cfpVersion, submittedAt: proposal.submittedAt }
      : null;
  }
  private async owned(eventId: string, proposalId: string, submitterUserId: string) {
    const proposal = await this.repository.findProposalForOwner(
      eventId,
      proposalId,
      submitterUserId,
    );
    if (!proposal) throw new CfpProposalNotFoundError("Proposal not found");
    return proposal;
  }
  /**
   * Say *why* a guarded write matched no row, and always throw.
   *
   * The write's WHERE clause is one conjunction — this account, this proposal, this revision, the
   * lifecycle it was built for, and a call that is open — so a zero-row result on its own cannot
   * tell a person which of those it was. Re-reading afterwards can, and each answer needs its own
   * sentence: reload the newer copy, sign in as the owner, the proposal has since been submitted,
   * or the deadline has passed. Deciding it from the reads *before* the write instead would be a
   * guess: whatever they said, the write is the thing that lost the race.
   *
   * **Every member of the conjunction needs a branch here, and the last one is the trap.** The
   * final `throw` is reached by elimination, so a predicate added to the write without a branch
   * added here does not produce a wrong error *code* — it produces a confident wrong *sentence*,
   * and the one it borrows says the call is closed while the call is open. That is exactly what
   * adding the lifecycle predicate did.
   */
  private async explainRefusedWrite(
    eventId: string,
    proposalId: string,
    submitterUserId: string,
    expectedRevision: number,
    expectedLifecycle: ProposalLifecycle,
  ): Promise<never> {
    const current = await this.repository.findProposalForOwner(
      eventId,
      proposalId,
      submitterUserId,
    );
    if (!current) throw new CfpProposalNotFoundError("Proposal not found");
    /*
     * Lifecycle **before** revision, and the order is the whole of whether this branch does
     * anything.
     *
     * Every lifecycle change also advances `revision` — `submitProposal` does
     * `revision = revision + 1` — so a row that moved draft→submitted under a caller fails *both*
     * predicates, and checking revision first answers every realistic race with "this changed in
     * another tab": a double-click on Submit, and a revision that lost to a concurrent submit
     * while carrying the revision it actually read. Both are then told to reload a draft that is
     * no longer a draft. The reverse order cannot mis-answer, because a lifecycle mismatch is
     * never *merely* a stale revision, and a matching lifecycle falls through to the revision
     * check unchanged.
     *
     * This was written the other way round first, which made the branch structurally present and
     * behaviourally empty — reachable only by a combination no client in this system produces.
     */
    if ((current.lifecycle ?? "submitted") !== expectedLifecycle)
      // One sentence rather than two. The mismatch can only be draft→submitted: the other
      // direction is a regression that migration `1201`'s `cfp_submission_lifecycle_no_regression`
      // refuses, and a stale read shows an older state rather than a newer one. A branch for a
      // case that cannot happen is a claim nobody can check.
      throw new CfpProposalStateConflictError("This proposal has already been submitted.");
    if ((current.revision ?? 1) !== expectedRevision)
      throw new CfpDraftConflictError("This proposal changed in another tab or window");
    // Owner, revision and lifecycle all still match, so what is left is the window: an organizer
    // closed the call between this request's read and its write.
    const form = await this.getPublished(eventId);
    throw new CfpClosedError(
      "This call for proposals closed before the change was saved.",
      form.effectiveStatus,
    );
  }
  /**
   * Ask communications to confirm one submission.
   *
   * The parameter is the four fields this actually reads rather than a whole `ProposalSubmission`,
   * so it can be called with the write that just committed instead of requiring a read-back —
   * which is what keeps a fallible read out from between a one-way action and its confirmation.
   */
  private async announce(
    proposal: {
      readonly eventId: string;
      readonly id: string;
      readonly fields: readonly CfpField[];
      readonly answers: Readonly<Record<string, string>>;
    },
    submitterUserId: string,
  ) {
    await this.notifications?.proposalSubmitted({
      eventId: proposal.eventId,
      proposalId: proposal.id,
      submitterUserId,
      proposalTitle: proposalTitleOf(proposal.fields, proposal.answers),
    });
  }
}

/**
 * The stored idempotency key for a proposal an account owns.
 *
 * `UNIQUE (event_id, idempotency_key)` is the whole of the duplicate-suppression contract and it is
 * not owner-scoped, so a client-supplied key is only unique per *event* — which made one account's
 * key able to answer another account's create. Prefixing with the owner makes the namespace
 * per-account, so a retry still converges and a collision between two people cannot occur.
 *
 * The anonymous path deliberately keeps the bare key: its rows are the ones already stored that way,
 * and its convergence read is scoped to `submitter_user_id IS NULL` instead. An anonymous caller
 * could still *spell* a prefixed key and squat one, which costs the owner a refusal rather than any
 * disclosure and requires guessing a user id and a UUID; that residual is recorded in `GAP-027`.
 */
const ownedProposalKey = (submitterUserId: string, clientKey: string): string =>
  `proposal:${submitterUserId}:${clientKey}`;

/**
 * An instant, or a refusal — never a re-interpretation.
 *
 * The storage guards compare these columns as text (migration `1201`), so two spellings of one
 * instant are two different deadlines to SQLite. Everything stored here is therefore put through
 * `Date` and re-emitted in the single shape `toISOString` produces.
 *
 * At the HTTP boundary that is currently belt and braces rather than the load-bearing step: the
 * window contract uses `z.string().datetime()` without `{ offset: true }`, which refuses an offset
 * spelling like `2026-09-30T23:59:00+02:00` outright, and refuses an expanded year too. This is
 * not written for that caller. It is written for the *next* one — a contract change, an internal
 * command, a fixture — because a normalisation that only holds while a schema elsewhere stays
 * strict is not a property of this function. An earlier version of this comment claimed the offset
 * spelling arrives on the wire, which was wrong about the contract while being right about the
 * need; a review pass caught it.
 */
function normalizeInstant(value: string | null, field: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new CfpValidationError({ [field]: ["Enter a date and time."] });
  return new Date(parsed).toISOString();
}
export function conditionMatches(
  condition: CfpCondition | undefined,
  answers: Readonly<Record<string, string>>,
) {
  if (!condition) return true;
  const value = answers[condition.fieldId]?.trim() ?? "";
  if (condition.operator === "notEmpty") return Boolean(value);
  if (condition.operator === "equals") return value === (condition.values[0] ?? "");
  return condition.values.includes(value);
}

/**
 * The first matching rule's destination — unless that destination is a decision.
 *
 * `save` now refuses such a rule outright, but a rule stored *before* it did is still in a published
 * snapshot, and this is what a submission meeting one does: it takes no route, so the proposal lands
 * in the default triage status and the submitter is told "under consideration" rather than
 * "accepted". Refusing the submission instead would punish the applicant for the organizer's
 * configuration, and honouring it would tell them they had been accepted by nobody.
 *
 * The rule is deliberately dropped rather than skipped-and-continued: the applicant's answers
 * matched it, and the next rule down is not the one the organizer meant for them either.
 */
function resolveRoute(
  routing: readonly CfpRoutingRule[],
  answers: Readonly<Record<string, string>>,
) {
  const rule = routing.find(({ when }) => conditionMatches(when, answers));
  if (!rule || isDecisionStatus(rule.routeTo.status)) return null;
  return { ruleId: rule.id, status: rule.routeTo.status };
}
/**
 * `requireComplete: false` skips the required-field rule and nothing else.
 *
 * That distinction is the draft feature. An answer that is *absent* is the normal state of a
 * proposal somebody is still writing; an answer that is *wrong* — to a question the form does not
 * ask, to one the applicant's own answers hide, too long for the field, or not an address where
 * the form asked for one — is refused whichever way it arrives, because accepting it would only
 * move the refusal to the moment they press Submit, with the answer already stored.
 */
function validateAnswers(
  fields: readonly CfpField[],
  answers: Record<string, string>,
  { requireComplete = true }: { requireComplete?: boolean } = {},
) {
  const errors: Record<string, string[]> = {};
  const ids = new Set(fields.map(({ id }) => id));
  for (const key of Object.keys(answers))
    if (!ids.has(key)) errors[`answers.${key}`] = ["This field is not part of the published form."];
  for (const field of fields) {
    const visible = conditionMatches(field.visibleWhen, answers);
    if (!visible && Object.hasOwn(answers, field.id)) {
      errors[`answers.${field.id}`] = ["This field is hidden for the answers you selected."];
      continue;
    }
    if (!visible) continue;
    const value = answers[field.id]?.trim() ?? "";
    const limit = cfpFieldMaxLength(field);
    if (field.required && !value) {
      if (requireComplete) errors[`answers.${field.id}`] = ["This field is required."];
    }
    // The limit the published form advertises is the limit the submission is held to, so a
    // form cannot promise room the server refuses — nor accept a 120 KB answer it never asked
    // for. `submitProposalInputSchema` bounds the body first; this bounds each field.
    else if (value.length > limit)
      errors[`answers.${field.id}`] = [`Keep this answer under ${limit} characters.`];
    else if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      errors[`answers.${field.id}`] = ["Enter a valid email address."];
    else if (value && field.type === "select" && !field.options.includes(value))
      errors[`answers.${field.id}`] = ["Choose one of the available options."];
  }
  return errors;
}
