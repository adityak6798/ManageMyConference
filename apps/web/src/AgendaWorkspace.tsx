import type { AgendaDraftDto } from "@greenroom/contracts";
import { useEffect, useRef, useState } from "react";
import {
  getAgenda,
  publishAgenda,
  removePlacement,
  saveAgendaResources,
  savePlacement,
  ApiError,
} from "./api/events";

// @spec PRD-AGD-001
export function AgendaWorkspace({
  eventId,
  onError,
}: {
  eventId: string;
  onError: (message: string) => void;
}) {
  const [agenda, setAgenda] = useState<AgendaDraftDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setAgenda(null);
    // ERROR-INTENT: React effects cannot await; failures are rendered by the parent boundary.
    void getAgenda(eventId)
      .then((loaded) => {
        if (active) setAgenda(loaded);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.envelope.error.code === "NOT_FOUND") {
          // ERROR-INTENT: The initialization promise updates this workspace or its visible error.
          void saveAgendaResources(eventId, {
            rooms: [{ id: crypto.randomUUID(), name: "Main room" }],
            tracks: [{ id: crypto.randomUUID(), name: "General", color: "#6257d9" }],
            slots: [],
          })
            .then((loaded) => {
              if (active) setAgenda(loaded);
            })
            .catch(
              (reason: unknown) =>
                active &&
                onError(reason instanceof Error ? reason.message : "Agenda initialization failed."),
            );
          return;
        }
        onError(error instanceof Error ? error.message : "Agenda failed to load.");
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [eventId, onError]);
  if (!agenda)
    return (
      <section>
        <p role="status">Loading agenda…</p>
      </section>
    );
  const placed = new Set(agenda.placements.map(({ sessionId }) => sessionId));
  const conflictPlacements = new Set(
    agenda.conflicts.flatMap(({ placementId, conflictingPlacementId }) => [
      placementId,
      conflictingPlacementId,
    ]),
  );
  async function act(action: () => Promise<AgendaDraftDto>) {
    setBusy(true);
    setPublished(null);
    try {
      const updated = await action();
      if (mounted.current) setAgenda(updated);
    } catch (error) {
      // ERROR-INTENT: The workspace renders this expected API failure through its parent alert.
      if (mounted.current)
        onError(error instanceof Error ? error.message : "Agenda update failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const saveResources = (resources: Pick<AgendaDraftDto, "rooms" | "tracks" | "slots">) =>
    act(() => saveAgendaResources(eventId, resources));
  return (
    <section aria-labelledby="agenda-title">
      <div className="agenda-heading">
        <div>
          <p className="eyebrow">Draft workspace</p>
          <h2 id="agenda-title">Schedule sessions</h2>
        </div>
        <button
          type="button"
          disabled={busy || agenda.conflicts.length > 0}
          onClick={() => {
            setBusy(true);
            // ERROR-INTENT: React event handlers cannot await; publication success/failure is rendered.
            void publishAgenda(eventId)
              .then((schedule) => {
                if (mounted.current) setPublished(`Published version ${schedule.version}`);
              })
              .catch(
                (error: unknown) =>
                  mounted.current &&
                  onError(error instanceof Error ? error.message : "Publication failed."),
              )
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          }}
        >
          Publish schedule
        </button>
      </div>
      {published ? (
        <p role="status" className="success">
          {published}
        </p>
      ) : null}
      {agenda.conflicts.length ? (
        <div className="conflict-panel" role="alert">
          <strong>
            {agenda.conflicts.length} conflict{agenda.conflicts.length === 1 ? "" : "s"} block
            publication
          </strong>
          <ul>
            {agenda.conflicts.map((conflict) => (
              <li
                key={`${conflict.kind}-${conflict.placementId}-${conflict.conflictingPlacementId}-${conflict.resourceId}`}
              >
                {conflict.kind.replaceAll("_", " ").toLowerCase()}: {conflict.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="success">No conflicts. This draft is ready to publish.</p>
      )}
      <details className="resource-editor">
        <summary>Manage rooms, tracks, and times</summary>
        <h3>Rooms</h3>
        {agenda.rooms.map((room) => (
          <div className="resource-row" key={room.id}>
            <span>{room.name}</span>
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("Room name", room.name);
                if (name?.trim())
                  // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                  void saveResources({
                    rooms: agenda.rooms.map((item) =>
                      item.id === room.id ? { ...item, name: name.trim() } : item,
                    ),
                    tracks: agenda.tracks,
                    slots: agenda.slots,
                  });
              }}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources({
                  rooms: agenda.rooms.filter(({ id }) => id !== room.id),
                  tracks: agenda.tracks,
                  slots: agenda.slots,
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources({
              rooms: [
                ...agenda.rooms,
                { id: crypto.randomUUID(), name: `Room ${agenda.rooms.length + 1}` },
              ],
              tracks: agenda.tracks,
              slots: agenda.slots,
            })
          }
        >
          Add room
        </button>
        <h3>Tracks</h3>
        {agenda.tracks.map((track) => (
          <div className="resource-row" key={track.id}>
            <span>{track.name}</span>
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("Track name", track.name);
                if (name?.trim())
                  // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                  void saveResources({
                    rooms: agenda.rooms,
                    tracks: agenda.tracks.map((item) =>
                      item.id === track.id ? { ...item, name: name.trim() } : item,
                    ),
                    slots: agenda.slots,
                  });
              }}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources({
                  rooms: agenda.rooms,
                  tracks: agenda.tracks.filter(({ id }) => id !== track.id),
                  slots: agenda.slots,
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources({
              rooms: agenda.rooms,
              tracks: [
                ...agenda.tracks,
                {
                  id: crypto.randomUUID(),
                  name: `Track ${agenda.tracks.length + 1}`,
                  color: "#6257d9",
                },
              ],
              slots: agenda.slots,
            })
          }
        >
          Add track
        </button>
        <h3>Timeslots</h3>
        {agenda.slots.map((slot) => (
          <div className="resource-row" key={slot.id}>
            <span>
              {slot.startsAt.slice(11, 16)}–{slot.endsAt.slice(11, 16)}
            </span>
            <button
              type="button"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources({
                  rooms: agenda.rooms,
                  tracks: agenda.tracks,
                  slots: agenda.slots.filter(({ id }) => id !== slot.id),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const start = new Date(agenda.slots.at(-1)?.endsAt ?? "2026-09-01T16:00:00.000Z");
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources({
              rooms: agenda.rooms,
              tracks: agenda.tracks,
              slots: [
                ...agenda.slots,
                {
                  id: crypto.randomUUID(),
                  startsAt: start.toISOString(),
                  endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
                },
              ],
            });
          }}
        >
          Add next timeslot
        </button>
      </details>
      <h3>Unscheduled</h3>
      <div className="session-list">
        {agenda.sessions
          .filter(({ id }) => !placed.has(id))
          .map((session) => (
            <article key={session.id}>
              <strong>{session.title}</strong>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const room = agenda.rooms[0],
                    track = agenda.tracks[0],
                    slot = agenda.slots[0];
                  if (!room || !track || !slot) return;
                  // ERROR-INTENT: React event handlers cannot await; act renders failures.
                  void act(() =>
                    savePlacement(eventId, {
                      id: `placement-${session.id}`,
                      sessionId: session.id,
                      roomId: room.id,
                      trackId: track.id,
                      slotId: slot.id,
                    }),
                  );
                }}
              >
                Place in first slot
              </button>
            </article>
          ))}
      </div>
      <h3>Placed sessions</h3>
      <div className="agenda-grid">
        {agenda.placements.map((placement) => (
          <article
            key={placement.id}
            className={conflictPlacements.has(placement.id) ? "placement conflict" : "placement"}
          >
            <strong>{agenda.sessions.find(({ id }) => id === placement.sessionId)?.title}</strong>
            <span>
              {agenda.rooms.find(({ id }) => id === placement.roomId)?.name} ·{" "}
              {agenda.slots.find(({ id }) => id === placement.slotId)?.startsAt.slice(11, 16)}
            </span>
            <label>
              Room
              <select
                value={placement.roomId}
                disabled={busy}
                onChange={(event) => {
                  // ERROR-INTENT: React event handlers cannot await; act renders failures.
                  void act(() =>
                    savePlacement(eventId, { ...placement, roomId: event.target.value }),
                  );
                }}
              >
                {agenda.rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Time
              <select
                value={placement.slotId}
                disabled={busy}
                onChange={(event) => {
                  // ERROR-INTENT: React event handlers cannot await; act renders failures.
                  void act(() =>
                    savePlacement(eventId, { ...placement, slotId: event.target.value }),
                  );
                }}
              >
                {agenda.slots.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.startsAt.slice(11, 16)}–{slot.endsAt.slice(11, 16)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Track
              <select
                value={placement.trackId}
                disabled={busy}
                onChange={(event) => {
                  // ERROR-INTENT: React event handlers cannot await; act renders failures.
                  void act(() =>
                    savePlacement(eventId, { ...placement, trackId: event.target.value }),
                  );
                }}
              >
                {agenda.tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; act renders failures.
                void act(async () => {
                  await removePlacement(eventId, placement.id);
                  return getAgenda(eventId);
                });
              }}
            >
              Remove
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
