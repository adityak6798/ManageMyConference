/**
 * The applicant's whole surface: the call, the form, and — once there is an account behind it —
 * the proposals that account owns.
 *
 * Both doors are here on purpose. Anonymous submission still works exactly as it did (`ACC-CFP`,
 * `PRD-CFP-002`), and a real conference may want it; what signing in adds is everything ownership
 * makes possible — a draft that survives a closed browser, an edit while the call is open, a
 * decision the submitter can read, and a confirmation sent to an address nobody had to claim.
 *
 * @spec PRD-CFP-001 PRD-CFP-002
 */
import { cfpConditionMatches, type SessionDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  CfpApiError,
  type CfpFormDto,
  createProposalDraft,
  loadMyProposals,
  saveProposal,
  submitOwnedProposal,
  type SubmitterProposalDto,
  submitProposal,
} from "../api/cfp";
import {
  type AuthDoors,
  probeIdentity,
  signOut,
  startDemoSession,
  describeIdentityFailure,
} from "../api/identity";
import { Pill } from "./cards";
import { fullTimeWithZone } from "./model";

/**
 * Four states, and `scheduled` is the one worth having separately.
 *
 * "Opens on the 3rd" and "you have missed it" are opposite messages, and a surface that folded
 * them into one `closed` would have to pick the wrong one half the time. `unknown` is what the page
 * says when the live call could not be read at all — it never guesses from the published snapshot,
 * which can contradict the call itself the moment an organizer closes it.
 */
type CfpStatus = "open" | "scheduled" | "closed" | "unknown";

/** What a submitter's own proposal is called on the dashboard, per state. */
const STATE_LABELS: Record<SubmitterProposalDto["state"], string> = {
  draft: "Draft",
  under_consideration: "Under consideration",
  accepted: "Accepted",
  declined: "Not accepted",
};

/**
 * The demo deployment's way in, and the reason it is offered here at all.
 *
 * `DEMO_MODE` turns emailed-code sign-in off and this deployment configures no Google client, so
 * seeded personas are the only identities that exist (`apps/api/wrangler.toml`). Neither of these
 * two holds any organizer capability, which is what makes them honest stand-ins for a submitter —
 * and an organizer is deliberately not offered, because "sign in as the conference's organizer to
 * propose a talk" is not a journey anybody should be shown.
 */
const DEMO_SUBMITTERS = [
  { persona: "public" as const, label: "Pat Attendee" },
  { persona: "speaker" as const, label: "Sam Speaker" },
];

/** Owns the public proposal form's answers, validation, and idempotent submission lifecycle. */
export function PublicCfpView({
  eventId,
  liveCfp,
  unavailable,
  status,
  statusLine,
  title,
  description,
  timezone,
}: {
  eventId: string;
  liveCfp: CfpFormDto | null;
  unavailable: string | null;
  status: CfpStatus;
  statusLine: string;
  title: string;
  description: string;
  /** The event's IANA zone: every deadline on this page is stated in it, never in the browser's. */
  timezone: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [doors, setDoors] = useState<AuthDoors | null>(null);
  const [proposals, setProposals] = useState<readonly SubmitterProposalDto[]>([]);
  /** The owned proposal the form is bound to, or null when the form is a fresh one. */
  const [editing, setEditing] = useState<SubmitterProposalDto | null>(null);
  // `/api/session` answers 401 to a visitor with no credential, which `probeIdentity` resolves as
  // a null session rather than as a failure — so holding one is the whole test.
  const signedIn = session !== null;

  /**
   * Reload the dashboard, and apply only the newest answer.
   *
   * The refresh is fire-and-forget and fires after `setSubmitting(false)`, so the controls are
   * live again while it is still in flight and a second action can start before the first's read
   * returns. Without a generation the older answer can land last: save, then submit, then the
   * *save's* list arrives and repaints the row as a draft with a Continue button — beside a
   * notice saying the proposal was submitted, and offering a Submit whose only outcome is a 409.
   * Making the refresh non-blocking is what introduced that; the earlier awaited version could
   * not overlap. This keeps the non-blocking behaviour and drops stale answers instead.
   *
   * It closes one thing only: an older *response* overwriting a newer one. It does not make the
   * list fresh — between the controls being re-enabled and the read landing, what is on screen is
   * a refresh behind, and clicking it binds a stale revision. `openForEditing` handles that
   * separately by preferring the copy the last write returned.
   */
  const refreshGeneration = useRef(0);
  const refreshProposals = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const listed = await loadMyProposals(eventId);
    if (generation === refreshGeneration.current) setProposals(listed);
  }, [eventId]);

  useEffect(() => {
    let live = true;
    // A visitor who is not signed in is the ordinary case rather than a failure, which is what
    // `probeIdentity` resolves rather than rejects.
    // ERROR-INTENT: React effects cannot await; both outcomes below are rendered.
    void probeIdentity()
      .then(async (identity) => {
        if (!live) return;
        setSession(identity.session);
        setDoors(identity.doors);
        /*
         * Reloaded separately from the identity probe, so a failed *list* read is not reported as
         * a failed sign-in check: the catch below renders an identity sentence, and "Something
         * went wrong, contact support" is the wrong thing to say about an empty dashboard.
         */
        // ERROR-INTENT: an absent list is what a failed read leaves, and the page renders that.
        if (identity.session) void refreshProposals().catch(() => undefined);
      })
      .catch((reason: unknown) => {
        // ERROR-INTENT: rendered rather than rethrown. A visitor whose identity could not be read
        // still gets the anonymous form, which is the whole page for most of them; the reason is
        // reported in the notice with its correlation reference so it is recoverable rather than
        // silently missing.
        if (live) setNotice({ tone: "error", text: describeIdentityFailure(reason) });
      });
    return () => {
      live = false;
    };
  }, [refreshProposals]);

  /**
   * Report a refusal beside the control that caused it, keeping any field errors it carried.
   *
   * `fallback` names the *action*, and it is always said — the server's message is added to it
   * rather than replacing it. The API's generic refusal is "Something went wrong.", so preferring
   * the server's message left an applicant whose submit failed with a live region reading exactly
   * that, and nothing saying the proposal had not been sent. This notice also serves sign-out,
   * demo sign-in and save, so a blanket "Not submitted — " prefix was the wrong way to fix it: it
   * produced "Not submitted — This proposal has already been submitted."
   */
  function report(reason: unknown, fallback: string) {
    // ERROR-INTENT: the public form renders submission failures next to the fields.
    if (reason instanceof CfpApiError) setFieldErrors(reason.envelope.error.fieldErrors ?? {});
    const detail = reason instanceof CfpApiError ? reason.message : "";
    setNotice({
      tone: "error",
      text: detail && detail !== fallback ? `${fallback} ${detail}` : fallback,
    });
  }

  /**
   * Run one applicant action, render its outcome, and reload the dashboard afterwards.
   *
   * `refreshes` is false for the two actions that end this page's session — signing out and
   * signing in as a demo persona both reload the window — where a proposals read is guaranteed to
   * answer 401 or to be thrown away, and exists only because the guard tested "is somebody signed
   * in" rather than "does this action leave a list worth reading".
   */
  async function guarded(
    action: () => Promise<void>,
    fallback: string,
    { refreshes = true }: { refreshes?: boolean } = {},
  ) {
    setSubmitting(true);
    setNotice(null);
    setFieldErrors({});
    try {
      await action();
    } catch (reason) {
      // ERROR-INTENT: every failure of an applicant's action is rendered beside the form it came
      // from, with the envelope's field errors on the questions they belong to — `report` above.
      report(reason, fallback);
    } finally {
      setSubmitting(false);
      /*
       * The dashboard catches up here, once, after every action — and never as part of one.
       *
       * It used to be awaited inside the actions themselves, which made a *decorative* read gate
       * the thing the applicant pressed. Two separate repairs each fixed one call site and left
       * the other, and the one left behind was the worse of the two: awaited **after** a
       * successful submit, it reported "The proposal could not be submitted." over a proposal
       * that had been submitted, having already cleared the form and rotated the idempotency key
       * — so the applicant retyped, pressed Submit, and created a second proposal. On a one-way
       * action.
       *
       * One call, outside the try, non-fatal, and after both outcomes: a failed read leaves a
       * stale list and changes nothing else, and a single call cannot race itself the way two
       * could — the earlier fix produced a dashboard showing "Draft · Continue" beside a notice
       * saying the proposal was submitted.
       *
       * ERROR-INTENT: a list that failed to reload is stale and nothing more; the action's own
       * outcome is already rendered, and the next action or page load reads it again.
       */
      // ERROR-INTENT: a list that failed to reload is stale and nothing more.
      if (refreshes && signedIn) void refreshProposals().catch(() => undefined);
    }
  }

  /** Anonymous submission: unchanged, and the only path that produces an unowned proposal. */
  const submitAnonymously = () =>
    guarded(async () => {
      const confirmation = await submitProposal(eventId, answers, submissionKey);
      setNotice({
        tone: "ok",
        text: `Proposal received. Confirmation: ${confirmation.confirmationId}`,
      });
      setSubmissionKey(crypto.randomUUID());
      setAnswers({});
    }, "The proposal could not be submitted.");

  /**
   * Save without submitting — a new draft, a revision to one, or a revision to a submitted proposal.
   *
   * A draft the applicant has not created yet is created here rather than on page load: a visitor
   * who opens the form and leaves should not have left a half-empty proposal behind on their own
   * dashboard.
   */
  const saveDraft = () =>
    guarded(async () => {
      const saved = editing
        ? await saveProposal(eventId, editing.id, answers, editing.revision)
        : await createProposalDraft(eventId, answers, submissionKey);
      setEditing(saved);
      setSubmissionKey(crypto.randomUUID());
      setNotice({
        tone: "ok",
        // Two different things happened, so two different sentences: a revision to something the
        // organizers already hold is *with them* now, and saying "come back any time" about it
        // would suggest it is still private.
        text:
          saved.lifecycle === "submitted"
            ? "Saved. The organizers see this revision."
            : "Saved. You can come back to this proposal any time.",
      });
    }, "The proposal could not be saved.");

  /**
   * Submit, as the signed-in owner.
   *
   * A proposal that was never saved is created and submitted in two calls rather than one, so that
   * every submitted proposal has the same shape on the dashboard however it got there — and so the
   * first call's idempotency key still converges if the second one is retried.
   */
  const submitOwned = () =>
    guarded(async () => {
      let target = editing;
      if (!target) {
        /*
         * Adopt the draft the *moment* it exists, before the submit that may fail.
         *
         * The create and the submit are two calls, so anything between them can refuse — a closed
         * call, a field the browser's own validation cannot pre-catch, a 500. The row exists
         * either way. Leaving `editing` null until the submit succeeded meant the applicant's next
         * Save draft took the *create* branch again with the same key, which converges on the row
         * that already exists **without updating its answers** — and then said "Saved." So a
         * correction typed after a failed submit was discarded, and the page said it was kept.
         *
         * Adopting here makes every path after this a revision of a proposal we know about.
         */
        target = await createProposalDraft(eventId, answers, submissionKey);
        setEditing(target);
        setSubmissionKey(crypto.randomUUID());
      }
      const submitted = await submitOwnedProposal(eventId, target.id, answers, target.revision);
      setEditing(null);
      setAnswers({});
      setSubmissionKey(crypto.randomUUID());
      setNotice({
        tone: "ok",
        text: `Proposal submitted. Confirmation: ${submitted.id}`,
      });
    }, "The proposal could not be submitted.");

  /**
   * Answers this proposal holds that the form as published *now* would refuse.
   *
   * A stored proposal is a snapshot of the form it was written against, and an organizer may have
   * republished since: removed a question, or changed a condition so an answered question is
   * hidden. The server validates a revision against the **current** form and refuses both shapes
   * — so loading the answers verbatim produced a draft that could never be saved and never be
   * submitted, with an error the page could not even point at: `fieldErrors` is rendered inside
   * the loop over visible fields, so an error keyed to a removed or hidden one has nowhere to
   * go. The applicant sees "Review the highlighted proposal fields" and no highlighted field, and
   * there is no delete, so the row is stranded.
   *
   * This is the same pruning the change handler already does on every keystroke; it just was not
   * done on the way in.
   *
   * **One pass is enough only because a condition may not reference a later question**
   * (`PRD-CFP-001`, enforced by `saveCfpInputSchema`). With forward references legal, deleting a
   * hidden field could hide a field examined earlier in the loop and the set would need
   * re-running to a fixed point. A fuzz over 4,000 schema-valid forms found no case where one
   * pass leaves an answer the server would refuse; reversing the field order in a hand-built form
   * does, which is what makes the dependency real rather than incidental.
   *
   * It also covers **two** of `validateAnswers`' refusals — unknown key and hidden field — and
   * deliberately not the other three. Length, email format and select-option all land on a
   * *visible* field, where the error renders next to the question and the applicant can fix it.
   * Pruning those would delete their work to avoid showing them a message they can act on.
   */
  const answersTheFormStillAccepts = (stored: Readonly<Record<string, string>>) => {
    const fields = liveCfp?.fields ?? [];
    const kept: Record<string, string> = {};
    for (const [id, value] of Object.entries(stored))
      if (fields.some((field) => field.id === id)) kept[id] = value;
    for (const field of fields)
      if (!cfpConditionMatches(field.visibleWhen, kept)) delete kept[field.id];
    return kept;
  };

  const openForEditing = (proposal: SubmitterProposalDto) => {
    /*
     * Rebind from the copy in hand when it is the same proposal.
     *
     * The list can be a refresh behind — the controls come back before the trailing read lands —
     * so `Continue` on the row you have just saved could hand back the revision *before* that
     * save, and the next save is then refused as a conflict with the applicant's own edit.
     * `editing` holds what the write returned, which is never staler than the list.
     */
    const current = editing?.id === proposal.id ? editing : proposal;
    const kept = answersTheFormStillAccepts(current.answers);
    const dropped = Object.keys(current.answers).length - Object.keys(kept).length;
    setEditing(current);
    setAnswers(kept);
    setFieldErrors({});
    // Announced rather than only rendered: the form below has just changed underneath somebody who
    // pressed a button in the list above it, and that is not visible to a screen reader. And when
    // the form has moved on beneath the proposal, that is said rather than left to be noticed —
    // saving is what makes the loss permanent, so it is not something to discover afterwards.
    setNotice({
      tone: "ok",
      text: dropped
        ? `Editing ${current.title ?? "your proposal"}. The form has changed since you wrote it, so ${dropped === 1 ? "one answer no longer has a question" : `${dropped} answers no longer have questions`} and saving will drop ${dropped === 1 ? "it" : "them"}.`
        : `Editing ${current.title ?? "your proposal"}. Change what you need, then save or submit it.`,
    });
  };
  const startFresh = () => {
    setEditing(null);
    setAnswers({});
    setFieldErrors({});
    setNotice(null);
  };

  function onFormSubmit(event: FormEvent) {
    event.preventDefault();
    // ERROR-INTENT: handlers cannot await; both branches render their own outcome.
    void (signedIn ? submitOwned() : submitAnonymously());
  }

  /*
   * Labelled from the instant, not from the event's week.
   *
   * A deadline is usually outside the programme's own days — a call closing in December for a
   * conference in September — so the event-week abbreviation printed `PDT` beside a time that was
   * really `PST`. The same applies to a proposal's `submittedAt` and `updatedAt`.
   */
  const inZone = (instant: string) => fullTimeWithZone(instant, timezone);
  /**
   * The deadline, stated wherever there is one — including on a call that is already closed,
   * because "closed" without a date reads as a decision somebody made this morning.
   */
  const scheduleLine = liveCfp
    ? status === "scheduled" && liveCfp.opensAt
      ? `Submissions open ${inZone(liveCfp.opensAt)}.`
      : liveCfp.closesAt
        ? status === "closed"
          ? `Submissions closed ${inZone(liveCfp.closesAt)}.`
          : `Submissions close ${inZone(liveCfp.closesAt)}.`
        : null
    : null;
  const formOpen = liveCfp !== null && status === "open";

  return (
    <article className="pub-detail">
      <div className="pub-head">
        <p className="kicker">Call for proposals</p>
        <h1>{title}</h1>
        <p className="pub-tz">
          {status === "unknown" ? null : (
            <Pill tone={status === "open" ? "ok" : "neutral"}>
              {status === "open" ? "Open" : status === "scheduled" ? "Opening soon" : "Closed"}
            </Pill>
          )}
          {statusLine}
        </p>
        {scheduleLine ? <p className="pub-tz pub-cfp-deadline">{scheduleLine}</p> : null}
      </div>
      <p className="lede">{description}</p>
      {unavailable ? (
        <p className="pub-notice is-error" role="alert">
          {unavailable}
        </p>
      ) : null}

      {signedIn ? (
        <section className="pub-section" aria-labelledby="pub-my-proposals">
          <div className="pub-section-head">
            <h2 id="pub-my-proposals">Your proposals</h2>
            {/*
              Disabled while a write is in flight, like every other control on this page.
              Switching which proposal the form is bound to *during* a save rebinds `answers`
              while the resolving save is still about to set `editing` — so the next save sent
              one proposal's answers under another's id, overwriting it, and the page said
              "Saved." `Start another proposal` was the worse of the two: it clears the form, so a
              whole new proposal was typed and then written over the previous one as a `PUT`,
              with no create issued at all.
            */}
            {formOpen && editing ? (
              <button
                type="button"
                className="pub-button"
                disabled={submitting}
                onClick={startFresh}
              >
                Start another proposal
              </button>
            ) : null}
          </div>
          {/*
            Who this is, and the way out.
            An applicant may well be on a shared or borrowed machine — this page is reached from a
            public link, not from a console somebody signed into on purpose — so the identity their
            proposals are being filed under is named, and leaving is one click rather than a trip
            through the organizer console they cannot open.
          */}
          <p className="pub-note pub-signed-in">
            Signed in as {session?.actor.name ?? "your account"}.{" "}
            <button
              type="button"
              className="pub-linklike"
              disabled={submitting}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; `guarded` renders the failure and the
                // reload is what re-reads this page's identity from the API.
                void guarded(
                  async () => {
                    await signOut();
                    window.location.reload();
                  },
                  "Signing out did not work. Close the browser to be sure.",
                  { refreshes: false },
                );
              }}
            >
              Sign out
            </button>
          </p>
          {proposals.length === 0 ? (
            <p className="pub-note">
              Nothing yet. Fill in the form below and save it as a draft, or submit it straight away
              — either way it appears here.
            </p>
          ) : (
            <ul className="pub-proposal-list">
              {proposals.map((proposal) => (
                <li key={proposal.id} className="pub-proposal">
                  <div>
                    <p className="pub-proposal-title">{proposal.title ?? "Untitled proposal"}</p>
                    <p className="pub-note">
                      {proposal.submittedAt
                        ? `Submitted ${inZone(proposal.submittedAt)}`
                        : `Last saved ${inZone(proposal.updatedAt)}`}
                    </p>
                  </div>
                  <div className="pub-proposal-side">
                    <Pill
                      tone={
                        proposal.state === "accepted"
                          ? "ok"
                          : proposal.state === "draft"
                            ? "info"
                            : "neutral"
                      }
                    >
                      {STATE_LABELS[proposal.state]}
                    </Pill>
                    {formOpen ? (
                      <button
                        type="button"
                        className="pub-button"
                        // See `Start another proposal`: rebinding the form mid-write is how one
                        // proposal's answers end up saved over another's.
                        disabled={submitting}
                        onClick={() => openForEditing(proposal)}
                      >
                        {proposal.lifecycle === "draft"
                          ? `Continue ${proposal.title ?? "draft"}`
                          : `Edit ${proposal.title ?? "proposal"}`}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {/* Stated rather than left to be discovered: after the deadline the list is a record. */}
          {!formOpen && proposals.length > 0 ? (
            <p className="pub-note">
              The call is no longer open, so these can be read but not changed. A decision appears
              here as soon as the organizers record one.
            </p>
          ) : null}
        </section>
      ) : null}

      {/*
        The door is offered whenever the call can be *read*, not only while it is open.
        Gating it on `formOpen` left a signed-out applicant on a closed call with neither their
        dashboard nor any way to reach it — and a decision is normally recorded *after* the call
        closes, which makes that the main occasion for coming back at all. The invitation changes
        wording rather than disappearing.
      */}
      {liveCfp !== null && status !== "unknown" && !signedIn ? (
        <section className="pub-signin" aria-labelledby="pub-cfp-signin">
          <h2 id="pub-cfp-signin">
            {formOpen ? "Keep track of your proposal" : "Already proposed something?"}
          </h2>
          <p className="pub-note">
            {formOpen
              ? "Sign in and your drafts, revisions and decision stay on this page. You can submit without an account, but an anonymous proposal cannot be edited or followed afterwards."
              : "Submissions are not open, but signing in shows the proposals on your account and any decision the organizers have recorded."}
          </p>
          <div className="pub-signin-doors">
            {doors?.google ? (
              <a className="pub-button" href="/api/auth/google/start">
                Continue with Google
              </a>
            ) : null}
            {doors?.demoMode
              ? DEMO_SUBMITTERS.map((identity) => (
                  <button
                    key={identity.persona}
                    type="button"
                    className="pub-button"
                    disabled={submitting}
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await, and a demo sign-in has to re-read
                      // the page's own identity, so the outcome is rendered by the reload.
                      void guarded(
                        async () => {
                          await startDemoSession(identity.persona);
                          window.location.reload();
                        },
                        "That demo identity could not be used.",
                        // Signing *in* also reloads, and `signedIn` is still false here anyway.
                        { refreshes: false },
                      );
                    }}
                  >
                    Continue as {identity.label}
                  </button>
                ))
              : null}
            {!doors?.google && !doors?.demoMode ? (
              <p className="pub-note">
                This deployment offers no sign-in, so proposals here are anonymous.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {formOpen ? (
        <form className="pub-form" onSubmit={onFormSubmit}>
          {/*
            Which proposal the form is bound to. Deliberately *not* a live region: the notice at the
            bottom is the one, and two of them competing means a screen reader announces whichever
            React happened to update second. Opening a proposal for editing announces itself
            through that notice instead.
          */}
          {editing ? (
            <p className="pub-note">
              Editing {editing.title ?? "your proposal"} ·{" "}
              {editing.lifecycle === "draft" ? "draft" : "already submitted"}
            </p>
          ) : null}
          {(liveCfp?.fields ?? [])
            .filter((field) => cfpConditionMatches(field.visibleWhen, answers))
            .map((field) => {
              const errors = fieldErrors[`answers.${field.id}`] ?? [];
              const errorId = `public-cfp-${field.id}-error`;
              const shared = {
                id: `public-cfp-${field.id}`,
                required: field.required,
                "aria-invalid": errors.length > 0,
                "aria-describedby": errors.length ? errorId : undefined,
                value: answers[field.id] ?? "",
                onChange: (event: { target: { value: string } }) =>
                  setAnswers((current) => {
                    const updated = { ...current, [field.id]: event.target.value };
                    for (const candidate of liveCfp?.fields ?? [])
                      if (!cfpConditionMatches(candidate.visibleWhen, updated))
                        delete updated[candidate.id];
                    return updated;
                  }),
              };
              return (
                <div className="pub-cfp-field" key={field.id}>
                  <label htmlFor={shared.id}>
                    {field.label}
                    {field.required ? " *" : ""}
                  </label>
                  {field.guidance ? <small>{field.guidance}</small> : null}
                  {field.type === "long_text" ? (
                    <textarea {...shared} />
                  ) : field.type === "select" ? (
                    <select {...shared}>
                      <option value="">Choose an option</option>
                      {field.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input {...shared} type={field.type === "email" ? "email" : "text"} />
                  )}
                  {errors.length ? (
                    <ul id={errorId} className="pub-field-errors">
                      {errors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          {/*
            Two shapes, decided by what is on the form rather than by what the API would accept.

            A proposal that has already been submitted cannot be submitted again — the service
            refuses it — so offering "Submit proposal" over one would be a button whose only outcome
            is an error message. Editing one offers a save and nothing else; everything unsubmitted
            offers both, with the submit as the primary action.
          */}
          <div className="pub-form-actions">
            {editing?.lifecycle === "submitted" ? (
              <button
                className="primary"
                type="button"
                disabled={submitting}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; saveDraft renders its own outcome.
                  void saveDraft();
                }}
              >
                {submitting ? "Saving…" : "Save changes"}
              </button>
            ) : (
              <>
                <button className="primary" type="submit" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit proposal"}
                </button>
                {/*
                  A draft needs an owner, so this control exists only for a signed-in applicant.
                  Offering it to everybody and refusing on press would be a button that lies.
                */}
                {signedIn ? (
                  <button
                    type="button"
                    className="pub-button"
                    disabled={submitting}
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await; saveDraft renders its own outcome.
                      void saveDraft();
                    }}
                  >
                    Save draft
                  </button>
                ) : null}
              </>
            )}
          </div>
        </form>
      ) : status === "unknown" ? null : (
        <p className="pub-notice" role="status">
          {status === "scheduled"
            ? "This call is not open for submissions yet. The form appears here when it opens."
            : "This call is closed and is no longer accepting submissions."}
        </p>
      )}
      {/*
        One element, always mounted, whose class and text change — the pattern `ui/primitives.tsx`
        documents, for the reason it gives there: a live region swapped in at the moment its first
        message arrives is commonly missed by assistive technology, and this notice is now the only
        spoken outcome of five different actions.
      */}
      <p
        className={
          notice ? (notice.tone === "error" ? "pub-notice is-error" : "pub-notice") : "pub-sr"
        }
        role={notice?.tone === "error" ? "alert" : "status"}
        aria-live={notice?.tone === "error" ? undefined : "polite"}
      >
        {/*
          No blanket prefix. This served one action — an anonymous submission — when it took a
          "Not submitted — " prefix, and now serves five, where the prefix was at best irrelevant
          and at worst self-contradicting: "Not submitted — This proposal has already been
          submitted." `report` names the action in the message instead.
        */}
        {notice?.text ?? ""}
      </p>
    </article>
  );
}
