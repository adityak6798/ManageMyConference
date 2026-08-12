import type { FormEvent } from "react";
import { ContentApiError, deleteSpeakerResource, saveSpeakerResource } from "../api/content";
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
  function submit(event: FormEvent<HTMLFormElement>, id?: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() =>
      saveSpeakerResource({
        ...(id ? { id } : {}),
        eventId,
        title: String(data.get("title")),
        slug: String(data.get("slug")),
        bodyHtml: String(data.get("bodyHtml")),
        embedHtml: String(data.get("embedHtml")),
        embedAllowedHosts: String(data.get("embedAllowedHosts"))
          .split(/[\s,]+/)
          .filter(Boolean),
        visibility: data.get("visible") ? "visible" : "hidden",
        sortOrder: Number(data.get("sortOrder")),
      }),
    ).then((result) =>
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? "Resource saved."
          : result.error instanceof ContentApiError
            ? result.error.message
            : "Resource could not be saved.",
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
          Allowed embed hosts
          <input name="embedAllowedHosts" placeholder="docs.example.org, video.example.org" />
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
        <div className="grid-auto">
          {resources.map((resource) => (
            <form
              key={resource.id}
              className="form-stack"
              onSubmit={(event) => submit(event, resource.id)}
            >
              <label>
                Title
                <input name="title" required maxLength={160} defaultValue={resource.title} />
              </label>
              <label>
                Slug
                <input name="slug" required defaultValue={resource.slug} />
              </label>
              <label>
                Page HTML
                <textarea name="bodyHtml" rows={4} defaultValue={resource.bodyHtml} />
              </label>
              <label>
                Embed HTML
                <textarea name="embedHtml" rows={2} defaultValue={resource.embedHtml} />
              </label>
              <label>
                Allowed embed hosts
                <input name="embedAllowedHosts" placeholder="Host used by this embed" />
              </label>
              <label>
                Order
                <input name="sortOrder" type="number" min={0} defaultValue={resource.sortOrder} />
              </label>
              <label>
                <input
                  name="visible"
                  type="checkbox"
                  defaultChecked={resource.visibility === "visible"}
                />{" "}
                Visible to speakers
              </label>
              <div className="row-actions">
                <button type="submit" disabled={busy}>
                  Save changes
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                    void run(() => deleteSpeakerResource(resource.id));
                  }}
                >
                  Delete
                </button>
              </div>
            </form>
          ))}
        </div>
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
