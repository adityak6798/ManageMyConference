/*
 * Call for proposals composer.
 *
 * This is the public front door of the product: whatever is published here is the
 * form applicants actually fill in, so the surface is built around the two ways it
 * used to mislead the organizer.
 *
 * 1. "Draft saved." rendered roughly 750px below the button that caused it and was
 *    never announced. Every outcome now goes through useActionFeedback(), which
 *    keeps the confirmation beside the toolbar and inside a live region.
 * 2. Saving an edit to a published form forks the draft away from the snapshot the
 *    public is still submitting against — the API keeps serving the old published
 *    version until the organizer publishes again. That divergence used to be
 *    invisible, so the composer shows the live published form next to the draft and
 *    states, in words, which one applicants can see.
 */

import { type CfpChoice, type CfpField, type CfpRoutingRule } from "@greenroom/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CfpApiError,
  type CfpFormDto,
  changeCfpState,
  loadCfp,
  loadCfpRoutingStatuses,
  saveCfp,
  saveCfpWindow,
} from "../api/cfp";
import "../styles/cfp.css";
import { IconCheck, IconForm, IconGlobe, IconLink, IconPlus, IconWarning } from "../ui/icons";
import { Card, Drawer, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "../ui/primitives";
import { ApplicantCfpForm } from "./ApplicantCfpForm";
import { PublicFormPreview } from "./controls";
import {
  DECISION_STATUSES,
  DEFAULT_TITLE,
  describe,
  FIELD_TYPES,
  formatDate,
  fromZonedInput,
  zonedInputExists,
  isNotFound,
  loadPublicSubmissionUrl,
  shape,
  starter,
  toZonedInput,
  typeLabel,
} from "./model";

function ChoiceListEditor({
  fieldId,
  options,
  choices,
  onChange,
}: {
  fieldId: string;
  options?: string[];
  choices?: CfpChoice[];
  onChange: (change: { options: string[]; choices?: CfpChoice[] }) => void;
}) {
  const stable = choices !== undefined;
  const visible = stable ? choices.filter(({ active }) => active) : (options ?? []);
  return (
    <div className="cfp-choice-editor" id={`editor-options-${fieldId}`}>
      {visible.map((choice, index) => {
        const label = typeof choice === "string" ? choice : choice.label;
        const stableId = typeof choice === "string" ? null : choice.id;
        return (
          <div className="cfp-choice-row" key={stableId ?? `${fieldId}-${index}`}>
            <span className="cfp-choice-marker" aria-hidden="true" />
            <label className="visually-hidden" htmlFor={`editor-option-${fieldId}-${index}`}>
              Option {index + 1}
            </label>
            <input
              id={`editor-option-${fieldId}-${index}`}
              value={label}
              placeholder={`Option ${index + 1}`}
              maxLength={120}
              onChange={(event) => {
                if (stable) {
                  onChange({
                    options: [],
                    choices: choices.map((item) =>
                      item.id === stableId ? { ...item, label: event.target.value } : item,
                    ),
                  });
                } else {
                  onChange({
                    options: (options ?? []).map((item, itemIndex) =>
                      itemIndex === index ? event.target.value : item,
                    ),
                  });
                }
              }}
            />
            <button
              type="button"
              className="ghost small cfp-choice-remove"
              aria-label={`Remove option ${index + 1}`}
              disabled={visible.length === 1}
              onClick={() => {
                if (stable) {
                  onChange({
                    options: [],
                    choices: choices.map((item) =>
                      item.id === stableId ? { ...item, active: false } : item,
                    ),
                  });
                } else {
                  onChange({
                    options: (options ?? []).filter((_, itemIndex) => itemIndex !== index),
                  });
                }
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="secondary small cfp-choice-add"
        disabled={visible.length >= 30}
        onClick={() => {
          if (stable) {
            onChange({
              options: [],
              choices: [
                ...choices,
                {
                  id: `choice-${crypto.randomUUID()}`,
                  label: `Option ${visible.length + 1}`,
                  active: true,
                },
              ],
            });
          } else {
            onChange({ options: [...(options ?? []), `Option ${visible.length + 1}`] });
          }
        }}
      >
        <IconPlus size={14} /> Add option
      </button>
      <p className="hint">Options appear in this order on the public form.</p>
    </div>
  );
}
// This state-owning composer intentionally exceeds 400 lines. Its draft ordering, selected field,
// preview, publication transition, and applicant answers are one lifecycle; the remaining long
// sections are single-use render branches, which issue #70 explicitly says not to extract merely
// for size. Reused controls and pure model operations live in controls.tsx and model.ts.
export function CfpWorkspace({
  eventId,
  organizer,
  /**
   * The event's IANA zone. Every deadline in this composer is entered and shown in it — never in
   * the operator's own, which is what an unconverted `datetime-local` would silently mean.
   */
  timezone,
}: {
  eventId: string;
  organizer: boolean;
  timezone: string;
}) {
  const [form, setForm] = useState<CfpFormDto | null>(null);
  const [fields, setFields] = useState<CfpField[]>(starter);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [description, setDescription] = useState("");
  const [addingQuestion, setAddingQuestion] = useState(false);
  const [questionTypeSearch, setQuestionTypeSearch] = useState("");
  const [routing, setRouting] = useState<CfpRoutingRule[]>([]);
  const [routingStatuses, setRoutingStatuses] = useState<readonly { key: string; label: string }[]>(
    [],
  );
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [loadingCfp, setLoadingCfp] = useState(true);
  const [draftConflict, setDraftConflict] = useState(false);

  const [published, setPublished] = useState<CfpFormDto | null>(null);
  const [liveProblem, setLiveProblem] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [routingStatusProblem, setRoutingStatusProblem] = useState(false);
  const [routingStatusReload, setRoutingStatusReload] = useState(0);

  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<"save" | "publish" | "state" | "window" | null>(null);
  // Wall-clock strings in the event's zone, which is what a `datetime-local` input speaks.
  const [opensAtInput, setOpensAtInput] = useState("");
  const [closesAtInput, setClosesAtInput] = useState("");
  const [previewTab, setPreviewTab] = useState("draft");

  const feedback = useActionFeedback();
  const { announce } = feedback;

  // Both loaders are re-runnable by hand (Try again, and after a publish), so each
  // stamps a generation and drops its own result if a newer run started meanwhile.
  const formRun = useRef(0);
  const liveRun = useRef(0);

  const loadForm = useCallback(
    async (preserveCurrent = false) => {
      const run = ++formRun.current;
      if (!preserveCurrent) {
        setForm(null);
        setFields(starter);
        setTitle(DEFAULT_TITLE);
        setDescription("");
        setRouting([]);
        setBaseline(null);
      }
      setErrors({});
      setLoadFailure(null);
      setLoadingCfp(true);
      setDraftConflict(false);
      try {
        const loaded = await loadCfp(eventId, organizer);
        if (formRun.current !== run) return;
        setForm(loaded);
        setTitle(loaded.title);
        setDescription(loaded.description);
        setFields([...loaded.fields]);
        setRouting([...loaded.routing]);
        setBaseline(shape(loaded));
      } catch (reason: unknown) {
        if (formRun.current !== run) return;
        // ERROR-INTENT: a missing CFP is the empty state, not a failure, so a NOT_FOUND is
        // deliberately swallowed and the organizer starts from the starter template. Every
        // other reason is reported through setLoadFailure and blocks editing — falling back
        // to the starter would let Save overwrite a form we failed to read.
        if (isNotFound(reason))
          setBaseline(shape({ title: DEFAULT_TITLE, description: "", fields: starter }));
        else if (preserveCurrent) setDraftConflict(true);
        else setLoadFailure(describe(reason, "The call for proposals could not be loaded."));
      } finally {
        if (formRun.current === run) setLoadingCfp(false);
      }
    },
    [eventId, organizer],
  );

  // The published snapshot is fetched through the public endpoint on purpose: it is
  // the same bytes an applicant receives, which is what makes the Live tab evidence
  // rather than a second opinion.
  const refreshLive = useCallback(async () => {
    if (!organizer) return;
    const run = ++liveRun.current;
    setLiveProblem(null);
    try {
      const live = await loadCfp(eventId, false);
      if (liveRun.current === run) setPublished(live);
    } catch (reason: unknown) {
      if (liveRun.current !== run) return;
      setPublished(null);
      // ERROR-INTENT: an unpublished CFP legitimately 404s and the Live tab renders
      // that as its empty state; every other reason is reported to the organizer.
      if (!isNotFound(reason))
        setLiveProblem(describe(reason, "The live public form could not be loaded."));
    }
  }, [eventId, organizer]);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; loadForm renders both of its outcomes.
    void loadForm();
    return () => {
      formRun.current += 1;
    };
  }, [loadForm]);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; refreshLive renders both of its outcomes.
    void refreshLive();
    return () => {
      liveRun.current += 1;
    };
  }, [refreshLive]);

  useEffect(() => {
    // ERROR-INTENT: reading the retry counter makes each increment restart this status request.
    void routingStatusReload;
    if (!organizer) return;
    let current = true;
    // ERROR-INTENT: routing status load failure is reported when a rule is added; the rest of
    // the CFP editor remains usable and the server still rejects an unconfigured destination.
    void loadCfpRoutingStatuses(eventId)
      .then((statuses) => {
        if (current) {
          setRoutingStatuses(statuses);
          setRoutingStatusProblem(false);
        }
      })
      .catch(() => {
        if (current) setRoutingStatusProblem(true);
      });
    return () => {
      current = false;
    };
  }, [eventId, organizer, routingStatusReload]);

  useEffect(() => {
    if (!organizer) return;
    let current = true;
    // ERROR-INTENT: loadPublicSubmissionUrl already degrades to null, which the
    // toolbar renders as a disabled Copy action with an explanation.
    void loadPublicSubmissionUrl(eventId).then((url) => {
      if (current) setPublicUrl(url);
    });
    return () => {
      current = false;
    };
  }, [eventId, organizer]);

  /*
   * The window inputs follow the server's answer rather than being edited free of it.
   *
   * Unlike the form's questions there is no "unsaved window" state to protect: the window is live
   * state with one control, so whatever the API last returned is what the call actually has, and
   * showing anything else would be the composer disagreeing with the public page.
   */
  useEffect(() => {
    setOpensAtInput(toZonedInput(form?.opensAt ?? null, timezone));
    setClosesAtInput(toZonedInput(form?.closesAt ?? null, timezone));
  }, [form?.opensAt, form?.closesAt, timezone]);

  const draftShape = useMemo(
    () => shape({ title, description, fields, routing }),
    [title, description, fields, routing],
  );
  const publishedShape = useMemo(() => (published ? shape(published) : null), [published]);

  const dirty = baseline !== null && baseline !== draftShape;
  const liveStatus = form?.publishedStatus ?? null;
  /*
   * What applicants are actually in, which is not `liveStatus` once a window exists.
   *
   * The server computes it — a composer that decided from the operator's own clock would report
   * an open call minutes after the deadline it published. `liveStatus` still decides what the
   * close/reopen control does, because that control changes the organizer's half of the answer.
   */
  const effective = form?.effectiveStatus ?? liveStatus ?? "unpublished";
  /*
   * The destinations a routing rule may actually name.
   *
   * `accepted` and `declined` are configured on every event, so they are in `routingStatuses` — but
   * reaching one is the effect of a recorded decision, which is what creates the session and tells
   * the submitter. A rule assigning one told an applicant they had been accepted with nothing behind
   * it, so the API refuses it; offering it here would be a control that builds an unsaveable rule.
   */
  const routableStatuses = useMemo(
    () => routingStatuses.filter((status) => !DECISION_STATUSES.includes(status.key)),
    [routingStatuses],
  );
  /** So a rule holding a status this control no longer offers can still be named, not left blank. */
  const statusLabels = useMemo(
    () => new Map(routingStatuses.map(({ key, label }) => [key, label])),
    [routingStatuses],
  );
  const deadlinePassed = effective === "closed" && liveStatus === "open";
  const divergesFromLive = publishedShape !== null && publishedShape !== draftShape;
  const absoluteUrl = publicUrl ? new URL(publicUrl, window.location.origin).toString() : null;

  const updateField = useCallback(
    (id: string, patch: Partial<CfpField>) =>
      setFields((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      ),
    [],
  );

  const moveField = useCallback(
    (index: number, delta: number) =>
      setFields((current) => {
        const next = [...current];
        const [moved] = next.splice(index, 1);
        if (moved) next.splice(index + delta, 0, moved);
        return next;
      }),
    [],
  );

  const persist = useCallback(async () => {
    setErrors({});
    const conditionErrors: Record<string, string[]> = {};
    fields.forEach((field, index) => {
      if (
        field.visibleWhen &&
        field.visibleWhen.operator !== "notEmpty" &&
        !field.visibleWhen.values.some((value) => value.trim())
      )
        conditionErrors[`fields.${index}.visibleWhen.values`] = [
          `Choose the answer that shows ${field.label || `question ${index + 1}`}.`,
        ];
    });
    routing.forEach((rule, index) => {
      if (rule.when.operator !== "notEmpty" && !rule.when.values.some((value) => value.trim()))
        conditionErrors[`routing.${index}.when.values`] = [
          `Choose the answer for routing rule ${index + 1}.`,
        ];
    });
    if (Object.keys(conditionErrors).length) {
      setErrors(conditionErrors);
      announce("error", "Finish each conditional rule before saving the draft.");
      return null;
    }
    setBusy("save");
    try {
      const saved = await saveCfp(eventId, {
        title,
        description,
        fields,
        routing,
        expectedVersion: form?.version ?? 0,
      });
      setForm(saved);
      setDraftConflict(false);
      setBaseline(shape(saved));
      announce(
        "success",
        saved.publishedStatus
          ? "Draft saved. Applicants still see the published version until you publish."
          : "Draft saved.",
      );
      return saved;
    } catch (reason: unknown) {
      // ERROR-INTENT: the announcement and the per-question errors are the failure state.
      if (reason instanceof CfpApiError) {
        setErrors(reason.envelope.error.fieldErrors ?? {});
        if (reason.envelope.error.code === "CONFLICT") setDraftConflict(true);
      }
      announce("error", describe(reason, "The draft could not be saved."));
      return null;
    } finally {
      setBusy(null);
    }
  }, [announce, description, eventId, fields, form?.version, routing, title]);

  const persistWindow = useCallback(
    async (window: { opensAt: string | null; closesAt: string | null }) => {
      setBusy("window");
      try {
        const saved = await saveCfpWindow(eventId, window);
        /*
         * Everything below comes from the server's answer to this write, and nothing from the
         * timestamps that were sent (issue #222).
         *
         * A window save changes what applicants are in without changing the publication, so the
         * two things that describe the call — this composer's status line and the Live tab, which
         * is "the same bytes an applicant receives" — both have to move. `setForm` alone moved
         * only the first: saving a deadline already in the past left the Live tab, and every
         * warning derived from it, showing an open call until somebody reloaded the page. The
         * state transition below it has always refreshed for exactly this reason; the window
         * control had not.
         *
         * Both directions are covered by construction, because `effectiveStatus` is computed
         * server-side on each read: a deadline moved into the past closes the call and a deadline
         * moved back into the future reopens it, and neither is decided here.
         */
        setForm(saved);
        await refreshLive();
        announce(
          "success",
          /*
           * Phrased from the effective state the server just computed rather than from the
           * timestamps that were sent, so a deadline saved in the past is never announced as a
           * date applicants will "see on the public form" while the call is already shut.
           *
           * `closed` has two causes and they are not the same sentence. `cfpEffectiveState`
           * answers `closed` for a call the organizer closed by hand *before* it looks at the
           * deadline at all, so blaming the deadline for every closure told an organizer who had
           * closed the call and then scheduled an opening date that a deadline had passed — on
           * the surface this whole change exists to stop saying false things.
           *
           * Which cause it is comes from `publishedStatus`, the organizer's own half of the
           * answer, and **not** from comparing the deadline against this browser's clock. Two
           * reasons, and the second is the one that matters: a clock comparison is exactly the
           * recomputation issue #222 exists to remove, and it gets the *overlap* wrong — an
           * organizer may close a call whose deadline has already gone, and there the deadline is
           * both past and not the reason. The server has already decided; this only picks words.
           */
          saved.effectiveStatus === "closed"
            ? saved.publishedStatus === "closed"
              ? "Submission window saved. The call is closed to new submissions until you reopen it, so the window changes nothing for applicants yet."
              : "Submission window saved. That deadline has already passed, so the call is closed to new submissions."
            : saved.effectiveStatus === "scheduled"
              ? "Submission window saved. The call is not open yet and opens at the time you set."
              : // Nothing published means no applicant reaches the form at all, so promising them
                // a date on "the public form" was the same class of false sentence as blaming a
                // deadline for a manual closure — the window is stored and takes effect on publish.
                saved.effectiveStatus === "unpublished"
                ? "Submission window saved. Nothing is published yet, so applicants see none of it until you publish the form."
                : window.closesAt
                  ? "Submission window saved. Applicants see the deadline on the public form."
                  : window.opensAt
                    ? "Submission window saved. The call opens at the time you set."
                    : "Submission window cleared. The call is bounded only by the open and closed controls.",
        );
      } catch (reason: unknown) {
        // ERROR-INTENT: the announcement is the user-facing failure state for this control, and
        // it is the whole of it deliberately — nothing above ran, so the composer still shows the
        // window the call actually has rather than the one that was refused.
        announce("error", describe(reason, "The submission window could not be saved."));
      } finally {
        setBusy(null);
      }
    },
    [announce, eventId, refreshLive],
  );

  const transition = useCallback(
    async (state: "publish" | "close" | "reopen") => {
      setBusy(state === "publish" ? "publish" : "state");
      try {
        const saved = await changeCfpState(eventId, state);
        setForm(saved);
        await refreshLive();
        announce(
          "success",
          state === "publish"
            ? // Publishing a closed call keeps it closed — that is the whole point of the
              // fix that stopped a typo correction from reopening submissions. It is also
              // the surprising half, so it is the half the announcement says out loud;
              // "Applicants now see this version" alone reads as "the call is live again".
              // The control that would actually reopen it is named, because it exists.
              saved.publishedStatus === "closed"
              ? "Published. The call remains closed to new submissions — use Reopen live CFP when you want applicants back."
              : "Published. Applicants now see this version of the form."
            : state === "close"
              ? "The live call for proposals is closed to new submissions."
              : "The live call for proposals is open again.",
        );
      } catch (reason: unknown) {
        // ERROR-INTENT: the announcement is the user-facing transition failure state.
        announce("error", describe(reason, "The call for proposals state could not be changed."));
      } finally {
        setBusy(null);
      }
    },
    [announce, eventId, refreshLive],
  );

  /**
   * Publishing an edited form has to save first: the publish transition promotes the
   * *stored* draft, so publishing with unsaved edits would push the previous draft
   * live and leave the organizer certain they had shipped their change.
   */
  const publish = useCallback(async () => {
    if (dirty || !form) {
      const saved = await persist();
      if (!saved) return;
    }
    await transition("publish");
  }, [dirty, form, persist, transition]);

  const copyPublicLink = useCallback(async () => {
    if (!absoluteUrl) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      announce("success", "Public link copied to the clipboard.");
    } catch (reason: unknown) {
      // ERROR-INTENT: clipboard access is denied outside secure contexts; the URL is
      // printed beside the button so it stays selectable by hand.
      announce("error", describe(reason, `Copying was blocked. The link is ${absoluteUrl}`));
    }
  }, [absoluteUrl, announce]);

  if (loadingCfp)
    return (
      <Card>
        <div className="cfp-loading" aria-hidden="true">
          <div className="skeleton" style={{ height: 18, width: "38%" }} />
          <div className="skeleton" style={{ height: 92, width: "100%" }} />
          <div className="skeleton" style={{ height: 92, width: "100%" }} />
        </div>
        <p className="visually-hidden" role="status">
          Loading the call for proposals.
        </p>
      </Card>
    );

  if (loadFailure)
    return (
      <Card
        labelledBy="cfp-unavailable"
        title="The call for proposals could not be opened"
        actions={
          <button
            type="button"
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; loadForm renders both outcomes.
              void loadForm();
            }}
          >
            Try again
          </button>
        }
      >
        <Notice tone="error">{loadFailure}</Notice>
        <p className="cfp-recovery-hint">
          Editing stays disabled until the form loads, so retrying cannot overwrite questions this
          workspace never managed to read.
        </p>
      </Card>
    );

  if (!organizer && !form)
    return (
      <Card>
        <EmptyState title="This call for proposals is not available" icon={<IconForm size={20} />}>
          The organizer has not published a submission form for this event yet.
        </EmptyState>
      </Card>
    );

  if (!organizer && form) return <ApplicantCfpForm eventId={eventId} form={form} />;

  const generalFieldErrors = Object.entries(errors)
    .filter(([key]) => key === "fields" || key === "request")
    .flatMap(([, messages]) => messages);

  const liveStatusLine =
    liveStatus === "open"
      ? "Open for submissions."
      : liveStatus === "closed"
        ? "Submissions closed."
        : "Not published — applicants cannot reach this form yet.";

  return (
    <>
      <Card labelledBy="cfp-publication" title="Publication" tight>
        <div className="cfp-status">
          <div className="cfp-status-state">
            <div className="cfp-pills">
              {liveStatus === "open" ? (
                <Pill tone="ok">
                  <span className="dot" />
                  Published · open
                </Pill>
              ) : liveStatus === "closed" ? (
                <Pill tone="neutral">
                  <span className="dot" />
                  Published · closed
                </Pill>
              ) : (
                <Pill tone="warn">
                  <IconWarning size={12} />
                  Not published
                </Pill>
              )}
              {dirty ? (
                <Pill tone="warn">Unsaved edits</Pill>
              ) : divergesFromLive ? (
                <Pill tone="warn">Draft ahead of live</Pill>
              ) : liveStatus ? (
                <Pill tone="ok">
                  <IconCheck size={12} />
                  Live copy matches
                </Pill>
              ) : (
                <Pill tone="neutral">Draft</Pill>
              )}
            </div>
            <p className="cfp-status-meta">
              {form ? `Draft version ${form.version}` : "Never saved"}
              {form?.publishedAt ? ` · live since ${formatDate(form.publishedAt)}` : ""}
              {` · ${fields.length} question${fields.length === 1 ? "" : "s"}`}
            </p>
          </div>

          <div className="toolbar cfp-actions">
            <button
              type="button"
              className="secondary"
              disabled={!absoluteUrl}
              aria-describedby={absoluteUrl ? undefined : "cfp-link-hint"}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; copyPublicLink announces both outcomes.
                void copyPublicLink();
              }}
            >
              <IconLink size={15} />
              Copy public link
            </button>
            {/* Only offered once something is published — sending an organizer to a
                page that has no form yet reads as a broken link, not an empty state. */}
            {absoluteUrl && liveStatus ? (
              <a className="btn secondary" href={absoluteUrl} target="_blank" rel="noreferrer">
                <IconGlobe size={15} />
                Open public form
              </a>
            ) : null}
            {liveStatus ? (
              <button
                type="button"
                className="secondary"
                disabled={busy !== null}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; transition announces both outcomes.
                  void transition(liveStatus === "open" ? "close" : "reopen");
                }}
              >
                {liveStatus === "open" ? "Close live CFP" : "Reopen live CFP"}
              </button>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; persist announces both outcomes.
                void persist();
              }}
            >
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            {!form || dirty || form.status === "draft" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; publish announces both outcomes.
                  void publish();
                }}
              >
                {busy === "publish"
                  ? "Publishing…"
                  : liveStatus
                    ? "Publish changes"
                    : "Publish CFP"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="cfp-status-foot">
          {feedback.node}
          {draftConflict ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                // ERROR-INTENT: loadForm renders and announces its own recovery outcome.
                void loadForm(true);
              }}
            >
              Reload latest draft
            </button>
          ) : null}
          {absoluteUrl ? (
            <p className="cfp-link">
              Public submission URL: <code>{absoluteUrl}</code>
            </p>
          ) : (
            <p className="cfp-link" id="cfp-link-hint">
              The public link appears once this event has a published page.
            </p>
          )}
        </div>
      </Card>

      {/*
        The scheduled window, and the precedence rule stated where the controls are.
        Live state, like open and closed: saving it takes effect at once and publishes no form
        edits. It is a separate card rather than a field of the composer for exactly that reason.
      */}
      <Card labelledBy="cfp-window" title="Submission window" tight>
        <p className="cfp-window-rule">
          Both gates have to allow a submission. The schedule cannot open a call you have closed,
          and <strong>Reopen live CFP</strong> cannot open one whose deadline has passed — move or
          clear the deadline to take submissions again. Times are {timezone}, the event&rsquo;s own
          timezone.
        </p>
        <div className="form-row cfp-window-controls">
          <div className="field">
            <label htmlFor="cfp-opens-at">Opens</label>
            <input
              id="cfp-opens-at"
              type="datetime-local"
              value={opensAtInput}
              onChange={(event) => setOpensAtInput(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cfp-closes-at">Deadline</label>
            <input
              id="cfp-closes-at"
              type="datetime-local"
              value={closesAtInput}
              onChange={(event) => setClosesAtInput(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={() => {
              /*
               * A wall time that does not exist is refused rather than shifted.
               *
               * On a spring-forward date the local clock jumps an hour, so a deadline typed inside
               * the gap — 02:30 where 02:00–02:59 never happens — converts to the instant *before*
               * it and the organizer's deadline silently moves an hour earlier. Saving it is worse
               * than refusing it, because the announced deadline is then a time nobody chose.
               */
              const missing = [
                ["Opens", opensAtInput] as const,
                ["Deadline", closesAtInput] as const,
              ].filter(([, value]) => !zonedInputExists(value, timezone));
              if (missing.length > 0) {
                announce(
                  "error",
                  `${missing.map(([label]) => label).join(" and ")} ${
                    missing.length > 1 ? "name times that do not" : "names a time that does not"
                  } exist in ${timezone}: the clock skips that hour when daylight saving begins. Choose a time before or after it.`,
                );
                return;
              }
              // ERROR-INTENT: handlers cannot await; persistWindow announces both outcomes.
              void persistWindow({
                opensAt: fromZonedInput(opensAtInput, timezone),
                closesAt: fromZonedInput(closesAtInput, timezone),
              });
            }}
          >
            {busy === "window" ? "Saving…" : "Save window"}
          </button>
          {form?.opensAt || form?.closesAt ? (
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; persistWindow announces both outcomes.
                void persistWindow({ opensAt: null, closesAt: null });
              }}
            >
              Clear window
            </button>
          ) : null}
        </div>
        {/*
          The one sentence that is not derivable from the two inputs: what applicants get right
          now. Taken from the server's own answer, because a composer that decided from the
          operator's clock would report an open call minutes after the deadline it published.

          Not a live region. This workspace has exactly one — `useActionFeedback`'s, beside the
          toolbar — and saving the window announces through it; a second would mean a screen reader
          gets whichever of the two React updated last.
        */}
        <p className="cfp-window-state">
          {effective === "open"
            ? "Applicants can submit now."
            : effective === "scheduled"
              ? "Applicants see the opening date and no form."
              : effective === "closed"
                ? deadlinePassed
                  ? "The deadline has passed, so applicants cannot submit even though the call is marked open."
                  : "Applicants cannot submit."
                : "Nothing is published, so applicants cannot reach this form at all."}
        </p>
      </Card>

      {liveStatus && dirty ? (
        <Notice tone="warn">
          <IconWarning size={15} />
          <span>
            You are editing a form that is live. Applicants keep filling in the published version —
            these edits reach them only when you publish.
          </span>
        </Notice>
      ) : liveStatus && divergesFromLive ? (
        <Notice tone="warn">
          <IconWarning size={15} />
          <span>
            The saved draft is ahead of the live form. Compare them under <strong>Live form</strong>{" "}
            on the right, then publish to apply the change.
          </span>
        </Notice>
      ) : liveStatus ? (
        <Notice tone="info">
          <IconCheck size={15} />
          <span>
            This form is live. Saving an edit creates a new draft and never takes the public form
            offline — the published version keeps serving until you publish again.
          </span>
        </Notice>
      ) : (
        <Notice tone="info">
          <IconForm size={15} />
          <span>
            Nothing is published yet. Build the questions, then publish to open the public
            submission page.
          </span>
        </Notice>
      )}

      {liveProblem ? <Notice tone="error">{liveProblem}</Notice> : null}

      <div className="cfp-composer">
        <div className="cfp-pane">
          <Card labelledBy="cfp-details" title="Form details">
            <div className="cfp-details">
              <div className="field">
                <label htmlFor="cfp-title">Form title</label>
                <input
                  id="cfp-title"
                  value={title}
                  maxLength={120}
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? "cfp-title-error" : undefined}
                  onChange={(event) => setTitle(event.target.value)}
                />
                {errors.title ? (
                  <div id="cfp-title-error">
                    {errors.title.map((error) => (
                      <p className="error-text" key={error}>
                        {error}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="cfp-description">Description</label>
                <textarea
                  id="cfp-description"
                  value={description}
                  maxLength={2000}
                  aria-describedby="cfp-description-hint"
                  onChange={(event) => setDescription(event.target.value)}
                />
                <p className="hint" id="cfp-description-hint">
                  Shown above the questions on the public page.
                </p>
                {errors.description?.map((error) => (
                  <p className="error-text" key={error}>
                    {error}
                  </p>
                ))}
              </div>
            </div>
          </Card>

          <Card
            labelledBy="cfp-questions"
            title="Questions"
            hint="Applicants answer these in order."
            actions={
              <button type="button" className="secondary" onClick={() => setAddingQuestion(true)}>
                <IconPlus size={15} />
                Add question
              </button>
            }
            tight
          >
            {generalFieldErrors.length ? (
              <div className="cfp-general-errors">
                {generalFieldErrors.map((error) => (
                  <Notice tone="error" key={error}>
                    {error}
                  </Notice>
                ))}
              </div>
            ) : null}

            {fields.length === 0 ? (
              <EmptyState title="No questions yet" icon={<IconForm size={20} />}>
                Add at least one question before publishing the form.
              </EmptyState>
            ) : (
              <ol className="cfp-questions">
                {fields.map((field, index) => {
                  const name = field.label.trim() || "Untitled question";
                  const questionErrors = Object.entries(errors)
                    .filter(([key]) => key.startsWith(`fields.${index}.`))
                    .flatMap(([, messages]) => messages);
                  return (
                    <li className="cfp-question" key={field.id}>
                      <div className="cfp-question-head">
                        <span className="cfp-question-index">{index + 1}</span>
                        <span className="cfp-question-name">{name}</span>
                        <Pill tone="info">{typeLabel(field.type)}</Pill>
                        {field.required ? (
                          <Pill tone="warn">Required</Pill>
                        ) : (
                          <Pill tone="neutral">Optional</Pill>
                        )}
                      </div>

                      <div className="cfp-question-body">
                        <div className="field">
                          <label htmlFor={`editor-label-${field.id}`}>Question label</label>
                          <input
                            id={`editor-label-${field.id}`}
                            value={field.label}
                            maxLength={120}
                            onChange={(event) =>
                              updateField(field.id, {
                                label: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`editor-type-${field.id}`}>Field type</label>
                          <select
                            id={`editor-type-${field.id}`}
                            value={field.type}
                            onChange={(event) =>
                              updateField(field.id, {
                                type: event.target.value as CfpField["type"],
                                options:
                                  event.target.value === "select"
                                    ? field.options.length
                                      ? field.options
                                      : ["Option 1"]
                                    : [],
                              })
                            }
                          >
                            {FIELD_TYPES.map((entry) => (
                              <option key={entry.value} value={entry.value}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field cfp-span">
                          <label htmlFor={`editor-guidance-${field.id}`}>Guidance</label>
                          <input
                            id={`editor-guidance-${field.id}`}
                            value={field.guidance}
                            maxLength={500}
                            placeholder="Help text shown under the question"
                            onChange={(event) =>
                              updateField(field.id, {
                                guidance: event.target.value,
                              })
                            }
                          />
                        </div>
                        {field.type === "select" ? (
                          <div className="field cfp-span cfp-choice-field">
                            <span className="field-label">Answer options</span>
                            <ChoiceListEditor
                              fieldId={field.id}
                              options={field.options}
                              {...(field.id === "track" || field.id === "format"
                                ? {
                                    choices:
                                      field.choices ??
                                      field.options.map((label, optionIndex) => ({
                                        id: `${field.id}-${optionIndex + 1}`,
                                        label,
                                        active: true,
                                      })),
                                  }
                                : {})}
                              onChange={(change) => updateField(field.id, change)}
                            />
                          </div>
                        ) : null}
                        {index > 0 ? (
                          <div className="field cfp-span">
                            <label className="cfp-check" htmlFor={`editor-condition-${field.id}`}>
                              <input
                                id={`editor-condition-${field.id}`}
                                type="checkbox"
                                checked={Boolean(field.visibleWhen)}
                                onChange={(event) =>
                                  updateField(field.id, {
                                    visibleWhen: event.target.checked
                                      ? {
                                          fieldId: fields[index - 1]?.id ?? "",
                                          operator: "notEmpty",
                                          values: [],
                                        }
                                      : undefined,
                                  })
                                }
                              />
                              Show this question conditionally
                            </label>
                            {field.visibleWhen ? (
                              <div className="cfp-details">
                                <label>
                                  Earlier question
                                  <select
                                    value={field.visibleWhen.fieldId}
                                    onChange={(event) =>
                                      updateField(field.id, {
                                        visibleWhen: {
                                          ...(field.visibleWhen ?? {
                                            operator: "equals",
                                            values: [""],
                                            fieldId: "",
                                          }),
                                          fieldId: event.target.value,
                                        },
                                      })
                                    }
                                  >
                                    {fields.slice(0, index).map((candidate) => (
                                      <option key={candidate.id} value={candidate.id}>
                                        {candidate.label || candidate.id}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  Match
                                  <select
                                    value={field.visibleWhen.operator}
                                    onChange={(event) =>
                                      updateField(field.id, {
                                        visibleWhen: {
                                          ...(field.visibleWhen ?? {
                                            operator: "equals",
                                            values: [""],
                                            fieldId: "",
                                          }),
                                          operator: event.target.value as
                                            | "equals"
                                            | "in"
                                            | "notEmpty",
                                        },
                                      })
                                    }
                                  >
                                    <option value="equals">equals</option>
                                    <option value="in">is one of</option>
                                    <option value="notEmpty">is answered</option>
                                  </select>
                                </label>
                                {field.visibleWhen.operator !== "notEmpty" ? (
                                  <label>
                                    Value{field.visibleWhen.operator === "in" ? "s" : ""}
                                    <input
                                      value={field.visibleWhen.values.join(", ")}
                                      placeholder="Option, or comma-separated options"
                                      onChange={(event) =>
                                        updateField(field.id, {
                                          visibleWhen: {
                                            ...(field.visibleWhen ?? {
                                              operator: "equals",
                                              values: [""],
                                              fieldId: "",
                                            }),
                                            values: event.target.value
                                              .split(",")
                                              .map((value) => value.trim()),
                                          },
                                        })
                                      }
                                    />
                                  </label>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {questionErrors.map((error) => (
                        <p className="error-text cfp-question-error" key={error}>
                          {error}
                        </p>
                      ))}

                      <div className="cfp-question-foot">
                        <label className="cfp-check" htmlFor={`editor-required-${field.id}`}>
                          <input
                            id={`editor-required-${field.id}`}
                            type="checkbox"
                            checked={field.required}
                            onChange={(event) =>
                              updateField(field.id, {
                                required: event.target.checked,
                              })
                            }
                          />
                          Required
                        </label>
                        <div className="cfp-question-actions">
                          <button
                            type="button"
                            className="secondary small"
                            aria-label={`Move ${name} up`}
                            disabled={index === 0}
                            onClick={() => moveField(index, -1)}
                          >
                            Move up
                          </button>
                          <button
                            type="button"
                            className="secondary small"
                            aria-label={`Move ${name} down`}
                            disabled={index === fields.length - 1}
                            onClick={() => moveField(index, 1)}
                          >
                            Move down
                          </button>
                          <button
                            type="button"
                            className="ghost small cfp-remove"
                            aria-label={`Remove ${name}`}
                            disabled={fields.length === 1}
                            onClick={() => setFields(fields.filter((item) => item.id !== field.id))}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Drawer
            open={addingQuestion}
            title="Add a question"
            description="Choose one of the field types supported by the published form contract."
            onClose={() => {
              setAddingQuestion(false);
              setQuestionTypeSearch("");
            }}
          >
            <div className="field">
              <label htmlFor="question-type-search">Search question types</label>
              <input
                id="question-type-search"
                type="search"
                value={questionTypeSearch}
                onChange={(event) => setQuestionTypeSearch(event.target.value)}
              />
            </div>
            <ul className="cfp-field-type-list">
              {FIELD_TYPES.filter(({ label }) =>
                label.toLowerCase().includes(questionTypeSearch.trim().toLowerCase()),
              ).map(({ value, label }) => (
                <li key={value}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setFields([
                        ...fields,
                        {
                          id: `field-${crypto.randomUUID()}`,
                          type: value,
                          label: "New question",
                          guidance: "",
                          required: false,
                          options: value === "select" ? ["Option 1"] : [],
                        },
                      ]);
                      setAddingQuestion(false);
                      setQuestionTypeSearch("");
                    }}
                  >
                    <strong>{label}</strong>
                    <span>
                      {value === "select"
                        ? "Offer one choice from a list."
                        : `Collect ${label.toLowerCase()}.`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {FIELD_TYPES.every(
              ({ label }) => !label.toLowerCase().includes(questionTypeSearch.trim().toLowerCase()),
            ) ? (
              <EmptyState title="No supported type matches">Try a broader search.</EmptyState>
            ) : null}
          </Drawer>

          <Card
            labelledBy="cfp-routing"
            title="Submission routing"
            hint="The first matching rule sets the CFP triage status when a proposal is submitted."
            actions={
              <button
                type="button"
                className="secondary"
                disabled={!routableStatuses.length}
                onClick={() =>
                  setRouting([
                    ...routing,
                    {
                      id: `route-${crypto.randomUUID()}`,
                      when: { fieldId: fields[0]?.id ?? "", operator: "in", values: [] },
                      // Seeded from the *routable* set, not the configured one: seeding from a
                      // decision status would create a rule the API refuses and the select below
                      // cannot even display, since it is filtered out of the options.
                      routeTo: { status: routableStatuses[0]?.key ?? "" },
                    },
                  ])
                }
              >
                <IconPlus size={15} />
                Add routing rule
              </button>
            }
          >
            {routingStatusProblem ? (
              <p role="status" className="error-text">
                Routing destinations could not be loaded. Existing rules are unchanged.{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setRoutingStatusReload((value) => value + 1)}
                >
                  Try again
                </button>
              </p>
            ) : null}
            {routing.length ? (
              <ol className="cfp-questions">
                {routing.map((rule, index) => (
                  <li className="cfp-question" key={rule.id}>
                    <div className="cfp-question-body">
                      <label>
                        Question
                        <select
                          value={rule.when.fieldId}
                          onChange={(event) =>
                            setRouting((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? { ...item, when: { ...item.when, fieldId: event.target.value } }
                                  : item,
                              ),
                            )
                          }
                        >
                          {fields.map((field) => (
                            <option key={field.id} value={field.id}>
                              {field.label || field.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Match
                        <select
                          value={rule.when.operator}
                          onChange={(event) =>
                            setRouting((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      when: {
                                        ...item.when,
                                        operator: event.target.value as
                                          | "equals"
                                          | "in"
                                          | "notEmpty",
                                        values:
                                          event.target.value === "notEmpty"
                                            ? []
                                            : event.target.value === "equals"
                                              ? item.when.values.slice(0, 1)
                                              : item.when.values,
                                      },
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="equals">equals</option>
                          <option value="in">is one of</option>
                          <option value="notEmpty">is answered</option>
                        </select>
                      </label>
                      {rule.when.operator !== "notEmpty" ? (
                        <label>
                          Answer value{rule.when.operator === "in" ? "s" : ""}
                          <input
                            value={rule.when.values.join(", ")}
                            placeholder={
                              rule.when.operator === "in"
                                ? "Option, or comma-separated options"
                                : "Answer"
                            }
                            onChange={(event) =>
                              setRouting((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? {
                                        ...item,
                                        when: {
                                          ...item.when,
                                          values:
                                            item.when.operator === "in"
                                              ? event.target.value
                                                  .split(",")
                                                  .map((value) => value.trim())
                                              : [event.target.value.trim()],
                                        },
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                      ) : null}
                      <label>
                        Triage status
                        <select
                          value={rule.routeTo.status}
                          onChange={(event) =>
                            setRouting((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? { ...item, routeTo: { status: event.target.value } }
                                  : item,
                              ),
                            )
                          }
                        >
                          {/*
                            Accepted and Declined are configured on every event but are not
                            routable: reaching one is the effect of a recorded decision, which is
                            what creates the session and tells the submitter. Offering them here
                            let an organizer build a rule that told an applicant "Accepted" with
                            no decision behind it — the API refuses such a rule, and the control
                            should not propose one.
                          */}
                          {routableStatuses.map((status) => (
                            <option key={status.key} value={status.key}>
                              {status.label}
                            </option>
                          ))}
                          {/*
                            A form saved before that rule existed can still hold such a route, and
                            a `select` whose value matches no option renders *blank* — so the
                            organizer would see an empty control, an unexplained 400 on save, and
                            no way to tell which of their rules was the problem. The stored value
                            is shown, named as no longer allowed, and cannot be chosen again.

                            The `length === 0` branch is not defensive noise. `routingStatuses`
                            starts empty and is filled asynchronously, and stays empty for good if
                            that read fails — so a single branch here labelled *every* rule as no
                            longer routable, including perfectly valid ones, in a select holding
                            nothing else to choose. Not knowing which statuses exist is not the
                            same as knowing this one is gone, so that case renders the stored value
                            plainly: the control says what the rule says and saves unchanged.
                          */}
                          {routableStatuses.some(
                            ({ key }) => key === rule.routeTo.status,
                          ) ? null : routingStatuses.length === 0 ? (
                            <option value={rule.routeTo.status}>{rule.routeTo.status}</option>
                          ) : (
                            <option value={rule.routeTo.status} disabled>
                              {statusLabels.get(rule.routeTo.status) ?? rule.routeTo.status} — no
                              longer a routing destination, choose another or remove this rule
                            </option>
                          )}
                        </select>
                      </label>
                    </div>
                    {Object.entries(errors)
                      .filter(([key]) => key.startsWith(`routing.${index}.`))
                      .flatMap(([, messages]) => messages)
                      .map((error) => (
                        <p className="error-text cfp-question-error" key={error}>
                          {error}
                        </p>
                      ))}
                    <button
                      type="button"
                      className="ghost small cfp-remove"
                      aria-label={`Remove routing rule ${index + 1}`}
                      onClick={() =>
                        setRouting((current) => current.filter(({ id }) => id !== rule.id))
                      }
                    >
                      Remove rule
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">No automatic routing. New proposals use the Submitted status.</p>
            )}
          </Card>
        </div>

        <div className="cfp-pane cfp-pane-preview">
          <Card labelledBy="cfp-preview-heading" title="Public form" tight>
            <div className="cfp-preview-tabs">
              <Tabs
                label="Which version of the public form to show"
                active={previewTab}
                onSelect={setPreviewTab}
                items={[
                  { id: "draft", label: "Draft preview" },
                  { id: "live", label: "Live form" },
                ]}
              />
            </div>
            <div
              role="tabpanel"
              id={`panel-${previewTab}`}
              aria-labelledby={`tab-${previewTab}`}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tabpanel must be keyboard reachable.
              tabIndex={0}
              className="cfp-preview-panel"
            >
              {previewTab === "draft" ? (
                <PublicFormPreview
                  idPrefix="preview-draft"
                  title={title}
                  description={description}
                  fields={fields}
                  statusLine={
                    dirty || divergesFromLive
                      ? "Not live yet — this is what publishing would produce."
                      : liveStatusLine
                  }
                />
              ) : published ? (
                <PublicFormPreview
                  idPrefix="preview-live"
                  title={published.title}
                  description={published.description}
                  fields={published.fields}
                  statusLine={`${liveStatusLine} This is exactly what applicants see right now.`}
                />
              ) : (
                <EmptyState title="Nothing published yet" icon={<IconGlobe size={20} />}>
                  Publish the form and this tab shows the snapshot applicants are served, so you can
                  compare it with the draft before changing anything.
                </EmptyState>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
