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
  useEffect(() => {
    setNotice("");
    setErrors({});
    // ERROR-INTENT: React effects cannot await; the handlers render load failures.
    void loadCfp(eventId, organizer)
      .then((loaded) => {
        setForm(loaded);
        setTitle(loaded.title);
        setDescription(loaded.description);
        setFields([...loaded.fields]);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof CfpApiError && reason.envelope.error.code === "NOT_FOUND"))
          setNotice(message(reason));
      });
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
    try {
      const result = await submitProposal(eventId, answers, crypto.randomUUID());
      setNotice(`Proposal received. Confirmation: ${result.confirmationId}`);
    } catch (reason) {
      // ERROR-INTENT: Field errors and the notice render the submission failure.
      if (reason instanceof CfpApiError) setErrors(reason.envelope.error.fieldErrors ?? {});
      setNotice(message(reason));
    }
  };
  const renderFields = (editable: boolean) =>
    fields.map((field, index) => (
      <div className="cfp-field" key={field.id}>
        <label htmlFor={`cfp-${field.id}`}>
          {field.label}
          {field.required ? " *" : ""}
        </label>
        {field.guidance && <small>{field.guidance}</small>}
        {editable ? (
          <>
            <input
              id={`cfp-${field.id}`}
              value={field.label}
              onChange={(e) =>
                setFields(
                  fields.map((item) =>
                    item.id === field.id ? { ...item, label: e.target.value } : item,
                  ),
                )
              }
            />
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
            id={`cfp-${field.id}`}
            value={answers[field.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
          />
        ) : field.type === "select" ? (
          <select
            id={`cfp-${field.id}`}
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
            id={`cfp-${field.id}`}
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
    <section aria-labelledby="cfp-title">
      <p className="eyebrow">
        {organizer
          ? "CFP composer"
          : form?.status === "closed"
            ? "Submissions closed"
            : "Submit a proposal"}
      </p>
      <h2 id="cfp-title">{organizer ? "Build the proposal form" : form?.title}</h2>
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
              <button type="submit">Submit proposal</button>
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
