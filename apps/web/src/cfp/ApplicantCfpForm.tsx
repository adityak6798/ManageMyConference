import { type FormEvent, useState } from "react";
import { CfpApiError, type CfpFormDto, submitProposal } from "../api/cfp";
import { IconForm } from "../ui/icons";
import { Card, EmptyState, Pill } from "../ui/primitives";
import { FieldControl } from "./controls";
import { conditionMatches, DEFAULT_TITLE, describe } from "./model";
import { ParticipantsEditor } from "./ParticipantsEditor";
import type { ProposalParticipantInput } from "@greenroom/contracts";

/** The applicant submission lifecycle, separate from the organizer's draft composer. */
export function ApplicantCfpForm({ eventId, form }: { eventId: string; form: CfpFormDto }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [participants, setParticipants] = useState<ProposalParticipantInput[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      const result = await submitProposal(eventId, answers, submissionKey, participants);
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

  /*
   * The state applicants are actually in, which is not `status` once a window exists.
   *
   * `status` describes the publication; `effectiveStatus` is the server's answer to "may somebody
   * submit right now", and it is the only one that accounts for a deadline or an opening date. This
   * surface branched on `status` and so offered a whole working form — and an "Open for
   * submissions" pill — over a call that answers 409 to every submission.
   *
   * The `?? form.status` branch is unreachable and is kept as a type-level total, not as a
   * compatibility story: `cfpFormSchema` requires `effectiveStatus` and `loadCfp` decodes through
   * it, so a response lacking the field throws in `decodeResponse` and never reaches this component.
   */
  const effective = form.effectiveStatus ?? form.status;
  const open = effective === "open";

  return (
    <Card
      labelledBy="cfp-public-title"
      title={form.title || DEFAULT_TITLE}
      hint={form.description || undefined}
      actions={
        open ? (
          <Pill tone="ok">Open for submissions</Pill>
        ) : effective === "scheduled" ? (
          <Pill tone="neutral">Opening soon</Pill>
        ) : (
          <Pill tone="neutral">Closed</Pill>
        )
      }
    >
      {open ? (
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
          <ParticipantsEditor
            participants={participants}
            onChange={setParticipants}
            disabled={submitting}
          />
          <div className="cfp-public-actions">
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit proposal"}
            </button>
            {notice ? <p role="status">{notice}</p> : null}
          </div>
        </form>
      ) : effective === "scheduled" ? (
        // "Not open yet" and "you have missed it" are opposite messages; a single closed state
        // tells roughly half the visitors who see it the wrong one.
        <EmptyState title="Submissions have not opened yet" icon={<IconForm size={20} />}>
          The form appears here when the call opens.
        </EmptyState>
      ) : (
        <EmptyState title="Submissions are closed" icon={<IconForm size={20} />}>
          This event is no longer accepting proposals.
        </EmptyState>
      )}
    </Card>
  );
}
