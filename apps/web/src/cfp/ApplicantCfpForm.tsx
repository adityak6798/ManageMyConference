import { type FormEvent, useState } from "react";
import { CfpApiError, type CfpFormDto, submitProposal } from "../api/cfp";
import { IconForm } from "../ui/icons";
import { Card, EmptyState, Pill } from "../ui/primitives";
import { FieldControl } from "./controls";
import { conditionMatches, DEFAULT_TITLE, describe } from "./model";

/** The applicant submission lifecycle, separate from the organizer's draft composer. */
export function ApplicantCfpForm({ eventId, form }: { eventId: string; form: CfpFormDto }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      const result = await submitProposal(eventId, answers, submissionKey);
      setNotice(`Proposal received. Confirmation: ${result.confirmationId}`);
      setSubmissionKey(crypto.randomUUID());
    } catch (reason) {
      // ERROR-INTENT: field errors and the adjacent notice render the submission failure.
      if (reason instanceof CfpApiError) setErrors(reason.envelope.error.fieldErrors ?? {});
      setNotice(describe(reason, "The proposal could not be submitted."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      labelledBy="cfp-public-title"
      title={form.title || DEFAULT_TITLE}
      hint={form.description || undefined}
      actions={
        form.status === "open" ? (
          <Pill tone="ok">Open for submissions</Pill>
        ) : (
          <Pill tone="neutral">Closed</Pill>
        )
      }
    >
      {form.status === "open" ? (
        <form onSubmit={submit} className="cfp-public-form">
          {form.fields
            .filter((field) => conditionMatches(field.visibleWhen, answers))
            .map((field) => (
              <FieldControl
                key={field.id}
                field={field}
                idPrefix="answer"
                value={answers[field.id] ?? ""}
                errors={errors[`answers.${field.id}`] ?? []}
                onChange={(next) =>
                  setAnswers((current) => {
                    const updated = { ...current, [field.id]: next };
                    for (const candidate of form.fields)
                      if (!conditionMatches(candidate.visibleWhen, updated))
                        delete updated[candidate.id];
                    return updated;
                  })
                }
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
}
