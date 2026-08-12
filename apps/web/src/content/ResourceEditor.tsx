import type { FormEvent } from "react";
import { deleteSpeakerResource, saveSpeakerResource } from "../api/content";
import { Card, EmptyState, Notice, useActionFeedback } from "../ui/primitives";
import type { Run, Workspace } from "./shared";

export function ResourceEditor({
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
  const resources = workspace.resources ?? [];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() =>
      saveSpeakerResource({
        eventId,
        title: String(data.get("title")),
        slug: String(data.get("slug")),
        bodyHtml: String(data.get("bodyHtml")),
        embedHtml: String(data.get("embedHtml")),
        visibility: data.get("visible") ? "visible" : "hidden",
        sortOrder: Number(data.get("sortOrder")),
      }),
    ).then((result) =>
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok ? "Resource saved." : "Resource could not be saved.",
      ),
    );
  }
  return (
    <Card
      title="Speaker resources"
      hint="Create safely-rendered handbook and reference pages for the speaker portal."
    >
      {feedback.node}
      <form className="form-stack" onSubmit={submit}>
        <label>
          Title
          <input name="title" required maxLength={160} />
        </label>
        <label>
          Slug
          <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
        </label>
        <label>
          Page HTML
          <textarea name="bodyHtml" rows={6} />
        </label>
        <label>
          Embed HTML
          <textarea name="embedHtml" rows={3} placeholder="Allowlisted HTTPS iframe only" />
        </label>
        <label>
          Order
          <input name="sortOrder" type="number" min={0} defaultValue={resources.length} />
        </label>
        <label>
          <input name="visible" type="checkbox" /> Visible to speakers
        </label>
        <button type="submit" disabled={busy}>
          Create resource
        </button>
      </form>
      {resources.length ? (
        <ul>
          {resources.map((resource) => (
            <li key={resource.id}>
              {resource.title} · {resource.visibility}{" "}
              <button
                type="button"
                className="ghost small"
                disabled={busy}
                onClick={() => {
                  void run(() => deleteSpeakerResource(resource.id));
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No resources yet">Create the first portal guide above.</EmptyState>
      )}
      <Notice tone="info">
        Embeds are accepted only from the configured host allowlist and run in a sandbox without
        script privileges.
      </Notice>
    </Card>
  );
}
