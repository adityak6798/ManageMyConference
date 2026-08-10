import type { ContentWorkspaceDto, UpdateContentSessionInput } from "@greenroom/contracts";
import { type FormEvent, useEffect, useState } from "react";
import {
  acceptContent,
  completeSpeakerTask,
  getContent,
  publishSpeakerAsset,
  recordSpeakerMessage,
  requestSpeakerTask,
  updateContentSession,
  updateSpeakerProfile,
  uploadSpeakerAsset,
} from "./api/events";

interface Props {
  eventId: string;
  role: "organizer" | "speaker";
  onError: (error: unknown) => void;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function OrganizerSessionEditor({
  session,
  speakers,
  busy,
  onSave,
}: {
  session: ContentWorkspaceDto["sessions"][number];
  speakers: ContentWorkspaceDto["speakers"];
  busy: boolean;
  onSave: (input: UpdateContentSessionInput) => Promise<unknown>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const list = (name: string) =>
      String(data.get(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    // ERROR-INTENT: React handlers cannot await; the parent run helper renders failures.
    void onSave({
      title: String(data.get("title")),
      abstract: String(data.get("abstract")),
      format: String(data.get("format")),
      speakerProfileIds: data.getAll("speakers").map(String),
      tags: list("tags"),
      tracks: list("tracks"),
      publicationState: String(
        data.get("publicationState"),
      ) as UpdateContentSessionInput["publicationState"],
    });
  }
  return (
    <article className="content-card">
      <form onSubmit={submit}>
        <label>
          Session title
          <input name="title" defaultValue={session.title} required />
        </label>
        <label>
          Abstract
          <textarea name="abstract" defaultValue={session.abstract} required />
        </label>
        <label>
          Format
          <input name="format" defaultValue={session.format} required />
        </label>
        <label>
          Tags
          <input name="tags" defaultValue={session.tags.join(", ")} />
        </label>
        <label>
          Tracks
          <input name="tracks" defaultValue={session.tracks.join(", ")} />
        </label>
        <fieldset>
          <legend>Speakers</legend>
          {speakers.map((speaker) => (
            <label className="check-label" key={speaker.id}>
              <input
                type="checkbox"
                name="speakers"
                value={speaker.id}
                defaultChecked={session.speakerProfileIds.includes(speaker.id)}
              />
              {speaker.name}
            </label>
          ))}
        </fieldset>
        <label>
          Publication readiness
          <select name="publicationState" defaultValue={session.publicationState}>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="published">Published</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Save session
        </button>
      </form>
    </article>
  );
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export function ContentWorkspace({ eventId, role, onError }: Props) {
  const [workspace, setWorkspace] = useState<ContentWorkspaceDto | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached handler renders the failure.
    void getContent(eventId).then(setWorkspace).catch(onError);
  }, [eventId, onError]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setWorkspace(await getContent(eventId));
    } catch (error) {
      // ERROR-INTENT: The parent shell renders the normalized API failure with its correlation ID.
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  if (!workspace)
    return (
      <section>
        <p role="status">Loading content workspace…</p>
      </section>
    );
  const profile = workspace.speakers[0];
  if (role === "organizer")
    return (
      <section id="speaker-tasks" aria-labelledby="content-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Accepted content</p>
            <h2 id="content-title">Sessions & speakers</h2>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              // ERROR-INTENT: React event handlers cannot await; run renders failures and clears busy state.
              void run(() =>
                acceptContent(eventId, {
                  proposalId: "demo-accepted-proposal",
                  title: "A newly accepted session",
                  abstract: "Accepted once and linked without duplicate entry.",
                  format: "Talk",
                  tags: ["community"],
                  tracks: ["Main"],
                  speakers: [
                    {
                      userId: "seed-speaker",
                      sourcePersonId: "proposal-person-sam",
                      name: "Sam Speaker",
                      email: "sam@example.test",
                    },
                  ],
                }),
              );
            }}
          >
            Accept demo proposal
          </button>
        </div>
        <div className="metric-row">
          <span>
            <strong>{workspace.sessions.length}</strong> sessions
          </span>
          <span>
            <strong>{workspace.speakers.length}</strong> speakers
          </span>
          <span>
            <strong>{workspace.tasks.filter(({ status }) => status === "open").length}</strong> open
            tasks
          </span>
        </div>
        {workspace.speakers[0] ? (
          <div className="persona-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                /* ERROR-INTENT: React handlers cannot await; run renders failures. */ void run(
                  () =>
                    requestSpeakerTask({
                      profileId: workspace.speakers[0]?.id ?? "",
                      title: "Upload final presentation",
                      dueAt: "2026-09-01T23:59:00.000Z",
                    }),
                );
              }}
            >
              Request presentation asset
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                /* ERROR-INTENT: React handlers cannot await; run renders failures. */ void run(
                  () =>
                    recordSpeakerMessage({
                      profileId: workspace.speakers[0]?.id ?? "",
                      subject: "Speaker preparation reminder sent",
                    }),
                );
              }}
            >
              Record communication
            </button>
          </div>
        ) : null}
        {workspace.sessions.map((session) => (
          <OrganizerSessionEditor
            key={session.id}
            session={session}
            speakers={workspace.speakers}
            busy={busy}
            onSave={(input) => run(() => updateContentSession(session.id, input))}
          />
        ))}
        <h3>Speaker assets</h3>
        {workspace.assets.length ? (
          workspace.assets.map((asset) => (
            <div className="task-row" key={asset.id}>
              <span>
                {asset.name} · {asset.visibility}
              </span>
              <button
                type="button"
                disabled={busy || asset.visibility === "publishable"}
                onClick={() => {
                  /* ERROR-INTENT: React handlers cannot await; run renders failures. */ void run(
                    () => publishSpeakerAsset(asset.id),
                  );
                }}
              >
                {asset.visibility === "publishable" ? "Publishable" : "Mark publishable"}
              </button>
            </div>
          ))
        ) : (
          <p className="empty">No speaker assets uploaded.</p>
        )}
        <h3>Communication history</h3>
        {workspace.messages.length ? (
          workspace.messages.map((message) => (
            <p key={message.id}>
              {message.subject} · <time>{new Date(message.sentAt).toLocaleDateString()}</time>
            </p>
          ))
        ) : (
          <p className="empty">No messages recorded yet.</p>
        )}
      </section>
    );
  if (!profile)
    return (
      <section>
        <h2>Speaker portal</h2>
        <p className="empty">No speaker profile is linked to this identity and event.</p>
      </section>
    );
  const speakerProfile = profile;
  const openTasks = workspace.tasks.filter(({ status }) => status === "open");
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(() =>
      updateSpeakerProfile(speakerProfile.id, {
        name: String(data.get("name")),
        bio: String(data.get("bio")),
        pronouns: String(data.get("pronouns")),
        organization: String(data.get("organization")),
      }),
    );
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("asset") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await run(async () => {
      const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      await uploadSpeakerAsset({
        profileId: speakerProfile.id,
        name: file.name,
        contentType: file.type as "image/jpeg" | "image/png" | "application/pdf",
        contentBase64,
      });
    });
  }
  return (
    <>
      <section id="speaker-tasks">
        <p className="eyebrow">Your next actions</p>
        <h2>
          {openTasks.length ? `${openTasks.length} tasks to complete` : "You’re all caught up"}
        </h2>
        {workspace.tasks.map((task) => (
          <article className="task-row" key={task.id}>
            <div>
              <strong>{task.title}</strong>
              <small>Due {new Date(task.dueAt).toLocaleDateString()}</small>
            </div>
            <button
              type="button"
              disabled={busy || task.status === "complete"}
              onClick={() => {
                // ERROR-INTENT: React event handlers cannot await; run renders failures and clears busy state.
                void run(() => completeSpeakerTask(eventId, task.id));
              }}
            >
              {task.status === "complete" ? "Completed" : "Mark complete"}
            </button>
          </article>
        ))}
      </section>
      <section>
        <h2>Profile preview</h2>
        <form
          onSubmit={(event) => {
            // ERROR-INTENT: React event handlers cannot await; saveProfile delegates failures to run.
            void saveProfile(event);
          }}
        >
          <label>
            Name
            <input name="name" defaultValue={speakerProfile.name} required />
          </label>
          <label>
            Pronouns
            <input name="pronouns" defaultValue={speakerProfile.pronouns} />
          </label>
          <label>
            Organization
            <input name="organization" defaultValue={speakerProfile.organization} />
          </label>
          <label>
            Bio
            <textarea name="bio" defaultValue={speakerProfile.bio} maxLength={2000} />
          </label>
          <button type="submit" disabled={busy}>
            Save profile
          </button>
        </form>
      </section>
      <section>
        <h2>Private uploads</h2>
        <p>Uploads stay private until an organizer explicitly marks them publishable.</p>
        <form
          onSubmit={(event) => {
            // ERROR-INTENT: React event handlers cannot await; upload delegates failures to run.
            void upload(event);
          }}
        >
          <input
            aria-label="Speaker asset"
            name="asset"
            type="file"
            accept="image/png,image/jpeg,application/pdf"
            required
          />
          <button type="submit" disabled={busy}>
            Upload asset
          </button>
        </form>
        <p>{workspace.assets.length} asset(s) securely stored.</p>
      </section>
      <section>
        <h2>Your sessions</h2>
        {workspace.sessions.map((session) => (
          <article className="content-card" key={session.id}>
            <h3>{session.title}</h3>
            <p>
              {session.schedule
                ? `${new Date(session.schedule.startsAt).toLocaleString()} · ${session.schedule.location}`
                : "Schedule pending"}
            </p>
          </article>
        ))}
        <a className="download" href={`/api/events/${eventId}/speaker-calendar.ics`} download>
          Download calendar (.ics)
        </a>
      </section>
    </>
  );
}
