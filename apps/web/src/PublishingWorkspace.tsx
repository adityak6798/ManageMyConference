/*
 * Publishing console.
 *
 * The publishing capability was fully built and had no caller: the public site only
 * existed because the seed inserted a published row, so an organizer who created an
 * event in the product could never give it a public page. This surface is the caller.
 *
 * Two things drive its shape.
 *
 * 1. Publishing takes an *immutable snapshot*. The server recomposes `draft` from the
 *    live content, agenda, and CFP on every preview, but visitors keep receiving the
 *    frozen `published` copy until the organizer publishes again. That divergence is
 *    invisible in the API, so the panel states it in words, fingerprints both copies,
 *    and names which parts have moved.
 * 2. The embed views are the product's distribution story and nothing pointed at them.
 *    Each view gets its address, a paste-ready <iframe> snippet, and a live frame of
 *    the real embed — so "does this work in someone else's page" is answered on screen
 *    rather than in a runbook.
 *
 * Preview never mutates: it is a GET, and the copy says so, because an organizer must
 * be able to look at what publishing *would* do without doing it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type PublicationDto,
  PublicationApiError,
  previewPublication,
  setPublicationState,
} from "./api/publication";
import "./styles/publishing.css";
import {
  IconCalendar,
  IconCheck,
  IconForm,
  IconGlobe,
  IconLink,
  IconSpeakers,
  IconWarning,
} from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "./ui/primitives";

type Projection = PublicationDto["draft"];

const EMBED_VIEWS = [
  {
    id: "schedule",
    label: "Schedule",
    description: "The published day-by-day itinerary, chrome stripped.",
  },
  {
    id: "speakers",
    label: "Speakers",
    description: "The published speaker gallery, chrome stripped.",
  },
] as const;

function describe(reason: unknown, fallback: string): string {
  if (reason instanceof PublicationApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  if (reason instanceof Error && reason.message) return `${fallback} (${reason.message})`;
  return fallback;
}

/**
 * A short, stable identity for one projection. The publication record carries no
 * version number, so two snapshots taken minutes apart would otherwise be
 * indistinguishable on screen; this makes "the draft is not the published copy"
 * something the organizer can see rather than infer.
 */
function fingerprint(projection: Projection | null): string {
  if (!projection) return "—";
  const text = JSON.stringify(projection);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

/** Which parts of the projection have moved since the snapshot was taken. */
function changedAreas(draft: Projection, published: Projection | null): string[] {
  if (!published) return [];
  const areas: [string, keyof Projection][] = [
    ["event details", "event"],
    ["call for proposals", "cfp"],
    ["sessions", "sessions"],
    ["speakers", "speakers"],
  ];
  return areas
    .filter(([, key]) => JSON.stringify(draft[key]) !== JSON.stringify(published[key]))
    .map(([label]) => label);
}

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const absolute = (path: string) => new URL(path, window.location.origin).toString();

function formatStamp(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "not set";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The composed payload, rendered as itself — no publish required to see it. */
function ProjectionPreview({ projection, timezone }: { projection: Projection; timezone: string }) {
  const timed = projection.sessions.filter((session) => session.startsAt);
  return (
    <div className="publishing-projection">
      <dl className="publishing-facts">
        <div>
          <dt>Public address</dt>
          <dd>
            <code>/events/{projection.event.slug}</code>
          </dd>
        </div>
        <div>
          <dt>Dates</dt>
          <dd>
            {formatDay(projection.event.startsOn)} – {formatDay(projection.event.endsOn)}
          </dd>
        </div>
        <div>
          <dt>Venue</dt>
          <dd>{projection.event.venue || "not set"}</dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{projection.event.timezone}</dd>
        </div>
      </dl>

      <p className="publishing-projection-line">
        <IconForm size={14} />
        <span>
          <strong>{projection.cfp.title}</strong> ·{" "}
          {projection.cfp.status === "open" ? "open for submissions" : "closed"} · submissions go to{" "}
          <code>{projection.cfp.submissionUrl}</code>
        </span>
      </p>

      <div className="publishing-lists">
        <section aria-labelledby={`sessions-${projection.event.slug}`}>
          <h3 id={`sessions-${projection.event.slug}`}>
            <IconCalendar size={14} />
            {countLabel(projection.sessions.length, "session")}
            <span className="publishing-sub">{timed.length} with a time slot</span>
          </h3>
          {projection.sessions.length === 0 ? (
            <p className="publishing-sub">
              Nothing accepted yet — publishing would produce an empty programme.
            </p>
          ) : (
            <ul className="publishing-plain">
              {projection.sessions.map((session) => (
                <li key={session.slug}>
                  <strong>{session.title}</strong>
                  <span className="publishing-sub">
                    {[
                      session.startsAt
                        ? new Intl.DateTimeFormat("en-US", {
                            timeZone: timezone,
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          }).format(new Date(session.startsAt))
                        : "time to be announced",
                      session.room,
                      session.track,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`speakers-${projection.event.slug}`}>
          <h3 id={`speakers-${projection.event.slug}`}>
            <IconSpeakers size={14} />
            {countLabel(projection.speakers.length, "speaker")}
          </h3>
          {projection.speakers.length === 0 ? (
            <p className="publishing-sub">No speaker profiles are ready to publish.</p>
          ) : (
            <ul className="publishing-plain">
              {projection.speakers.map((speaker) => (
                <li key={speaker.slug}>
                  <strong>{speaker.name}</strong>
                  <span className="publishing-sub">{speaker.headline || "no headline"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// @spec PRD-PUB-001
export function PublishingWorkspace({
  eventId,
  eventName,
  canPublish,
  onPublicationChange,
}: {
  eventId: string;
  eventName: string;
  canPublish: boolean;
  onPublicationChange?: (summary: { slug: string; state: string }) => void;
}) {
  const [publication, setPublication] = useState<PublicationDto | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"preview" | "publish" | "unpublish" | null>(null);
  const [tab, setTab] = useState("publishing-draft");
  const feedback = useActionFeedback();
  const { announce } = feedback;
  const statusRef = useRef<HTMLDivElement>(null);
  // The loader is re-runnable by hand, so each run stamps a generation and drops its
  // own result if a newer run started meanwhile.
  const run = useRef(0);

  const adopt = useCallback(
    (next: PublicationDto) => {
      setPublication(next);
      onPublicationChange?.({ slug: next.slug, state: next.state });
    },
    [onPublicationChange],
  );

  const load = useCallback(async () => {
    const generation = ++run.current;
    setLoading(true);
    setLoadFailure(null);
    try {
      const next = await previewPublication(eventId);
      if (run.current === generation) adopt(next);
    } catch (reason: unknown) {
      // ERROR-INTENT: the panel refuses to render controls it cannot back with real
      // state; setLoadFailure renders the reason and offers a retry instead.
      if (run.current === generation)
        setLoadFailure(describe(reason, "The publication could not be loaded."));
    } finally {
      if (run.current === generation) setLoading(false);
    }
  }, [adopt, eventId]);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; load renders both of its outcomes.
    void load();
    return () => {
      run.current += 1;
    };
  }, [load]);

  /** Recompose the payload from live content. A GET: nothing is published. */
  const composePreview = useCallback(async () => {
    setBusy("preview");
    try {
      const next = await previewPublication(eventId);
      adopt(next);
      announce(
        "success",
        next.published
          ? "Preview recomposed from the current draft. The published snapshot is untouched."
          : "Preview recomposed from the current draft. Nothing has been published.",
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: the announcement is the user-facing preview failure state.
      announce("error", describe(reason, "The preview could not be composed."));
    } finally {
      setBusy(null);
    }
  }, [adopt, announce, eventId]);

  const mutate = useCallback(
    async (action: "publish" | "unpublish") => {
      setBusy(action);
      try {
        const next = await setPublicationState(eventId, action);
        adopt(next);
        announce(
          "success",
          action === "publish"
            ? "Published. Visitors see this snapshot; later draft edits stay invisible until you publish again."
            : "Unpublished. The public page and both embeds now return the not-published response.",
        );
        // Publishing changes what the panel offers — a public link and live embeds
        // appear, or disappear. Move focus to the state it changed rather than
        // leaving it on a button whose meaning just flipped.
        statusRef.current?.focus();
      } catch (reason: unknown) {
        // ERROR-INTENT: the announcement is the user-facing transition failure state.
        announce(
          "error",
          describe(
            reason,
            action === "publish"
              ? "The event could not be published."
              : "The event could not be unpublished.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [adopt, announce, eventId],
  );

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        announce("success", `${what} copied to the clipboard.`);
      } catch {
        // ERROR-INTENT: clipboard access is refused outside a secure context. The
        // snippet stays on screen in a selectable field, so copying by hand works.
        announce("error", `Copying was blocked by the browser. Select the ${what} and copy it.`);
      }
    },
    [announce],
  );

  const model = useMemo(() => {
    if (!publication) return null;
    const published = publication.published;
    const siteHref = `/events/${publication.slug}`;
    return {
      published,
      isLive: publication.state === "published" && published !== null,
      siteHref,
      siteUrl: absolute(siteHref),
      draftPrint: fingerprint(publication.draft),
      publishedPrint: fingerprint(published),
      changed: changedAreas(publication.draft, published),
      embeds: EMBED_VIEWS.map((view) => {
        const path = `/embed/events/${publication.slug}/${view.id}`;
        const url = absolute(path);
        const title = `${eventName} ${view.label.toLowerCase()}`;
        return {
          ...view,
          path,
          url,
          snippet: `<iframe src="${escapeAttribute(url)}" title="${escapeAttribute(title)}" width="100%" height="640" loading="lazy" style="border:0"></iframe>`,
        };
      }),
    };
  }, [eventName, publication]);

  if (loading)
    return (
      <Card>
        <div className="publishing-loading" aria-hidden="true">
          <div className="skeleton" style={{ height: 18, width: "34%" }} />
          <div className="skeleton" style={{ height: 96, width: "100%" }} />
        </div>
        <p className="visually-hidden" role="status">
          Loading the publication.
        </p>
      </Card>
    );

  if (loadFailure || !publication || !model)
    return (
      <Card
        labelledBy="publishing-unavailable"
        title="The publication could not be opened"
        actions={
          <button
            type="button"
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; load renders both outcomes.
              void load();
            }}
          >
            Try again
          </button>
        }
      >
        <Notice tone="error">
          {loadFailure ?? "The publishing service returned no publication for this event."}
        </Notice>
        <p className="publishing-sub">
          Publishing stays disabled until the current state loads, so a retry cannot overwrite a
          snapshot this panel never managed to read.
        </p>
      </Card>
    );

  const activeProjection = tab === "publishing-published" ? model.published : publication.draft;

  return (
    <>
      <Card labelledBy="publishing-state" title="Publication" tight>
        {/* tabIndex={-1} is a focus target for the publish/unpublish outcome, not a tab stop. */}
        <div className="publishing-status" ref={statusRef} tabIndex={-1}>
          <div className="publishing-state">
            <div className="publishing-pills">
              {model.isLive ? (
                <Pill tone="ok">
                  <span className="dot" />
                  Published
                </Pill>
              ) : publication.state === "unpublished" ? (
                <Pill tone="neutral">
                  <IconWarning size={12} />
                  Taken down
                </Pill>
              ) : (
                <Pill tone="warn">
                  <IconWarning size={12} />
                  Not published
                </Pill>
              )}
              {model.isLive && model.changed.length ? (
                <Pill tone="warn">Draft ahead of the published snapshot</Pill>
              ) : model.isLive ? (
                <Pill tone="ok">
                  <IconCheck size={12} />
                  Snapshot matches the draft
                </Pill>
              ) : (
                <Pill tone="neutral">Draft only</Pill>
              )}
            </div>
            <p className="publishing-meta">
              Snapshot <code>{model.publishedPrint}</code> · published{" "}
              {formatStamp(publication.publishedAt)} · draft <code>{model.draftPrint}</code>
            </p>
          </div>

          <div className="toolbar publishing-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; composePreview announces both outcomes.
                void composePreview();
              }}
            >
              {busy === "preview" ? "Composing…" : "Preview"}
            </button>
            {model.isLive ? (
              <a className="btn secondary" href={model.siteHref} target="_blank" rel="noreferrer">
                <IconGlobe size={15} />
                Open public site
              </a>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={busy !== null || !canPublish || !model.isLive}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; mutate announces both outcomes.
                void mutate("unpublish");
              }}
            >
              {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
            </button>
            <button
              type="button"
              disabled={busy !== null || !canPublish}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; mutate announces both outcomes.
                void mutate("publish");
              }}
            >
              {busy === "publish" ? "Publishing…" : model.isLive ? "Publish changes" : "Publish"}
            </button>
          </div>
        </div>

        <div className="publishing-foot">
          {feedback.node}
          {model.isLive ? (
            <p className="publishing-url">
              Public URL:{" "}
              <a href={model.siteHref} target="_blank" rel="noreferrer">
                {model.siteUrl}
              </a>
            </p>
          ) : (
            <p className="publishing-url">
              Reserved public URL: <code>{model.siteUrl}</code> — it answers with the standard
              not-published response until you publish.
            </p>
          )}
          {canPublish ? null : (
            <p className="publishing-sub">
              Your role on this event can read the publication but not change it.
            </p>
          )}
        </div>
      </Card>

      {model.isLive && model.changed.length ? (
        <Notice tone="warn">
          <IconWarning size={15} />
          <span>
            Visitors are being served the snapshot taken on {formatStamp(publication.publishedAt)}.
            The draft has moved on ({model.changed.join(", ")}) and those edits stay invisible until
            you publish again.
          </span>
        </Notice>
      ) : model.isLive ? (
        <Notice tone="info">
          <IconCheck size={15} />
          <span>
            The published snapshot is identical to the current draft. Publishing freezes a copy —
            editing sessions, speakers, or the agenda afterwards never changes the live page on its
            own.
          </span>
        </Notice>
      ) : (
        <Notice tone="info">
          <IconGlobe size={15} />
          <span>
            Nothing is published yet. Preview composes the payload without publishing; Publish
            freezes that payload as an immutable snapshot and brings the public page and both embeds
            online.
          </span>
        </Notice>
      )}

      <Card
        labelledBy="publishing-preview"
        title="Preview"
        hint="Composed from the live draft. Opening this page never publishes anything."
        tight
      >
        <div className="publishing-tabs">
          <Tabs
            label="Which copy of the publication to inspect"
            active={tab}
            onSelect={setTab}
            items={[
              { id: "publishing-draft", label: "Draft preview" },
              { id: "publishing-published", label: "Published snapshot" },
            ]}
          />
        </div>
        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tabpanel must be keyboard reachable.
          tabIndex={0}
          className="publishing-panel"
        >
          {activeProjection ? (
            <ProjectionPreview
              projection={activeProjection}
              timezone={activeProjection.event.timezone}
            />
          ) : (
            <EmptyState title="No snapshot has been taken" icon={<IconGlobe size={20} />}>
              Publish, and this tab shows the exact payload visitors are served so you can compare
              it with the draft before changing anything.
            </EmptyState>
          )}
        </div>
      </Card>

      <Card
        labelledBy="publishing-embeds"
        title="Embeds"
        hint="Chromeless views for another site. They serve the published snapshot, not the draft."
      >
        <div className="publishing-embeds">
          {model.embeds.map((embed) => (
            <section
              className="publishing-embed"
              key={embed.id}
              aria-labelledby={`embed-${embed.id}`}
            >
              <div className="publishing-embed-head">
                <h3 id={`embed-${embed.id}`}>{embed.label}</h3>
                <p className="publishing-sub">{embed.description}</p>
              </div>

              <p className="publishing-url">
                {model.isLive ? (
                  <a href={embed.path} target="_blank" rel="noreferrer">
                    {embed.url}
                  </a>
                ) : (
                  <code>{embed.url}</code>
                )}
              </p>

              <div className="field">
                <label htmlFor={`snippet-${embed.id}`}>Paste this into the host page</label>
                <textarea
                  id={`snippet-${embed.id}`}
                  className="publishing-snippet"
                  readOnly
                  rows={3}
                  value={embed.snippet}
                  onFocus={(focusEvent) => focusEvent.currentTarget.select()}
                />
              </div>

              <div className="toolbar">
                {/* Both views offer the same two controls, so the visible label alone
                    would give a screen reader two identical "Copy snippet" buttons with
                    nothing to tell them apart. The accessible name starts with the
                    visible text so voice control still matches it. */}
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Copy snippet for the ${embed.label} embed`}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; copy announces both outcomes.
                    void copy(embed.snippet, `${embed.label} embed snippet`);
                  }}
                >
                  <IconLink size={15} />
                  Copy snippet
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Copy URL for the ${embed.label} embed`}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; copy announces both outcomes.
                    void copy(embed.url, `${embed.label} embed URL`);
                  }}
                >
                  Copy URL
                </button>
              </div>

              {model.isLive ? (
                <div className="publishing-frame">
                  <iframe src={embed.path} title={`${embed.label} embed preview`} loading="lazy" />
                </div>
              ) : (
                <EmptyState title="No live embed yet" icon={<IconGlobe size={20} />}>
                  Publish the event and this frame renders the real embed, exactly as a host page
                  would receive it.
                </EmptyState>
              )}
            </section>
          ))}
        </div>
      </Card>
    </>
  );
}
