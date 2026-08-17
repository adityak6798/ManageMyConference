/**
 * Reusable event templates: save an event's configuration, and clone it into another.
 *
 * Owned by the `events` domain. @spec PRD-EVT-002 ARC-FLOW-006
 */
import type { EventDto } from "@greenroom/contracts";
import { type FormEvent, useState } from "react";
import { type ApiFailure, describeApiFailure } from "../api/config";
import { ApiError, updateEvent } from "../api/events";
import { EventTemplatesWorkspace } from "../events/EventTemplatesWorkspace";
import { TimezoneField } from "../events/TimezoneField";
import { IconCopy } from "../ui/icons";
import { Notice, Section, useActionFeedback } from "../ui/primitives";
import type { HubTabModule, WorkspaceModule } from "./contract";

export const eventTemplatesWorkspace: WorkspaceModule = {
  domain: "events",
  path: "/event-templates",
  label: "Event templates",
  group: "reach",
  /** 60–69 is this lane's band, which puts templates after the surfaces they configure. */
  order: 60,
  icon: <IconCopy />,
  personas: ["organizer"],
  /**
   * Two conditions the browser can check, and one it deliberately cannot.
   *
   * `events:settings:read` is the *event-scoped* grant previewing needs, so an organizer of
   * another event cannot mount this from a stale context; membership of at least one
   * organization is what makes a template library addressable at all. Whether this event's
   * organization is one the account belongs to is the server's question — it needs
   * event-to-organization data the session does not carry — so the workspace mounts and
   * renders the server's refusal rather than guessing at it.
   */
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("events:settings:read") && (session?.organizations.length ?? 0) > 0,
  header: ({ event }) => ({
    eyebrow: "Settings",
    title: "Event templates",
    subtitle: `Save a configuration once, then clone it into ${event.name} category by category.`,
  }),
  render: ({ event, session, capabilities }) => (
    <EventTemplatesWorkspace
      key={`${event.id}:${session?.actor.id}`}
      organizationId={event.organizationId}
      eventId={event.id}
      eventName={event.name}
      canApply={capabilities.includes("events:settings:update")}
      canAuthor={Boolean(session?.capabilities.includes("events:create"))}
    />
  ),
};

export const eventTemplatesHubTab: HubTabModule = {
  domain: "events",
  hub: "settings",
  tab: "templates",
  label: "Templates",
  order: 50,
  personas: ["organizer"],
  legacyPaths: ["/event-templates"],
  canAccess: (access) => eventTemplatesWorkspace.canAccess?.(access) ?? false,
  header: eventTemplatesWorkspace.header,
  render: eventTemplatesWorkspace.render,
};

function EventSettings({
  eventId,
  name: initialName,
  timezone: initialTimezone,
  onEventChanged,
}: {
  eventId: string;
  name: string;
  timezone: string;
  onEventChanged: (event: EventDto) => void;
}) {
  const [name, setName] = useState(initialName);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [timezoneErrors, setTimezoneErrors] = useState<string[]>([]);
  /** Kept whole rather than glued into a sentence, so the reference stays selectable. */
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const feedback = useActionFeedback();

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setTimezoneErrors([]);
    setFailure(null);
    try {
      const updated = await updateEvent(eventId, { name, timezone });
      setName(updated.name);
      // The server canonicalizes, so the control shows the id that was actually stored rather
      // than the alias that was sent.
      setTimezone(updated.timezone);
      // The shell holds the event list every other surface reads the name from — the topbar
      // chip, this page's own header. Without this the save succeeded and nothing on screen
      // changed, which is indistinguishable from a save that did not happen.
      onEventChanged(updated);
      feedback.announce("success", "Event settings saved.");
    } catch (reason) {
      // ERROR-INTENT: rendered as this form's own refusal, beside the control that caused it.
      if (reason instanceof ApiError)
        // A refusal the server attached to a field belongs on that field.
        setTimezoneErrors(reason.envelope.error.fieldErrors?.timezone ?? []);
      setFailure(describeApiFailure(reason, "Event settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
     * A region, not a card. Two settings and a save are the whole of this tab, so a bordered box
     * around them framed the page inside the page and put a second border around every field it
     * held. The heading and the space under it are the structure.
     */
    <Section
      labelledBy="hub-event-details"
      title="Event details"
      description="These two values are read by every other surface in the console."
    >
      {feedback.node}
      <form className="stack event-settings-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="hub-event-name">Event name</label>
          {/* Every setting on this tab says what changing it does. The timezone field has
              carried its consequence since it was written; the name was left to be guessed at. */}
          <p className="hint" id="hub-event-name-hint">
            The name speakers, reviewers and visitors see — on the public site, in every invitation,
            and on each calendar invite.
          </p>
          <input
            id="hub-event-name"
            className="control"
            aria-describedby="hub-event-name-hint"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
          {!name.trim() ? (
            /* On the field it is about, not in a banner above the form: a page-level warning
               for one empty input asks the reader to work out which input it means. */
            <p className="error-text">An event name is required.</p>
          ) : null}
        </div>
        <TimezoneField
          id="hub-event-timezone"
          value={timezone}
          onChange={setTimezone}
          errors={timezoneErrors}
          disabled={busy}
        />
        {failure ? (
          <Notice tone="error" reference={failure.reference}>
            {failure.message}
          </Notice>
        ) : null}
        <div className="toolbar">
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save event settings"}
          </button>
        </div>
      </form>
    </Section>
  );
}

/** Event-owned contribution to Settings; behavior remains governed by the file's event specs. */
export const eventSettingsHubTab: HubTabModule = {
  domain: "events",
  hub: "settings",
  tab: "event",
  label: "Event",
  order: 10,
  personas: ["organizer"],
  legacyPaths: ["/settings"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:update"),
  header: ({ event }) => ({
    eyebrow: "Settings",
    title: "Event",
    subtitle: `${event.name} · ${event.timezone}`,
  }),
  render: ({ event, onEventChanged }) => (
    <EventSettings
      key={event.id}
      eventId={event.id}
      name={event.name}
      timezone={event.timezone}
      onEventChanged={onEventChanged}
    />
  ),
};
