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

import { type CfpField, publicationPreviewResponseSchema } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CfpApiError,
  type CfpFormDto,
  changeCfpState,
  loadCfp,
  saveCfp,
  submitProposal,
} from "./api/cfp";
import "./styles/cfp.css";
import {
  IconCheck,
  IconForm,
  IconGlobe,
  IconGrip,
  IconLink,
  IconPlus,
  IconWarning,
} from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "./ui/primitives";

const DEFAULT_TITLE = "Call for proposals";

const starter: CfpField[] = [
  {
    id: "title",
    type: "short_text",
    label: "Proposal title",
    guidance: "A clear, specific title",
    required: true,
    options: [],
  },
];

const FIELD_TYPES: { value: CfpField["type"]; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "select", label: "Single select" },
];

const typeLabel = (type: CfpField["type"]) =>
  FIELD_TYPES.find((entry) => entry.value === type)?.label ?? type;

type FormShape = { title: string; description: string; fields: readonly CfpField[] };

/**
 * Canonical form of the editable document. Comparing two of these is how the
 * composer knows whether the editor is ahead of the saved draft, and whether the
 * saved draft is ahead of the snapshot the public is being served.
 */
function shape(input: FormShape): string {
  return JSON.stringify({
    title: input.title.trim(),
    description: input.description.trim(),
    fields: input.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label.trim(),
      guidance: field.guidance.trim(),
      required: field.required,
      options: field.options.map((option) => option.trim()),
    })),
  });
}

/**
 * Zod throws when the API sends a payload the contract does not describe. That used
 * to collapse into "Something went wrong", which tells nobody which field broke, so
 * the offending path is surfaced instead. Detected structurally to keep zod out of
 * the web app's runtime dependencies.
 */
function schemaIssue(reason: unknown): string | null {
  if (!(reason instanceof Error) || reason.name !== "ZodError") return null;
  const { issues } = reason as { issues?: { path?: PropertyKey[]; message?: string }[] };
  const first = issues?.[0];
  if (!first) return "the response did not match the published contract";
  const path = (first.path ?? []).join(".") || "response body";
  return `${path} — ${first.message ?? "unexpected value"}`;
}

function describe(reason: unknown, fallback: string): string {
  if (reason instanceof CfpApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  const issue = schemaIssue(reason);
  if (issue)
    return `The server sent a call for proposals this app could not read (${issue}). Nothing was changed.`;
  if (reason instanceof Error && reason.message) return `${fallback} (${reason.message})`;
  return fallback;
}

const isNotFound = (reason: unknown) =>
  reason instanceof CfpApiError && reason.envelope.error.code === "NOT_FOUND";

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The organizer-only publication preview is the only place the public slug lives. */
async function loadPublicSubmissionUrl(eventId: string): Promise<string | null> {
  const response = await fetch(`/api/publishing/events/${eventId}/preview`);
  // ERROR-INTENT: the public link is an accelerator, not the workspace. A missing or
  // unreadable publication degrades to a disabled Copy action with an explanation.
  if (!response.ok) return null;
  const parsed = publicationPreviewResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.publication.draft.cfp.submissionUrl : null;
}

/**
 * One renderer for every rendition of a question, so the preview cannot drift from
 * the control an applicant actually types into.
 */
function FieldControl({
  field,
  idPrefix,
  value,
  errors,
  onChange,
}: {
  field: CfpField;
  idPrefix: string;
  value: string;
  errors: string[];
  onChange?: (next: string) => void;
}) {
  const controlId = `${idPrefix}-${field.id}`;
  const errorId = `${controlId}-error`;
  const guidanceId = `${controlId}-guidance`;
  const describedBy =
    [field.guidance ? guidanceId : null, errors.length ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const shared = {
    id: controlId,
    required: field.required,
    "aria-invalid": errors.length > 0,
    "aria-describedby": describedBy,
    value,
    onChange: (event: { target: { value: string } }) => onChange?.(event.target.value),
  };

  return (
    <div className="cfp-answer">
      <label htmlFor={controlId}>
        {field.label || "Untitled question"}
        {field.required ? <span className="cfp-required-mark"> *</span> : null}
      </label>
      {field.guidance ? (
        <p className="cfp-answer-guidance" id={guidanceId}>
          {field.guidance}
        </p>
      ) : null}
      {field.type === "long_text" ? (
        <textarea {...shared} />
      ) : field.type === "select" ? (
        <select {...shared}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input {...shared} type={field.type === "email" ? "email" : "text"} />
      )}
      {errors.map((error) => (
        <p className="error-text" id={errorId} key={error}>
          {error}
        </p>
      ))}
    </div>
  );
}

/**
 * The right-hand pane. It is deliberately built from the tokens the public event
 * pages use — `public-state` swaps the neutral ramp to warm paper — so the organizer
 * is looking at the real thing rather than a console-flavoured mock.
 */
function PublicFormPreview({
  idPrefix,
  title,
  description,
  fields,
  statusLine,
}: {
  idPrefix: string;
  title: string;
  description: string;
  fields: readonly CfpField[];
  statusLine: string;
}) {
  return (
    <div className="cfp-preview public-state">
      <p className="cfp-preview-kicker">Call for proposals</p>
      <p className="cfp-preview-title">{title.trim() || "Untitled call for proposals"}</p>
      {description.trim() ? <p className="cfp-preview-lede">{description}</p> : null}
      <p className="cfp-preview-status">{statusLine}</p>
      {/* A disabled fieldset keeps the preview out of the tab order and off the
          submit path, so nobody can type into a form that goes nowhere. */}
      <fieldset className="cfp-preview-form" disabled>
        <legend className="visually-hidden">Preview only — these controls do not submit</legend>
        {fields.map((field) => (
          <FieldControl key={field.id} field={field} idPrefix={idPrefix} value="" errors={[]} />
        ))}
        <span className="cfp-preview-submit">Submit proposal</span>
      </fieldset>
    </div>
  );
}

export function CfpWorkspace({ eventId, organizer }: { eventId: string; organizer: boolean }) {
  const [form, setForm] = useState<CfpFormDto | null>(null);
  const [fields, setFields] = useState<CfpField[]>(starter);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [description, setDescription] = useState("");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [loadingCfp, setLoadingCfp] = useState(true);

  const [published, setPublished] = useState<CfpFormDto | null>(null);
  const [liveProblem, setLiveProblem] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | "state" | null>(null);
  const [previewTab, setPreviewTab] = useState("draft");
  const [notice, setNotice] = useState("");

  const feedback = useActionFeedback();
  const { announce } = feedback;

  // Both loaders are re-runnable by hand (Try again, and after a publish), so each
  // stamps a generation and drops its own result if a newer run started meanwhile.
  const formRun = useRef(0);
  const liveRun = useRef(0);

  const loadForm = useCallback(async () => {
    const run = ++formRun.current;
    setForm(null);
    setFields(starter);
    setTitle(DEFAULT_TITLE);
    setDescription("");
    setBaseline(null);
    setAnswers({});
    setErrors({});
    setNotice("");
    setLoadFailure(null);
    setSubmissionKey(crypto.randomUUID());
    setLoadingCfp(true);
    try {
      const loaded = await loadCfp(eventId, organizer);
      if (formRun.current !== run) return;
      setForm(loaded);
      setTitle(loaded.title);
      setDescription(loaded.description);
      setFields([...loaded.fields]);
      setBaseline(shape(loaded));
    } catch (reason: unknown) {
      if (formRun.current !== run) return;
      // ERROR-INTENT: a missing CFP is the empty state, not a failure, so a NOT_FOUND is
      // deliberately swallowed and the organizer starts from the starter template. Every
      // other reason is reported through setLoadFailure and blocks editing — falling back
      // to the starter would let Save overwrite a form we failed to read.
      if (isNotFound(reason))
        setBaseline(shape({ title: DEFAULT_TITLE, description: "", fields: starter }));
      else setLoadFailure(describe(reason, "The call for proposals could not be loaded."));
    } finally {
      if (formRun.current === run) setLoadingCfp(false);
    }
  }, [eventId, organizer]);

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

  const draftShape = useMemo(
    () => shape({ title, description, fields }),
    [title, description, fields],
  );
  const publishedShape = useMemo(() => (published ? shape(published) : null), [published]);

  const dirty = baseline !== null && baseline !== draftShape;
  const liveStatus = form?.publishedStatus ?? null;
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
    setBusy("save");
    try {
      const saved = await saveCfp(eventId, { title, description, fields });
      setForm(saved);
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
      if (reason instanceof CfpApiError) setErrors(reason.envelope.error.fieldErrors ?? {});
      announce("error", describe(reason, "The draft could not be saved."));
      return null;
    } finally {
      setBusy(null);
    }
  }, [announce, description, eventId, fields, title]);

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
            ? "Published. Applicants now see this version of the form."
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      const result = await submitProposal(eventId, answers, submissionKey);
      setNotice(`Proposal received. Confirmation: ${result.confirmationId}`);
      setSubmissionKey(crypto.randomUUID());
    } catch (reason: unknown) {
      // ERROR-INTENT: field errors and the notice render the submission failure.
      if (reason instanceof CfpApiError) setErrors(reason.envelope.error.fieldErrors ?? {});
      setNotice(describe(reason, "The proposal could not be submitted."));
    } finally {
      setSubmitting(false);
    }
  };

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

  if (!organizer)
    return (
      <Card
        labelledBy="cfp-public-title"
        title={form?.title ?? DEFAULT_TITLE}
        hint={form?.description || undefined}
        actions={
          form?.status === "open" ? (
            <Pill tone="ok">Open for submissions</Pill>
          ) : (
            <Pill tone="neutral">Closed</Pill>
          )
        }
      >
        {form?.status === "open" ? (
          <form onSubmit={submit} className="cfp-public-form">
            {(form?.fields ?? []).map((field) => (
              <FieldControl
                key={field.id}
                field={field}
                idPrefix="answer"
                value={answers[field.id] ?? ""}
                errors={errors[`answers.${field.id}`] ?? []}
                onChange={(next) => setAnswers({ ...answers, [field.id]: next })}
              />
            ))}
            <div className="cfp-public-actions">
              <button type="submit" disabled={submitting}>
                {submitting ? "Submitting…" : "Submit proposal"}
              </button>
              {notice ? <p role="status">{notice}</p> : null}
            </div>
          </form>
        ) : (
          <EmptyState title="Submissions are closed" icon={<IconForm size={20} />}>
            This event is no longer accepting proposals.
          </EmptyState>
        )}
      </Card>
    );

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
                {errors.title?.map((error) => (
                  <p className="error-text" id="cfp-title-error" key={error}>
                    {error}
                  </p>
                ))}
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
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setFields([
                    ...fields,
                    {
                      id: `field-${crypto.randomUUID()}`,
                      type: "long_text",
                      label: "New question",
                      guidance: "",
                      required: false,
                      options: [],
                    },
                  ])
                }
              >
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
                        <span className="cfp-grip" aria-hidden="true">
                          <IconGrip size={14} />
                        </span>
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
                              updateField(field.id, { label: event.target.value })
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
                                options: event.target.value === "select" ? field.options : [],
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
                              updateField(field.id, { guidance: event.target.value })
                            }
                          />
                        </div>
                        {field.type === "select" ? (
                          <div className="field cfp-span">
                            <label htmlFor={`editor-options-${field.id}`}>
                              Options (comma separated)
                            </label>
                            <input
                              id={`editor-options-${field.id}`}
                              value={field.options.join(", ")}
                              aria-describedby={`editor-options-hint-${field.id}`}
                              onChange={(event) =>
                                updateField(field.id, {
                                  options: event.target.value
                                    .split(",")
                                    .map((option) => option.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                            <p className="hint" id={`editor-options-hint-${field.id}`}>
                              A select question needs at least one option.
                            </p>
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
                              updateField(field.id, { required: event.target.checked })
                            }
                          />
                          Required
                        </label>
                        <code className="cfp-code" title={`Answer key: ${field.id}`}>
                          {field.id}
                        </code>
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
