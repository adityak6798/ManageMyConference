import { type FormEvent, useState } from "react";
import {
  addContentComment,
  bulkRequestSpeakerTasks,
  downloadDeliverables,
  importSpeakerCsv,
  restoreContentRevision,
} from "../api/content";
import { Card, EmptyState, Notice, useActionFeedback } from "../ui/primitives";
import type { Run, Workspace } from "./shared";

export function ContentOperations({
  eventId,
  workspace,
  busy,
  run,
}: {
  eventId: string;
  workspace: Workspace;
  busy: boolean;
  run: Run;
}) {
  const feedback = useActionFeedback();
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([]);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof importSpeakerCsv>> | null>(null);
  const toggle = (values: string[], id: string, set: (next: string[]) => void) =>
    set(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  function csv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const commit = data.get("mode") === "commit";
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(async () =>
      setPreview(await importSpeakerCsv(eventId, String(data.get("csv")), commit)),
    ).then((result) =>
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? commit
            ? "Import complete."
            : "Preview ready."
          : "CSV could not be validated.",
      ),
    );
  }
  function tasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() =>
      bulkRequestSpeakerTasks({
        profileIds: selectedSpeakers,
        title: String(data.get("title")),
        dueAt: new Date(String(data.get("dueAt"))).toISOString(),
        type: data.get("type") === "file-request" ? "file-request" : "general",
        instructions: String(data.get("instructions")),
      }),
    );
  }
  const latest = workspace.assets.filter((asset) => asset.isLatest !== false);
  return (
    <div className="grid-auto">
      <Card
        title="Import speakers"
        hint="Validate first; duplicates and invalid rows are never silently imported."
      >
        {feedback.node}
        <form className="form-stack" onSubmit={csv}>
          <label>
            CSV
            <textarea name="csv" rows={5} placeholder="name,email,workflowStatus" required />
          </label>
          <div className="row-actions">
            <button type="submit" name="mode" value="preview" disabled={busy}>
              Preview CSV
            </button>
            <button type="submit" name="mode" value="commit" disabled={busy || !preview}>
              Import valid rows
            </button>
          </div>
        </form>
        {preview ? (
          <Notice tone={preview.invalid ? "warn" : "success"}>
            {preview.valid} valid · {preview.duplicates} duplicate · {preview.invalid} invalid
          </Notice>
        ) : null}
      </Card>
      <Card
        title="Bulk assignments"
        hint="Select speakers, then assign one dated task to all of them."
      >
        <label>
          Speakers
          <select
            multiple
            value={selectedSpeakers}
            onChange={(event) =>
              setSelectedSpeakers(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              )
            }
          >
            {workspace.speakers.map((speaker) => (
              <option key={speaker.id} value={speaker.id}>
                {speaker.name} · {speaker.workflowStatus ?? "onboarding"}
              </option>
            ))}
          </select>
        </label>
        <form className="form-stack" onSubmit={tasks}>
          <label>
            Task
            <input name="title" required />
          </label>
          <label>
            Due
            <input name="dueAt" type="datetime-local" required />
          </label>
          <label>
            Type
            <select name="type">
              <option value="general">General</option>
              <option value="file-request">File request</option>
            </select>
          </label>
          <label>
            Instructions
            <textarea name="instructions" />
          </label>
          <button type="submit" disabled={busy || !selectedSpeakers.length}>
            Assign to selected
          </button>
        </form>
      </Card>
      <Card
        title="Latest deliverables"
        hint="The ZIP contains only the latest selected version, with deterministic filenames."
      >
        {latest.length ? (
          <>
            {latest.map((asset) => (
              <div key={asset.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedAssets.includes(asset.id)}
                    onChange={() => toggle(selectedAssets, asset.id, setSelectedAssets)}
                  />{" "}
                  {asset.name} · v{asset.versionNumber ?? 1}
                </label>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const body = String(new FormData(event.currentTarget).get("body"));
                    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                    void run(() => addContentComment(asset.id, body));
                  }}
                >
                  <input name="body" aria-label={`Comment on ${asset.name}`} required />
                  <button type="submit">Comment</button>
                </form>
              </div>
            ))}
            <button
              type="button"
              disabled={!selectedAssets.length || busy}
              onClick={() => {
                // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                void run(() => downloadDeliverables(eventId, selectedAssets));
              }}
            >
              Download selected ZIP
            </button>
          </>
        ) : (
          <EmptyState title="No deliverables yet">Requested uploads appear here.</EmptyState>
        )}
      </Card>
      <Card
        title="Edit history"
        hint="Every profile and session edit records its actor and can be restored without deleting history."
      >
        {(workspace.revisions ?? []).length ? (
          <ul>
            {(workspace.revisions ?? []).map((revision) => (
              <li key={revision.id}>
                {revision.entityType} · revision {revision.revisionNumber} · {revision.actorId}{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                    void run(() => restoreContentRevision(revision.id));
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No edits yet">
            Attributed revisions appear after the first edit.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
