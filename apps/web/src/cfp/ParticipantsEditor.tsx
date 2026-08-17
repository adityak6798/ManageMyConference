import type { ProposalParticipantInput } from "@greenroom/contracts";
import { Field, Select } from "../ui/fields";

/**
 * Structured co-presenters owned by the proposal, never encoded in an answer or biography.
 *
 * The three controls go through the shared field and control tier rather than bare native
 * elements. This editor is rendered inside both the console's applicant form and the public
 * call for proposals, and on the public page it was the one group whose inputs arrived as
 * browser defaults beside five controls wearing the product's own shell — which the public
 * stylesheet had to answer by redrawing the whole control shell by element selector.
 */
export function ParticipantsEditor({
  participants,
  onChange,
  disabled = false,
}: {
  participants: ProposalParticipantInput[];
  onChange: (participants: ProposalParticipantInput[]) => void;
  disabled?: boolean;
}) {
  const update = (id: string, patch: Partial<ProposalParticipantInput>) =>
    onChange(
      participants.map((participant) =>
        participant.id === id ? { ...participant, ...patch } : participant,
      ),
    );
  return (
    <fieldset className="cfp-participants" disabled={disabled}>
      <legend>Co-presenters</legend>
      <p className="hint">
        Add each person separately. Their contact details stay private and blind reviewers receive
        no participant identity.
      </p>
      {participants.map((participant, index) => (
        <div className="cfp-participant" key={participant.id}>
          <Field label="Name" required>
            {(control) => (
              <input
                {...control}
                className="control"
                value={participant.name}
                onChange={(event) => update(participant.id, { name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Email" required>
            {(control) => (
              <input
                {...control}
                className="control"
                type="email"
                value={participant.email}
                onChange={(event) => update(participant.id, { email: event.target.value })}
              />
            )}
          </Field>
          <Select
            className="cfp-participant-role"
            label="Role"
            value={participant.role}
            onChange={(value) =>
              update(participant.id, {
                role: value as ProposalParticipantInput["role"],
              })
            }
            options={[
              { value: "co_speaker", label: "Co-speaker / co-presenter" },
              { value: "moderator", label: "Moderator" },
            ]}
          />
          <button
            type="button"
            className="button-quiet"
            onClick={() => onChange(participants.filter(({ id }) => id !== participant.id))}
          >
            Remove participant {index + 1}
          </button>
        </div>
      ))}
      <button
        className="secondary"
        type="button"
        disabled={disabled || participants.length >= 8}
        onClick={() =>
          onChange([
            ...participants,
            { id: crypto.randomUUID(), name: "", email: "", role: "co_speaker" },
          ])
        }
      >
        Add co-presenter
      </button>
      <p aria-live="polite" className="hint">
        {participants.length} of 8 co-presenters added.
      </p>
    </fieldset>
  );
}
