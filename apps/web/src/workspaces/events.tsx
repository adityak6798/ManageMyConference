/**
 * Reusable event templates: save an event's configuration, and clone it into another.
 *
 * Owned by the `events` domain. @spec PRD-EVT-002 ARC-FLOW-006
 */
import { type FormEvent, useState } from "react";
import { ApiError, updateEvent } from "../api/events";
import { EventTemplatesWorkspace } from "../events/EventTemplatesWorkspace";
import { TimezoneField } from "../events/TimezoneField";
import { IconInbox } from "../ui/icons";
import { Card, Notice, useActionFeedback } from "../ui/primitives";
import type { HubTabModule, WorkspaceModule } from "./contract";

export const eventTemplatesWorkspace: WorkspaceModule = {
  domain: "events",
  path: "/event-templates",
  label: "Event templates",
  group: "Audience",
  /** 60–69 is this lane's band, which puts templates after the surfaces they configure. */
  order: 60,
  icon: <IconInbox size={16} />,
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
    eyebrow: "Audience",
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
}: {
  eventId: string;
  name: string;
  timezone: string;
}) {
  const [name, setName] = useState(initialName);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [timezoneErrors, setTimezoneErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const feedback = useActionFeedback();

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setTimezoneErrors([]);
    try {
      const updated = await updateEvent(eventId, { name, timezone });
      setName(updated.name);
      setTimezone(updated.timezone);
      feedback.announce("success", "Event settings saved.");
    } catch (reason) {
      if (reason instanceof ApiError) {
        setTimezoneErrors(reason.envelope.error.fieldErrors?.timezone ?? []);
        feedback.announce(
          "error",
          `${reason.message} Reference: ${reason.envelope.error.correlationId}`,
        );
      } else feedback.announce("error", "Event settings could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Event details" hint="These values drive the organizer and attendee experience.">
      {feedback.node}
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="hub-event-name">Event name</label>
          <input
            id="hub-event-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
        </div>
        <TimezoneField
          id="hub-event-timezone"
          value={timezone}
          onChange={setTimezone}
          errors={timezoneErrors}
          disabled={busy}
        />
        {!name.trim() ? <Notice tone="warn">An event name is required.</Notice> : null}
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save event settings"}
        </button>
      </form>
    </Card>
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
  render: ({ event }) => (
    <EventSettings key={event.id} eventId={event.id} name={event.name} timezone={event.timezone} />
  ),
};
