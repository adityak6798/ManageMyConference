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
import { type FormEvent, useCallback, useEffect, useState } from "react";
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
  startDemoSession,
  describeIdentityFailure,
} from "../api/identity";
import { Pill } from "./cards";
import { fullTime, zoneAbbreviation } from "./model";

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
  eventStartsOn,
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
  /** Used only to name the zone's abbreviation for the week the event runs. */
  eventStartsOn: string;
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

  const refreshProposals = useCallback(async () => {
    setProposals(await loadMyProposals(eventId));
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
        if (identity.session) await refreshProposals();
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

  /** Report a refusal beside the control that caused it, keeping any field errors it carried. */
  function report(reason: unknown, fallback: string) {
    // ERROR-INTENT: the public form renders submission failures next to the fields.
    if (reason instanceof CfpApiError) setFieldErrors(reason.envelope.error.fieldErrors ?? {});
    setNotice({
      tone: "error",
      text: reason instanceof CfpApiError ? reason.message : fallback,
    });
  }

  async function guarded(action: () => Promise<void>, fallback: string) {
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
   * Save without submitting.
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
      await refreshProposals();
      setNotice({ tone: "ok", text: "Saved. You can come back to this proposal any time." });
    }, "The draft could not be saved.");

  /**
   * Submit, as the signed-in owner.
   *
   * A proposal that was never saved is created and submitted in two calls rather than one, so that
   * every submitted proposal has the same shape on the dashboard however it got there — and so the
   * first call's idempotency key still converges if the second one is retried.
   */
  const submitOwned = () =>
    guarded(async () => {
      const target = editing ?? (await createProposalDraft(eventId, answers, submissionKey));
      const submitted = await submitOwnedProposal(eventId, target.id, answers, target.revision);
      setEditing(null);
      setAnswers({});
      setSubmissionKey(crypto.randomUUID());
      await refreshProposals();
      setNotice({
        tone: "ok",
        text: `Proposal submitted. Confirmation: ${submitted.id}`,
      });
    }, "The proposal could not be submitted.");

  const openForEditing = (proposal: SubmitterProposalDto) => {
    setEditing(proposal);
    setAnswers({ ...proposal.answers });
    setFieldErrors({});
    setNotice(null);
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

  const zone = zoneAbbreviation(timezone, eventStartsOn);
  const inZone = (instant: string) => `${fullTime(instant, timezone)}${zone ? ` ${zone}` : ""}`;
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
            {formOpen && editing ? (
              <button type="button" className="pub-button" onClick={startFresh}>
                Start another proposal
              </button>
            ) : null}
          </div>
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

      {formOpen && !signedIn ? (
        <section className="pub-signin" aria-labelledby="pub-cfp-signin">
          <h2 id="pub-cfp-signin">Keep track of your proposal</h2>
          <p className="pub-note">
            Sign in and your drafts, revisions and decision stay on this page. You can submit
            without an account, but an anonymous proposal cannot be edited or followed afterwards.
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
                      void guarded(async () => {
                        await startDemoSession(identity.persona);
                        window.location.reload();
                      }, "That demo identity could not be used.");
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
          {editing ? (
            <p className="pub-note" role="status">
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
          <div className="pub-form-actions">
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
          </div>
        </form>
      ) : status === "unknown" ? null : (
        <p className="pub-notice" role="status">
          {status === "scheduled"
            ? "This call is not open for submissions yet. The form appears here when it opens."
            : "This call is closed and is no longer accepting submissions."}
        </p>
      )}
      {notice ? (
        <p
          className={notice.tone === "error" ? "pub-notice is-error" : "pub-notice"}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.tone === "error" ? "Not submitted — " : ""}
          {notice.text}
        </p>
      ) : (
        <span className="pub-sr" role="status" aria-live="polite" />
      )}
    </article>
  );
}
