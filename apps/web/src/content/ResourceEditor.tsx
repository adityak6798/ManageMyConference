/*
 * Speaker resource authoring.
 *
 * This is a settings task performed rarely, so it renders as a roster with one editor open at a
 * time rather than a create form stacked on top of an expanded form per resource (#144). Two
 * consequences: the panel's height no longer grows with the number of resources, and the HTML
 * fields are only on screen when somebody chose to author something.
 */

import { type FormEvent, useState } from "react";
import { ContentApiError, deleteSpeakerResource, saveSpeakerResource } from "../api/content";
import { EmptyState, Notice, Pill, useActionFeedback } from "../ui/primitives";
import type { Run, Workspace } from "./shared";

type Resource = NonNullable<Workspace["resources"]>[number];

/**
 * The authoring fields, used for both a new resource and an existing one.
 *
 * One definition rather than two near-identical copies: the duplicate was how the create and edit
 * forms drifted apart, and it is what put two full HTML editors in the first 600px of the page.
 */
function ResourceForm({
  resource,
  busy,
  onSubmit,
  onCancel,
}: {
  resource?: Resource;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(resource);
  return (
    <form className="form-stack resource-form" onSubmit={onSubmit}>
      <label>
        Title
        <input name="title" required maxLength={160} defaultValue={resource?.title} />
      </label>
      <label>
        Slug
        <input
          name="slug"
          required
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          defaultValue={resource?.slug}
        />
      </label>
      <label className="resource-form-wide">
        Page HTML
        <textarea name="bodyHtml" rows={6} defaultValue={resource?.bodyHtml} />
      </label>
      <label className="resource-form-wide">
        Embed HTML
        <textarea
          name="embedHtml"
          rows={3}
          placeholder="Allowlisted HTTPS iframe only"
          defaultValue={resource?.embedHtml}
        />
      </label>
      <label>
        Allowed embed hosts
        <input name="embedAllowedHosts" placeholder="docs.example.org, video.example.org" />
        {/* The read model does not return the stored allowlist (`speakerResourceSchema` carries
            no `embedAllowedHosts`), so this field cannot be prefilled and a save replaces whatever
            was there. Said out loud rather than left as a silent overwrite. */}
        {editing ? (
          <span className="hint">
            Not shown for an existing resource. Saving replaces the stored allowlist with whatever
            is in this field, so re-enter every host the embed needs.
          </span>
        ) : null}
      </label>
      <label>
        Order
        <input name="sortOrder" type="number" min={0} defaultValue={resource?.sortOrder ?? 0} />
      </label>
      <label className="resource-form-wide">
        <input
          name="visible"
          type="checkbox"
          defaultChecked={resource ? resource.visibility === "visible" : false}
        />{" "}
        Visible to speakers
      </label>
      <div className="row-actions resource-form-wide">
        <button type="submit" disabled={busy}>
          {editing ? "Save changes" : "Create resource"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  // One editor at a time: "new", a resource id, or nothing open at all.
  const [open, setOpen] = useState<string | null>(null);
  const editing = resources.find(({ id }) => id === open);

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
    ).then((result) => {
      if (result.ok) setOpen(null);
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? "Resource saved."
          : result.error instanceof ContentApiError
            ? result.error.message
            : "Resource could not be saved.",
      );
    });
  }

  function remove(resource: Resource) {
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() => deleteSpeakerResource(resource.id)).then((result) => {
      if (result.ok) setOpen((current) => (current === resource.id ? null : current));
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok ? `“${resource.title}” was deleted.` : "That resource could not be deleted.",
      );
    });
  }

  return (
    <div className="resource-manager">
      {feedback.node}
      <div className="row-actions">
        <button
          type="button"
          className="secondary small"
          aria-expanded={open === "new"}
          aria-controls="resource-new-form"
          onClick={() => setOpen(open === "new" ? null : "new")}
          disabled={busy}
        >
          {open === "new" ? "Cancel new resource" : "New resource"}
        </button>
      </div>

      {open === "new" ? (
        <div id="resource-new-form">
          <ResourceForm busy={busy} onSubmit={submit} onCancel={() => setOpen(null)} />
        </div>
      ) : null}

      {resources.length ? (
        <ul className="resource-list">
          {resources.map((resource) => {
            const isOpen = open === resource.id;
            return (
              <li key={resource.id}>
                <div className="resource-row">
                  <span className="resource-name">
                    {resource.title}
                    <span className="sub">/{resource.slug}</span>
                  </span>
                  <Pill tone={resource.visibility === "visible" ? "ok" : "neutral"}>
                    {resource.visibility === "visible" ? "Visible" : "Hidden"}
                  </Pill>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="secondary small"
                      aria-expanded={isOpen}
                      aria-controls={`resource-form-${resource.id}`}
                      onClick={() => setOpen(isOpen ? null : resource.id)}
                    >
                      {isOpen ? "Close" : "Edit"}
                      <span className="visually-hidden"> {resource.title}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => remove(resource)}
                    >
                      Delete
                      <span className="visually-hidden"> {resource.title}</span>
                    </button>
                  </div>
                </div>
                {isOpen && editing ? (
                  <div id={`resource-form-${resource.id}`}>
                    <ResourceForm
                      key={editing.id}
                      resource={editing}
                      busy={busy}
                      onSubmit={(event) => submit(event, editing.id)}
                      onCancel={() => setOpen(null)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No resources yet">
          Create the first portal guide with the button above.
        </EmptyState>
      )}

      <Notice tone="info">
        Embeds are accepted only from the configured host allowlist and run in a sandbox without
        script privileges.
      </Notice>
    </div>
  );
}
