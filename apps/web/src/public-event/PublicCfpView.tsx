import { cfpConditionMatches } from "@greenroom/contracts";
import { type FormEvent, useState } from "react";
import { CfpApiError, type CfpFormDto, submitProposal } from "../api/cfp";
import { Pill } from "./cards";

type CfpStatus = "open" | "closed" | "unknown";

/** Owns the public proposal form's answers, validation, and idempotent submission lifecycle. */
export function PublicCfpView({
  eventId,
  liveCfp,
  unavailable,
  status,
  statusLine,
  title,
  description,
}: {
  eventId: string;
  liveCfp: CfpFormDto | null;
  unavailable: string | null;
  status: CfpStatus;
  statusLine: string;
  title: string;
  description: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    setFieldErrors({});
    try {
      const confirmation = await submitProposal(eventId, answers, submissionKey);
      setNotice({
        tone: "ok",
        text: `Proposal received. Confirmation: ${confirmation.confirmationId}`,
      });
      setSubmissionKey(crypto.randomUUID());
      setAnswers({});
    } catch (reason) {
      // ERROR-INTENT: the public form renders submission failures next to the fields.
      if (reason instanceof CfpApiError) setFieldErrors(reason.envelope.error.fieldErrors ?? {});
      setNotice({
        tone: "error",
        text:
          reason instanceof CfpApiError ? reason.message : "The proposal could not be submitted.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="pub-detail">
      <div className="pub-head">
        <p className="kicker">Call for proposals</p>
        <h1>{title}</h1>
        <p className="pub-tz">
          {status === "unknown" ? null : (
            <Pill tone={status === "open" ? "ok" : "neutral"}>
              {status === "open" ? "Open" : "Closed"}
            </Pill>
          )}
          {statusLine}
        </p>
      </div>
      <p className="lede">{description}</p>
      {unavailable ? (
        <p className="pub-notice is-error" role="alert">
          {unavailable}
        </p>
      ) : null}
      {liveCfp?.status === "open" ? (
        <form className="pub-form" onSubmit={submit}>
          {liveCfp.fields
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
                    for (const candidate of liveCfp.fields)
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
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? "Submitting…" : "Submit proposal"}
          </button>
        </form>
      ) : null}
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
