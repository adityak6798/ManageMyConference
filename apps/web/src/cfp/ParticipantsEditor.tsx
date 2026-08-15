import type { ProposalParticipantInput } from "@greenroom/contracts";

/** Structured co-presenters owned by the proposal, never encoded in an answer or biography. */
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
          <label>
            Name
            <input
              required
              value={participant.name}
              onChange={(event) => update(participant.id, { name: event.target.value })}
            />
          </label>
          <label>
            Email
            <input
              required
              type="email"
              value={participant.email}
              onChange={(event) => update(participant.id, { email: event.target.value })}
            />
          </label>
          <label>
            Role
            <select
              value={participant.role}
              onChange={(event) =>
                update(participant.id, {
                  role: event.target.value as ProposalParticipantInput["role"],
                })
              }
            >
              <option value="co_speaker">Co-speaker / co-presenter</option>
              <option value="moderator">Moderator</option>
            </select>
          </label>
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
