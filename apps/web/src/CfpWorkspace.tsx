import type { CfpField } from "@greenroom/contracts";
import { type FormEvent, useEffect, useState } from "react";
import {
  CfpApiError,
  changeCfpState,
  loadCfp,
  saveCfp,
  submitProposal,
  type CfpFormDto,
} from "./api/cfp";
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
const message = (reason: unknown) =>
  reason instanceof CfpApiError ? reason.message : "Something went wrong. Try again.";
export function CfpWorkspace({ eventId, organizer }: { eventId: string; organizer: boolean }) {
  const [form, setForm] = useState<CfpFormDto | null>(null);
  const [fields, setFields] = useState<CfpField[]>(starter);
  const [title, setTitle] = useState("Call for proposals");
  const [description, setDescription] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [loadingCfp, setLoadingCfp] = useState(true);
  useEffect(() => {
    let current = true;
    setForm(null);
    setFields(starter);
    setTitle("Call for proposals");
    setDescription("");
    setAnswers({});
    setSubmissionKey(crypto.randomUUID());
    setLoadingCfp(true);
    setNotice("");
    setErrors({});
    // ERROR-INTENT: React effects cannot await; the handlers render load failures.
    void loadCfp(eventId, organizer)
      .then((loaded) => {
        if (!current) return;
        setForm(loaded);
        setTitle(loaded.title);
        setDescription(loaded.description);
        setFields([...loaded.fields]);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        if (!(reason instanceof CfpApiError && reason.envelope.error.code === "NOT_FOUND"))
          setNotice(message(reason));
      })
      .finally(() => {
        if (current) setLoadingCfp(false);
      });
    return () => {
      current = false;
    };
  }, [eventId, organizer]);
  const persist = async () => {
    try {
      const saved = await saveCfp(eventId, { title, description, fields });
      setForm(saved);
      setNotice("Draft saved.");
    } catch (reason) {
      // ERROR-INTENT: The rendered notice is the user-facing save failure state.
      setNotice(message(reason));
    }
  };
  const transition = async (state: "publish" | "close" | "reopen") => {
    try {
      const saved = await changeCfpState(eventId, state);
      setForm(saved);
      setNotice(`CFP is ${saved.status}.`);
    } catch (reason) {
      // ERROR-INTENT: The rendered notice is the user-facing transition failure state.
      setNotice(message(reason));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      const result = await submitProposal(eventId, answers, submissionKey);
      setNotice(`Proposal received. Confirmation: ${result.confirmationId}`);
      setSubmissionKey(crypto.randomUUID());
    } catch (reason) {
      // ERROR-INTENT: Field errors and the notice render the submission failure.
      if (reason instanceof CfpApiError) setErrors(reason.envelope.error.fieldErrors ?? {});
      setNotice(message(reason));
    } finally {
      setSubmitting(false);
    }
  };
  const renderFields = (editable: boolean) =>
    fields.map((field, index) => (
      <div className="cfp-field" key={field.id}>
        <label htmlFor={`${editable ? "editor-label" : "answer"}-${field.id}`}>
          {field.label}
          {field.required ? " *" : ""}
        </label>
        {field.guidance && <small>{field.guidance}</small>}
        {editable ? (
          <>
            <label>
              Field type
              <select
                value={field.type}
                onChange={(event) =>
                  setFields(
                    fields.map((item) =>
                      item.id === field.id
                        ? {
                            ...item,
                            type: event.target.value as CfpField["type"],
                            options: event.target.value === "select" ? item.options : [],
                          }
                        : item,
                    ),
                  )
                }
              >
                <option value="short_text">Short text</option>
                <option value="long_text">Long text</option>
                <option value="email">Email</option>
                <option value="select">Select</option>
              </select>
            </label>
            <label>
              Question label
              <input
                id={`editor-label-${field.id}`}
                value={field.label}
                onChange={(e) =>
                  setFields(
                    fields.map((item) =>
                      item.id === field.id ? { ...item, label: e.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <label>
              Guidance
              <input
                value={field.guidance}
                onChange={(event) =>
                  setFields(
                    fields.map((item) =>
                      item.id === field.id ? { ...item, guidance: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            {field.type === "select" && (
              <label>
                Options (comma separated)
                <input
                  value={field.options.join(", ")}
                  onChange={(event) =>
                    setFields(
                      fields.map((item) =>
                        item.id === field.id
                          ? {
                              ...item,
                              options: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            }
                          : item,
                      ),
                    )
                  }
                />
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) =>
                  setFields(
                    fields.map((item) =>
                      item.id === field.id ? { ...item, required: event.target.checked } : item,
                    ),
                  )
                }
              />{" "}
              Required
            </label>
            <div className="field-actions">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  const next = [...fields];
                  const [fieldToMove] = next.splice(index, 1);
                  if (fieldToMove) next.splice(index - 1, 0, fieldToMove);
                  setFields(next);
                }}
              >
                Move up
              </button>
              <button
                type="button"
                onClick={() => setFields(fields.filter((item) => item.id !== field.id))}
              >
                Remove
              </button>
              <button
                type="button"
                disabled={index === fields.length - 1}
                onClick={() => {
                  const next = [...fields];
                  const [fieldToMove] = next.splice(index, 1);
                  if (fieldToMove) next.splice(index + 1, 0, fieldToMove);
                  setFields(next);
                }}
              >
                Move down
              </button>
            </div>
          </>
        ) : field.type === "long_text" ? (
          <textarea
            id={`answer-${field.id}`}
            value={answers[field.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
          />
        ) : field.type === "select" ? (
          <select
            id={`answer-${field.id}`}
            value={answers[field.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
          >
            <option value="">Choose…</option>
            {field.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input
            id={`answer-${field.id}`}
            type={field.type === "email" ? "email" : "text"}
            value={answers[field.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
          />
        )}{" "}
        {errors[`answers.${field.id}`]?.map((error) => (
          <p className="error" key={error}>
            {error}
          </p>
        ))}
      </div>
    ));
  if (loadingCfp)
    return (
      <section>
        <p role="status">Loading call for proposals…</p>
      </section>
    );
  if (!organizer && !form)
    return (
      <section>
        <h2>Call for proposals</h2>
        <p className="empty">This call for proposals is not available.</p>
        {notice && (
          <p role="alert" className="error">
            {notice}
          </p>
        )}
      </section>
    );
  return (
    <section aria-labelledby="cfp-workspace-title">
      <p className="eyebrow">
        {organizer
          ? "CFP composer"
          : form?.status === "closed"
            ? "Submissions closed"
            : "Submit a proposal"}
      </p>
      <h2 id="cfp-workspace-title">{organizer ? "Build the proposal form" : form?.title}</h2>
      {organizer ? (
        <>
          <label>
            Form title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {renderFields(true)}
          <button
            type="button"
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
            Add field
          </button>{" "}
          {/* ERROR-INTENT: React handlers cannot await; persist renders failures. */}
          <button type="button" onClick={() => void persist()}>
            Save draft
          </button>{" "}
          {form && (
            <button
              type="button"
              onClick={() =>
                // ERROR-INTENT: React handlers cannot await; transition renders failures.
                void transition(
                  form.status === "open"
                    ? "close"
                    : form.status === "closed"
                      ? "reopen"
                      : "publish",
                )
              }
            >
              {form.status === "open"
                ? "Close CFP"
                : form.status === "closed"
                  ? "Reopen CFP"
                  : "Publish CFP"}
            </button>
          )}
          <h3>Preview</h3>
          {renderFields(false)}
        </>
      ) : (
        <form onSubmit={submit}>
          <p>{form?.description}</p>
          {form?.status === "open" ? (
            <>
              {renderFields(false)}
              <button type="submit" disabled={submitting}>
                {submitting ? "Submitting…" : "Submit proposal"}
              </button>
            </>
          ) : (
            <p className="empty">Submissions are closed.</p>
          )}
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
