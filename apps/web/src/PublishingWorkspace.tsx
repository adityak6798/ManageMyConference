/*
 * Publishing console.
 *
 * The publishing capability was fully built and had no caller: the public site only
 * existed because the seed inserted a published row, so an organizer who created an
 * event in the product could never give it a public page. This surface is the caller.
 *
 * Two things drive its shape.
 *
 * 1. Publishing establishes the event's public presence. Once it is live, accepted source
 *    publications refresh the versioned public projection while event/site settings remain
 *    deliberate organizer edits. The panel fingerprints draft and public copies and names
 *    any event/site changes still waiting for an explicit publish.
 * 2. The embed views are the product's distribution story and nothing pointed at them.
 *    Each view gets its address, a paste-ready <iframe> snippet, and a live frame of
 *    the real embed — so "does this work in someone else's page" is answered on screen
 *    rather than in a runbook.
 *
 * Preview never mutates: it is a GET, and the copy says so, because an organizer must
 * be able to look at what publishing *would* do without doing it.
 *
 * Feedback belongs to the control that produced it. The Publication card's toolbar
 * announces directly beneath itself; the embed cards, which sit a full page lower, own
 * their own live regions rather than borrowing that one — see EmbedPanel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PublicationApiError,
  type PublicationDto,
  previewPublication,
  setPublicationState,
  updatePublicationSettings,
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
    id: "sessions",
    label: "Sessions",
    description: "The searchable session list, chrome stripped.",
  },
  {
    id: "speakers",
    label: "Speakers",
    description: "The searchable speaker directory, chrome stripped.",
  },
  {
    id: "gallery",
    label: "Gallery",
    description: "The photo-forward speaker gallery, in surname order.",
  },
  {
    id: "itinerary",
    label: "Itinerary",
    description: "A shared attendee itinerary; append its private plan token to the URL.",
  },
] as const;

/*
 * The optional fields a host page can choose to print on a session card.
 *
 * Selecting none means "all of them", which is what every snippet issued before this
 * option existed asks for — so an embed already pasted into someone's site keeps rendering
 * exactly as it did rather than quietly losing its times.
 */
const EMBED_FIELDS = [
  { id: "time", label: "Times" },
  { id: "room", label: "Room" },
  { id: "track", label: "Track" },
  { id: "format", label: "Format" },
  { id: "abstract", label: "Description" },
  { id: "speakers", label: "Speakers" },
] as const;

interface EmbedConfig {
  track: string;
  accent: string;
  fields: readonly string[];
  bare: boolean;
}

/** The query string a configuration produces; empty when nothing has been chosen. */
function embedQuery(config: EmbedConfig): string {
  const parameters = new URLSearchParams();
  if (config.track) parameters.set("track", config.track);
  if (config.accent) parameters.set("accent", config.accent);
  if (config.fields.length > 0) parameters.set("fields", config.fields.join(","));
  if (config.bare) parameters.set("chrome", "none");
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

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
                  <span className="publishing-sub">
                    {speaker.organization || "no organization"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

const SETTINGS_FIELDS = ["slug", "summary", "venue", "startsOn", "endsOn"] as const;
type SettingsField = (typeof SETTINGS_FIELDS)[number];
type SettingsForm = Record<SettingsField, string>;

/*
 * The public details an organizer types, as opposed to the ones publishing composes from
 * content, the agenda and the CFP.
 *
 * Only *changed* fields are sent, and that is load-bearing rather than an optimisation.
 * The dates shown here are the composed ones, so when the organizer has typed no dates the
 * inputs are displaying values derived from the agenda's first and last slot. Submitting the
 * form wholesale would store those back as though they had been typed, and the public page
 * would silently stop tracking the agenda the first time anyone edited the venue.
 */
function PublicDetailsPanel({
  publication,
  canEdit,
  onSaved,
}: {
  publication: PublicationDto;
  canEdit: boolean;
  onSaved: (next: PublicationDto) => void;
}) {
  const { slug, summary, venue, startsOn, endsOn } = publication.draft.event;
  // Depending on the values rather than on `publication` keeps a recomposed preview that
  // changed nothing from throwing away whatever the organizer is halfway through typing.
  const initial = useMemo<SettingsForm>(
    () => ({ slug, summary, venue, startsOn, endsOn }),
    [slug, summary, venue, startsOn, endsOn],
  );
  const [form, setForm] = useState<SettingsForm>(initial);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [saving, setSaving] = useState(false);
  const feedback = useActionFeedback();
  const { announce } = feedback;

  useEffect(() => {
    setForm(initial);
    setFieldErrors({});
  }, [initial]);

  const changed = SETTINGS_FIELDS.filter((field) => form[field] !== initial[field]);
  const set = (field: SettingsField) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const save = useCallback(async () => {
    setSaving(true);
    setFieldErrors({});
    try {
      const next = await updatePublicationSettings(
        publication.eventId,
        Object.fromEntries(changed.map((field) => [field, form[field]])),
      );
      onSaved(next);
      announce(
        "success",
        publication.state === "published"
          ? "Public details saved to the draft. Publish again to put them on the live page."
          : "Public details saved.",
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: the announcement and the per-field messages are the user-facing
      // failure state. A refusal that names fields is put on those fields, because
      // "already taken" printed above a form of five inputs does not say which one.
      const fields =
        reason instanceof PublicationApiError ? reason.envelope.error.fieldErrors : undefined;
      if (fields)
        setFieldErrors(
          Object.fromEntries(
            SETTINGS_FIELDS.filter((field) => fields[field]?.length).map((field) => [
              field,
              fields[field]?.join(" ") ?? "",
            ]),
          ),
        );
      announce("error", describe(reason, "The public details could not be saved."));
    } finally {
      setSaving(false);
    }
  }, [announce, changed, form, onSaved, publication.eventId, publication.state]);

  const describedBy = (field: SettingsField) =>
    fieldErrors[field] ? `settings-${field}-error` : undefined;
  const fieldError = (field: SettingsField) =>
    fieldErrors[field] ? (
      <p className="publishing-field-error" id={`settings-${field}-error`}>
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <Card
      labelledBy="publishing-details"
      title="Public details"
      hint="What the public page says about the event itself. Saved to the draft, never straight to the live page."
    >
      <form
        className="publishing-details"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          // ERROR-INTENT: handlers cannot await; save announces both outcomes.
          void save();
        }}
      >
        <div className="field">
          <label htmlFor="settings-summary">Summary</label>
          <textarea
            id="settings-summary"
            rows={3}
            maxLength={2000}
            disabled={!canEdit}
            value={form.summary}
            aria-describedby={describedBy("summary")}
            onChange={(changeEvent) => set("summary")(changeEvent.target.value)}
            placeholder="One paragraph describing the event to someone who has never heard of it."
          />
          {fieldError("summary")}
        </div>

        <div className="field">
          <label htmlFor="settings-venue">Venue</label>
          <input
            id="settings-venue"
            maxLength={200}
            disabled={!canEdit}
            value={form.venue}
            aria-describedby={describedBy("venue")}
            onChange={(changeEvent) => set("venue")(changeEvent.target.value)}
            placeholder="Harbor Conference Center, Oakland"
          />
          {fieldError("venue")}
        </div>

        <div className="publishing-details-dates">
          <div className="field">
            <label htmlFor="settings-startsOn">First day</label>
            <input
              id="settings-startsOn"
              type="date"
              disabled={!canEdit}
              value={form.startsOn}
              aria-describedby={describedBy("startsOn")}
              onChange={(changeEvent) => set("startsOn")(changeEvent.target.value)}
            />
            {fieldError("startsOn")}
          </div>
          <div className="field">
            <label htmlFor="settings-endsOn">Last day</label>
            <input
              id="settings-endsOn"
              type="date"
              disabled={!canEdit}
              value={form.endsOn}
              aria-describedby={describedBy("endsOn")}
              onChange={(changeEvent) => set("endsOn")(changeEvent.target.value)}
            />
            {fieldError("endsOn")}
          </div>
        </div>
        <p className="publishing-sub">
          Leave both dates empty and the public page follows the agenda, showing the first and last
          day anything is scheduled. Typing a date pins it.
        </p>

        <div className="field">
          <label htmlFor="settings-slug">Public address</label>
          <input
            id="settings-slug"
            maxLength={120}
            disabled={!canEdit}
            value={form.slug}
            aria-describedby={describedBy("slug")}
            onChange={(changeEvent) => set("slug")(changeEvent.target.value)}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
          {fieldError("slug")}
          <p className="publishing-sub">
            <code>/events/{form.slug || "…"}</code>
            {publication.state === "published" && form.slug !== initial.slug
              ? " — visitors keep reaching the current address until you publish again."
              : " — lowercase words separated by hyphens."}
          </p>
        </div>

        <div className="toolbar">
          <button type="submit" disabled={!canEdit || saving || changed.length === 0}>
            {saving ? "Saving…" : "Save public details"}
          </button>
          {changed.length > 0 && !saving ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setForm(initial);
                setFieldErrors({});
              }}
            >
              Discard changes
            </button>
          ) : null}
        </div>
        {feedback.node}
        {canEdit ? null : (
          <p className="publishing-sub">
            Your role on this event can read the public details but not change them.
          </p>
        )}
      </form>
    </Card>
  );
}

type Embed = {
  id: string;
  label: string;
  description: string;
  path: string;
  url: string;
  snippet: string;
};

/** How long the button itself reads "Copied" before returning to its normal label. */
const COPIED_MS = 2000;

/*
 * One embed view, and the reason it is a component rather than a loop body: it owns the
 * feedback for its own two buttons.
 *
 * These buttons sit at the bottom of a long page. Announcing into the panel's shared live
 * region put every confirmation — and, worse, every "copying was blocked" failure — inside
 * the Publication card at the top, ~970px above the pointer and off screen, so a copy that
 * silently failed looked exactly like one that worked. Each section therefore announces
 * under its own toolbar, and the click also changes the button under the pointer, which is
 * the part a sighted organizer actually reads.
 */
function EmbedPanel({ embed, isLive }: { embed: Embed; isLive: boolean }) {
  const feedback = useActionFeedback();
  const { announce } = feedback;
  const [copied, setCopied] = useState<"snippet" | "url" | null>(null);
  const snippetRef = useRef<HTMLTextAreaElement>(null);
  const revert = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(revert.current), []);

  const copy = useCallback(
    async (kind: "snippet" | "url") => {
      const what = `${embed.label} embed ${kind === "snippet" ? "snippet" : "URL"}`;
      try {
        await navigator.clipboard.writeText(kind === "snippet" ? embed.snippet : embed.url);
        clearTimeout(revert.current);
        setCopied(kind);
        revert.current = setTimeout(() => setCopied(null), COPIED_MS);
        announce("success", `${what} copied to the clipboard.`);
      } catch {
        // ERROR-INTENT: clipboard access is refused outside a secure context and by a
        // denied permission. The announcement is the user-facing failure state; the
        // button must not be left reading "Copied", and the refusal is only actionable
        // if the text is ready to copy by hand, so the snippet field is selected for it.
        clearTimeout(revert.current);
        setCopied(null);
        if (kind === "snippet") snippetRef.current?.focus();
        announce(
          "error",
          kind === "snippet"
            ? `Copying was blocked by the browser. The ${what} is selected below — copy it by hand.`
            : `Copying was blocked by the browser. Select the ${what} printed above and copy it.`,
        );
      }
    },
    [announce, embed.label, embed.snippet, embed.url],
  );

  return (
    <section className="publishing-embed" aria-labelledby={`embed-${embed.id}`}>
      <div className="publishing-embed-head">
        <h3 id={`embed-${embed.id}`}>{embed.label}</h3>
        <p className="publishing-sub">{embed.description}</p>
      </div>

      <p className="publishing-url">
        {isLive ? (
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
          ref={snippetRef}
          className="publishing-snippet"
          readOnly
          rows={3}
          value={embed.snippet}
          onFocus={(focusEvent) => focusEvent.currentTarget.select()}
        />
      </div>

      <div className="toolbar">
        {/* Both views offer the same two controls, so the visible label alone would give a
            screen reader two identical "Copy snippet" buttons with nothing to tell them
            apart. The accessible name starts with the visible text so voice control still
            matches it — including while the button reads "Copied". */}
        <button
          type="button"
          className="secondary"
          aria-label={
            copied === "snippet"
              ? `Copied the ${embed.label} embed snippet`
              : `Copy snippet for the ${embed.label} embed`
          }
          onClick={() => {
            // ERROR-INTENT: handlers cannot await; copy announces both outcomes.
            void copy("snippet");
          }}
        >
          {copied === "snippet" ? <IconCheck size={15} /> : <IconLink size={15} />}
          {copied === "snippet" ? "Copied" : "Copy snippet"}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={
            copied === "url"
              ? `Copied the ${embed.label} embed URL`
              : `Copy URL for the ${embed.label} embed`
          }
          onClick={() => {
            // ERROR-INTENT: handlers cannot await; copy announces both outcomes.
            void copy("url");
          }}
        >
          {copied === "url" ? <IconCheck size={15} /> : null}
          {copied === "url" ? "Copied" : "Copy URL"}
        </button>
      </div>

      {/* Always mounted, directly under the two buttons that write to it: a live region
          that appears with its first message is one assistive technology commonly
          misses, and a message that appears elsewhere is one everybody misses. */}
      {feedback.node}

      {isLive ? (
        <div className="publishing-frame">
          <iframe src={embed.path} title={`${embed.label} embed preview`} loading="lazy" />
        </div>
      ) : (
        <EmptyState title="No live embed yet" icon={<IconGlobe size={20} />}>
          Publish the event and this frame renders the real embed, exactly as a host page would
          receive it.
        </EmptyState>
      )}
    </section>
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
  // The embed configuration is the organizer's composing state, not the publication's:
  // changing it rewrites the snippets on screen and touches nothing on the server.
  const [embedConfig, setEmbedConfig] = useState<EmbedConfig>({
    track: "",
    accent: "",
    fields: [],
    bare: false,
  });
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
            ? "Published. Accepted schedule, content, and CFP publications now refresh every public surface automatically."
            : "Unpublished. The public page, feed, and embeds now return the not-published response.",
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

  const model = useMemo(() => {
    if (!publication) return null;
    const published = publication.published;
    const siteHref = `/events/${publication.slug}`;
    return {
      published,
      isLive: publication.state === "published" && published !== null,
      siteHref,
      siteUrl: absolute(siteHref),
      apiHref: `/api/public/events/${publication.slug}`,
      apiUrl: absolute(`/api/public/events/${publication.slug}`),
      draftPrint: fingerprint(publication.draft),
      publishedPrint: fingerprint(published),
      changed: changedAreas(publication.draft, published),
      tracks: [
        ...new Set(publication.draft.sessions.map((session) => session.track).filter(Boolean)),
      ].sort(),
      embeds: EMBED_VIEWS.map((view) => {
        const path = `/embed/events/${publication.slug}/${view.id}${embedQuery(embedConfig)}`;
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
  }, [embedConfig, eventName, publication]);

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
            Visitors are being served public projection version {publication.projectionVersion ?? 1}
            , activated on {formatStamp(publication.publishedAt)}. Event or site settings have moved
            ({model.changed.join(", ")}) and need an explicit publish.
          </span>
        </Notice>
      ) : model.isLive ? (
        <Notice tone="info">
          <IconCheck size={15} />
          <span>
            The public projection matches the current sources. Publishing establishes the site;
            later accepted schedule, content, and CFP publications refresh it automatically.
          </span>
        </Notice>
      ) : (
        <Notice tone="info">
          <IconGlobe size={15} />
          <span>
            Nothing is published yet. Preview composes the payload without publishing; Publish
            establishes version one and brings the public page, JSON feed, and embeds online.
          </span>
        </Notice>
      )}

      <PublicDetailsPanel publication={publication} canEdit={canPublish} onSaved={adopt} />

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
        {/*
          One configuration, applied to every snippet below. It is deliberately not stored:
          the whole point of putting the options in the URL is that the host page owns them
          afterwards, so an organizer can hand out two differently configured snippets from
          the same event without this screen having to remember either.
        */}
        <fieldset className="publishing-embed-config">
          <legend>Configure the snippets</legend>
          <div className="publishing-embed-options">
            <div className="field">
              <label htmlFor="embed-track">Limit to one track</label>
              <select
                id="embed-track"
                value={embedConfig.track}
                onChange={(changeEvent) =>
                  setEmbedConfig((current) => ({ ...current, track: changeEvent.target.value }))
                }
              >
                <option value="">Every track</option>
                {model.tracks.map((track) => (
                  <option key={track} value={track}>
                    {track}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="embed-accent">Accent colour</label>
              <input
                id="embed-accent"
                type="color"
                value={embedConfig.accent || "#6257d9"}
                onChange={(changeEvent) =>
                  setEmbedConfig((current) => ({ ...current, accent: changeEvent.target.value }))
                }
              />
              {embedConfig.accent ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => setEmbedConfig((current) => ({ ...current, accent: "" }))}
                >
                  Use the host page's colours
                </button>
              ) : null}
            </div>
          </div>

          <div className="field">
            <span className="publishing-legend">Fields on each session card</span>
            <div className="publishing-embed-fields">
              {EMBED_FIELDS.map((field) => (
                <label key={field.id} className="publishing-check">
                  <input
                    type="checkbox"
                    checked={embedConfig.fields.includes(field.id)}
                    onChange={(changeEvent) =>
                      setEmbedConfig((current) => ({
                        ...current,
                        fields: changeEvent.target.checked
                          ? [...current.fields, field.id]
                          : current.fields.filter((candidate) => candidate !== field.id),
                      }))
                    }
                  />
                  {field.label}
                </label>
              ))}
            </div>
            <p className="publishing-sub">
              {embedConfig.fields.length === 0
                ? "Nothing selected, so the cards print every field."
                : `The cards print only: ${embedConfig.fields.join(", ")}.`}
            </p>
          </div>
        </fieldset>

        <div className="publishing-embeds">
          {model.embeds.map((embed) => (
            <EmbedPanel key={embed.id} embed={embed} isLive={model.isLive} />
          ))}
        </div>
        <div className="publishing-feed">
          <h3>JSON programme feed</h3>
          <p className="publishing-sub">
            The same versioned projection used by the pages and embeds, for native integrations.
          </p>
          <a href={model.apiHref} target="_blank" rel="noreferrer">
            {model.apiUrl}
          </a>
        </div>
      </Card>
    </>
  );
}
