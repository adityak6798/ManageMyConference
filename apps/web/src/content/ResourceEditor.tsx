/*
 * Speaker resource authoring.
 *
 * This is a settings task performed rarely, so it renders as a roster with one editor open at a
 * time rather than a create form stacked on top of an expanded form per resource (#144). Two
 * consequences: the panel's height no longer grows with the number of resources, and the HTML
 * fields are only on screen when somebody chose to author something.
 */

import { type FormEvent, useRef, useState } from "react";
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
  nextSortOrder,
  busy,
  onSubmit,
  onCancel,
}: {
  resource?: Resource;
  /** Where a new resource lands: after everything already authored. */
  nextSortOrder: number;
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
        {/* Deliberately not prefilled, because there is nothing to prefill it from: the allowlist
            is an argument to the sanitizer at save time, never a stored property of the resource —
            what persists is the already-sanitized `embedHtml`. `updateResource` keeps an unchanged
            embed verbatim when this field is empty, so leaving it blank on an unrelated edit is
            safe; it matters only when the embed itself changes. */}
        {editing ? (
          <span className="hint">
            Only needed if you change the embed above. Leave it empty and the current embed is kept
            as it is; supply hosts and the embed is re-checked against them.
          </span>
        ) : null}
      </label>
      <label>
        Order
        {/* A new resource appends; an existing one keeps the order it has. Defaulting a new
            page to 0 put it at the top of the portal list, tie-broken by title against
            whatever already sat at 0 — reads are `ORDER BY sort_order,title`. */}
        <input
          name="sortOrder"
          type="number"
          min={0}
          defaultValue={resource ? resource.sortOrder : nextSortOrder}
        />
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
  // A new page goes after the last one, not on top of it.
  const nextSortOrder = resources.reduce(
    (highest, { sortOrder }) => Math.max(highest, sortOrder + 1),
    0,
  );
  // Closing an editor unmounts the control that has focus, so the toggle that opened it takes
  // focus back. Without this a keyboard user is dropped to the document and has to traverse the
  // whole dashboard again to return to a roster that sits at the bottom of the page.
  const toggles = useRef<Record<string, HTMLButtonElement | null>>({});
  /**
   * Close the editor that just finished, and only that one.
   *
   * The functional update matters: a save is asynchronous, so by the time it lands the organizer
   * may have opened a different resource. Clearing `open` unconditionally would unmount whatever
   * they had opened since, along with anything typed into it. Focus is only recovered when this
   * editor really was the one on screen.
   */
  function close(id: string) {
    setOpen((current) => {
      if (current !== id) return current;
      toggles.current[id]?.focus();
      return null;
    });
  }

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
      if (result.ok) close(id ?? "new");
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
          ref={(node) => {
            toggles.current.new = node;
          }}
          onClick={() => {
            if (busy) return;
            setOpen(open === "new" ? null : "new");
          }}
          // aria-disabled, not disabled: after a successful create, `close("new")` returns focus
          // to this button while the request is still settling, and the browser refuses to focus a
          // disabled element — focus fell to the document instead. This is also the convention
          // content.css:33-38 already documents and styles for exactly this failure.
          aria-disabled={busy}
        >
          {open === "new" ? "Cancel new resource" : "New resource"}
        </button>
      </div>

      {open === "new" ? (
        <div id="resource-new-form">
          <ResourceForm
            nextSortOrder={nextSortOrder}
            busy={busy}
            onSubmit={submit}
            onCancel={() => close("new")}
          />
        </div>
      ) : null}

      {resources.length ? (
        <ul className="resource-list">
          {resources.map((resource) => {
            const isOpen = open === resource.id;
            return (
              <li key={resource.id}>
                <div className="resource-entry">
                  <span className="resource-entry-name">
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
                      ref={(node) => {
                        toggles.current[resource.id] = node;
                      }}
                      // Inert while a request is in flight, for the same reason as the New
                      // resource toggle: `aria-disabled` keeps focus where it is, and the guard
                      // is what actually stops the click.
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        setOpen(isOpen ? null : resource.id);
                      }}
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
                      nextSortOrder={nextSortOrder}
                      busy={busy}
                      onSubmit={(event) => submit(event, editing.id)}
                      onCancel={() => close(editing.id)}
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
