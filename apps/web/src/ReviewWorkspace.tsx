import type { OrganizerReviewWorkspaceDto, ReviewerQueueDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  assignReviewer,
  configureProposalStatuses,
  configureReviewPlan,
  declareReviewConflict,
  getOrganizerReview,
  getReviewerQueue,
  ReviewApiError,
  saveReviewEvaluation,
  transitionProposals,
} from "./api/review";

const message = (error: unknown) =>
  error instanceof ReviewApiError
    ? `${error.message} Reference: ${error.envelope.error.correlationId}`
    : "Review work could not be loaded. Please retry.";

// @spec PRD-ABS-001 PRD-REV-001
export function OrganizerReviewWorkspace({ eventId }: { eventId: string }) {
  const [data, setData] = useState<OrganizerReviewWorkspaceDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [targetStatus, setTargetStatus] = useState("under_review");
  const [reviewerId, setReviewerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async () => setData(await getOrganizerReview(eventId, filter || undefined)),
    [eventId, filter],
  );
  useEffect(() => {
    setData(null);
    setSelected([]);
    setError(null);
    // ERROR-INTENT: React effects cannot await; the rejection renders in this workspace.
    void load().catch((reason: unknown) => setError(message(reason)));
  }, [load]);
  useEffect(() => {
    const firstStatus = data?.statuses[0];
    if (!firstStatus) return;
    if (!data.statuses.some(({ key }) => key === targetStatus)) {
      setTargetStatus(firstStatus.key);
    }
  }, [data?.statuses, targetStatus]);
  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (reason) {
      setError(message(reason));
    }
  }
  if (!data)
    return (
      <section>
        <p role="status">Loading abstract triage…</p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </section>
    );
  return (
    <section aria-labelledby="triage-title">
      <p className="eyebrow">Organizer review</p>
      <h2 id="triage-title">Abstract triage</h2>
      <div className="form-row">
        <label>
          Filter status
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">All statuses</option>
            {data.statuses.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Transition to
          <select value={targetStatus} onChange={(event) => setTargetStatus(event.target.value)}>
            {data.statuses.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reviewer
          <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
            <option value="">Choose reviewer</option>
            {data.reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="review-toolbar">
        <button
          type="button"
          disabled={!selected.length || !data.statuses.length}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; act renders any failure.
            void act(() =>
              transitionProposals(eventId, { proposalIds: selected, toStatus: targetStatus }),
            );
          }}
        >
          Move to {data.statuses.find(({ key }) => key === targetStatus)?.label ?? "status"}
        </button>
        <button
          type="button"
          disabled={!selected.length || !reviewerId}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; act renders any failure.
            void act(() => assignReviewer(eventId, { proposalIds: selected, reviewerId }));
          }}
        >
          Assign selected reviewer
        </button>
      </div>
      <ul className="proposal-list">
        {data.proposals.map((proposal) => (
          <li key={proposal.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(proposal.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, proposal.id]
                      : current.filter((id) => id !== proposal.id),
                  )
                }
              />{" "}
              <strong>{proposal.title}</strong>
            </label>
            <p>{proposal.abstract}</p>
            <span className="status-pill">{proposal.status.replaceAll("_", " ")}</span>
            {data.outcomes.find((outcome) => outcome.proposalId === proposal.id) ? (
              <span className="outcome">
                {" "}
                · Average{" "}
                {data.outcomes
                  .find((outcome) => outcome.proposalId === proposal.id)
                  ?.averageScore.toFixed(1)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <RubricForm eventId={eventId} data={data} onSaved={load} onError={setError} />
      <StatusForm eventId={eventId} data={data} onSaved={load} onError={setError} />
      <h3>Status audit</h3>
      {data.audit.length ? (
        <ul>
          {data.audit.map((entry) => (
            <li key={entry.id}>
              <strong>
                {data.proposals.find(({ id }) => id === entry.proposalId)?.title ??
                  entry.proposalId}
              </strong>
              : {entry.fromStatus} → {entry.toStatus} by {entry.actorId} at{" "}
              {new Date(entry.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No status changes yet.</p>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function StatusForm({
  eventId,
  data,
  onSaved,
  onError,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  onSaved: () => Promise<void>;
  onError: (value: string) => void;
}) {
  const [labels, setLabels] = useState(data.statuses.map(({ label }) => label).join(", "));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const statuses = labels
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean)
      .map((label, sortOrder) => ({
        key: label
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
        label,
        sortOrder,
      }));
    try {
      await configureProposalStatuses(eventId, { statuses });
      await onSaved();
    } catch (reason) {
      // ERROR-INTENT: The status form reports the handled failure through its parent alert.
      onError(message(reason));
    }
  }
  return (
    <form
      onSubmit={(event) => {
        /* ERROR-INTENT: React form handlers cannot await; submit reports failures. */ void submit(
          event,
        );
      }}
    >
      <h3>Proposal statuses</h3>
      <label htmlFor="status-labels">Ordered status labels</label>
      <div className="form-row">
        <input
          id="status-labels"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
        />
        <button type="submit">Save statuses</button>
      </div>
    </form>
  );
}

function RubricForm({
  eventId,
  data,
  onSaved,
  onError,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  onSaved: () => Promise<void>;
  onError: (value: string) => void;
}) {
  const [name, setName] = useState(data.plan?.criteria[0]?.name ?? "Audience fit");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await configureReviewPlan(eventId, {
        criteria: [
          {
            id: "primary",
            name,
            description: "Overall strength for this event",
            minScore: 1,
            maxScore: 5,
          },
        ],
      });
      await onSaved();
    } catch (reason) {
      // ERROR-INTENT: The form reports the handled request failure through its parent alert.
      onError(message(reason));
    }
  }
  return (
    <form
      onSubmit={(event) => {
        // ERROR-INTENT: React form handlers cannot await; submit reports failures through onError.
        void submit(event);
      }}
    >
      <h3>Evaluation plan</h3>
      <label htmlFor="criterion-name">Primary criterion</label>
      <div className="form-row">
        <input
          id="criterion-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <button type="submit">Save rubric</button>
      </div>
      <p className="empty">Explicit 1–5 scale</p>
    </form>
  );
}

export function ReviewerWorkspace({ eventId }: { eventId: string }) {
  const [data, setData] = useState<ReviewerQueueDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setData(await getReviewerQueue(eventId)), [eventId]);
  useEffect(() => {
    setData(null);
    setError(null);
    // ERROR-INTENT: React effects cannot await; the rejection renders in this workspace.
    void load().catch((reason: unknown) => setError(message(reason)));
  }, [load]);
  if (!data)
    return (
      <section>
        <p role="status">Loading review assignments…</p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </section>
    );
  return (
    <section aria-labelledby="queue-title">
      <p className="eyebrow">Reviewer workspace</p>
      <h2 id="queue-title">Review assignments</h2>
      <p>
        {data.assignments.filter(({ evaluation }) => evaluation?.state === "completed").length} of{" "}
        {data.assignments.length} complete
      </p>
      {data.assignments.length ? (
        data.assignments.map((item) => (
          <EvaluationCard
            key={item.assignment.id}
            eventId={eventId}
            item={item}
            reload={load}
            onError={setError}
          />
        ))
      ) : (
        <p className="empty">You have no assigned proposals for this event.</p>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function EvaluationCard({
  eventId,
  item,
  reload,
  onError,
}: {
  eventId: string;
  item: ReviewerQueueDto["assignments"][number];
  reload: () => Promise<void>;
  onError: (value: string) => void;
}) {
  const [notes, setNotes] = useState(item.evaluation?.notes ?? "");
  const initial = Object.fromEntries(
    (item.evaluation?.scores ?? []).map(({ criterionId, score }) => [criterionId, score]),
  );
  const [scores, setScores] = useState<Record<string, number>>(initial);
  async function save(complete: boolean) {
    if (!item.plan) {
      onError("The organizer must configure an evaluation plan before scores can be saved.");
      return;
    }
    try {
      await saveReviewEvaluation(eventId, item.assignment.id, {
        scores: item.plan.criteria.map((criterion) => ({
          criterionId: criterion.id,
          score: scores[criterion.id] ?? criterion.minScore,
        })),
        notes,
        complete,
      });
      await reload();
    } catch (reason) {
      // ERROR-INTENT: The evaluation card reports the handled request failure through its parent alert.
      onError(message(reason));
    }
  }
  return (
    <article className="evaluation-card">
      <h3>{item.proposal.title}</h3>
      <p>{item.proposal.abstract}</p>
      {item.evaluation?.state === "completed" ? (
        <p>Evaluation submitted. Scores and conflicts are now locked.</p>
      ) : item.conflict ? (
        <p className="denied">Conflict declared: {item.conflict.reason}</p>
      ) : (
        <>
          {!item.plan ? (
            <p role="alert" className="denied">
              The organizer has not configured an evaluation plan yet.
            </p>
          ) : null}
          {item.plan?.criteria.map((criterion) => (
            <label key={criterion.id}>
              {criterion.name}
              <select
                value={scores[criterion.id] ?? criterion.minScore}
                onChange={(event) =>
                  setScores((current) => ({
                    ...current,
                    [criterion.id]: Number(event.target.value),
                  }))
                }
              >
                {Array.from(
                  { length: criterion.maxScore - criterion.minScore + 1 },
                  (_, index) => criterion.minScore + index,
                ).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ))}
          <label>
            Private notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="review-toolbar">
            <button
              type="button"
              disabled={!item.plan}
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; save renders failures through onError.
                void save(false);
              }}
            >
              Save draft
            </button>
            <button
              type="button"
              disabled={!item.plan}
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; save renders failures through onError.
                void save(true);
              }}
            >
              Complete evaluation
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; the rejection renders through onError.
                void declareReviewConflict(eventId, item.assignment.id, "Professional relationship")
                  .then(reload)
                  // ERROR-INTENT: The rejection callback reports the failure in the parent alert.
                  .catch((reason: unknown) => onError(message(reason)));
              }}
            >
              Declare conflict
            </button>
          </div>
        </>
      )}
      {item.evaluation ? <p className="status-pill">{item.evaluation.state}</p> : null}
    </article>
  );
}
