/*
 * Sessions & speakers — one component, two audiences.
 *
 * Organizers get a two-pane operations view: the accepted-content table on the left
 * and the people who still owe work on the right. Speakers get a portal that leads
 * with the work assigned to them, because that is the only reason they sign in.
 *
 * Every mutation runs through `run`, which refetches the workspace and reports the
 * outcome through useActionFeedback so the confirmation lands next to the control
 * that caused it instead of at the bottom of the page.
 */

import { type FormEvent, useMemo, useRef, useState } from "react";
import {
  clearSpeakerProfilePhoto,
  completeSpeakerTask,
  contentFieldErrors,
  setSpeakerProfilePhoto,
  updateSpeakerProfile,
  uploadSpeakerAsset,
} from "../api/content";
import "../styles/content.css";
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconInbox,
  IconLink,
  IconSessions,
  IconTask,
} from "../ui/icons";
import { Card, EmptyState, Notice, Pill, Stat, useActionFeedback } from "../ui/primitives";

import {
  bytesToBase64,
  DueStatus,
  daysUntil,
  dueLabel,
  isImageAsset,
  PUBLICATION_LABEL,
  PUBLICATION_TONE,
  photoVisibility,
  plural,
  type Run,
  type SpeakerAsset,
  type SpeakerProfile,
  shortDate,
  shortDateTime,
  type Workspace,
  withReference,
} from "./shared";

type ProfileDraft = {
  name: string;
  pronouns: string;
  organization: string;
  bio: string;
};

function profileDraft(profile: SpeakerProfile): ProfileDraft {
  return {
    name: profile.name,
    pronouns: profile.pronouns,
    organization: profile.organization,
    bio: profile.bio,
  };
}

// This speaker portal intentionally exceeds 400 lines because its profile draft, task completion,
// upload queue, and photo choice are one speaker-scoped state lifecycle. The remaining sections are
// single-use views of that lifecycle, which issue #70 says to keep co-located rather than extract
// by size; reusable content calculations and types are already isolated in shared.tsx.
export function SpeakerView({
  eventId,
  workspace,
  profile,
  busy,
  run,
}: {
  eventId: string;
  workspace: Workspace;
  profile: SpeakerProfile;
  busy: boolean;
  run: Run;
}) {
  const taskFeedback = useActionFeedback();
  const profileFeedback = useActionFeedback();
  const uploadFeedback = useActionFeedback();
  const uploadFormRef = useRef<HTMLFormElement>(null);

  // Re-seed the form whenever the stored profile changes; the previous uncontrolled
  // inputs kept showing the values from first paint even after a save or a refetch.
  const saved = useMemo(() => profileDraft(profile), [profile]);
  const savedSignature = JSON.stringify(saved);
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [syncedTo, setSyncedTo] = useState(savedSignature);
  if (syncedTo !== savedSignature) {
    setSyncedTo(savedSignature);
    setDraft(saved);
  }
  const profileDirty = JSON.stringify(draft) !== savedSignature;

  const now = Date.now();
  const tasks = [...workspace.tasks].sort(
    (left, right) =>
      Number(left.status === "complete") - Number(right.status === "complete") ||
      new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime(),
  );
  const openTasks = tasks.filter(({ status }) => status === "open");
  const overdue = openTasks.filter((task) => daysUntil(task.dueAt, now) < 0).length;
  // A session's time is where the published agenda places it, resolved by the server on every
  // read, so this card and the .ics download can never disagree with the public schedule.
  const scheduled = workspace.sessions.filter((session) => session.schedule);
  // A deleted asset clears the column it was chosen through, so this only ever misses while a
  // refetch is in flight; the card then reads as "no photo yet" rather than breaking.
  const photoAsset = workspace.assets.find(({ id }) => id === profile.photoAssetId);
  const publishableAssets = workspace.assets.filter(
    ({ visibility }) => visibility === "publishable",
  ).length;

  function completeTask(taskId: string, title: string) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() => completeSpeakerTask(eventId, taskId)).then((result) =>
      taskFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `“${title}” marked complete.`
          : withReference("That task could not be completed.", result.error),
      ),
    );
  }

  function saveProfile(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() => updateSpeakerProfile(profile.id, draft)).then((result) =>
      profileFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? "Profile saved. Organizers see this version."
          : withReference("Your profile could not be saved.", result.error),
      ),
    );
  }

  /**
   * Choose, or unchoose, the picture that represents this speaker.
   *
   * The announcement says what happens next as well as what happened, because the answer
   * depends on a decision this speaker does not hold: the photo appears on the programme only
   * once an organizer has marked that same file publishable.
   */
  function chooseProfilePhoto(asset: SpeakerAsset | null) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() =>
      asset ? setSpeakerProfilePhoto(profile.id, asset.id) : clearSpeakerProfilePhoto(profile.id),
    ).then((result) =>
      uploadFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? asset
            ? `“${asset.name}” is now your profile photo. ${photoVisibility(asset)}`
            : "Your profile photo has been removed. The programme shows your initials."
          : withReference(
              contentFieldErrors(result.error).assetId?.[0] ??
                "That file could not be used as your profile photo.",
              result.error,
            ),
      ),
    );
  }

  function upload(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    const input = formEvent.currentTarget.elements.namedItem("asset") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      uploadFeedback.announce("error", "Choose a file before uploading.");
      return;
    }
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(async () => {
      const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      await uploadSpeakerAsset({
        profileId: profile.id,
        name: file.name,
        contentType: file.type as "image/jpeg" | "image/png" | "application/pdf",
        contentBase64,
      });
    }).then((result) => {
      if (result.ok) uploadFormRef.current?.reset();
      uploadFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `${file.name} uploaded privately.`
          : withReference("That file could not be uploaded.", result.error),
      );
    });
  }

  return (
    <div className="content-workspace">
      {(workspace.resources ?? []).length > 0 ? (
        <section aria-labelledby="speaker-resources-heading">
          <h2 id="speaker-resources-heading">Speaker resources</h2>
          <div className="grid-auto">
            {(workspace.resources ?? []).map((resource) => (
              <Card key={resource.id} title={resource.title}>
                <div
                  className="resource-body"
                  dangerouslySetInnerHTML={{ __html: resource.bodyHtml }}
                />
                {resource.embedHtml ? (
                  <iframe
                    title={`${resource.title} embedded reference`}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={resource.embedHtml}
                  />
                ) : null}
              </Card>
            ))}
          </div>
        </section>
      ) : null}
      <dl className="grid-auto">
        <Stat
          label="Tasks to complete"
          value={openTasks.length}
          hint={overdue ? `${overdue} overdue` : "Nothing overdue"}
          icon={<IconTask size={15} />}
          attention={overdue > 0}
        />
        <Stat
          label="Your sessions"
          value={workspace.sessions.length}
          hint={`${scheduled.length} scheduled`}
          icon={<IconSessions size={15} />}
        />
        <Stat
          label="Files uploaded"
          value={workspace.assets.length}
          hint={
            publishableAssets
              ? `${publishableAssets} cleared for the public page`
              : "Private to you and the organizers"
          }
          icon={<IconInbox size={15} />}
        />
      </dl>

      <Card
        labelledBy="speaker-tasks-title"
        title={
          openTasks.length
            ? `${openTasks.length} ${plural(openTasks.length, "task")} to complete`
            : "You’re all caught up"
        }
        hint={
          openTasks.length
            ? "Everything the organizers still need from you, soonest first."
            : "Nothing is outstanding. Organizers will let you know if that changes."
        }
        tight
      >
        <div className="content-feedback">{taskFeedback.node}</div>
        {tasks.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const days = daysUntil(task.dueAt, now);
                  return (
                    <tr key={task.id}>
                      <td className="primary-cell">{task.title}</td>
                      <td>
                        {shortDate(task.dueAt)}
                        <span className="sub">
                          {task.status === "open"
                            ? dueLabel(days)
                            : task.completedAt
                              ? `Completed ${shortDate(task.completedAt)}`
                              : "Completed"}
                        </span>
                      </td>
                      <td>
                        {task.status === "complete" ? (
                          <Pill tone="ok">
                            <IconCheck size={12} />
                            Complete
                          </Pill>
                        ) : (
                          <DueStatus days={days} />
                        )}
                      </td>
                      <td>
                        {/* The control stays mounted once it is spent so the keyboard
                            focus that triggered it is not thrown back to the body. */}
                        <button
                          type="button"
                          className={task.status === "complete" ? "secondary small" : "small"}
                          aria-disabled={busy || task.status === "complete"}
                          onClick={() => {
                            if (task.status === "complete") return;
                            completeTask(task.id, task.title);
                          }}
                        >
                          {task.status === "complete" ? "Completed" : "Mark complete"}
                          <span className="visually-hidden"> — {task.title}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tasks assigned" icon={<IconCheck size={20} />}>
            The organizers have not asked you for anything yet.
          </EmptyState>
        )}
      </Card>

      <div className="split">
        <Card
          labelledBy="speaker-profile-title"
          title="Your public profile"
          hint="This is what appears on the published programme."
        >
          <form className="profile-form" onSubmit={saveProfile}>
            <div className="field">
              <label htmlFor="profile-name">Name</label>
              <input
                id="profile-name"
                value={draft.name}
                onChange={(changeEvent) => setDraft({ ...draft, name: changeEvent.target.value })}
                required
                maxLength={120}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-pronouns">Pronouns</label>
              <input
                id="profile-pronouns"
                value={draft.pronouns}
                onChange={(changeEvent) =>
                  setDraft({ ...draft, pronouns: changeEvent.target.value })
                }
                maxLength={40}
              />
            </div>
            <div className="field profile-form-wide">
              <label htmlFor="profile-organization">Organization</label>
              <input
                id="profile-organization"
                value={draft.organization}
                onChange={(changeEvent) =>
                  setDraft({ ...draft, organization: changeEvent.target.value })
                }
                maxLength={120}
              />
            </div>
            <div className="field profile-form-wide">
              <label htmlFor="profile-bio">Bio</label>
              <textarea
                id="profile-bio"
                value={draft.bio}
                onChange={(changeEvent) => setDraft({ ...draft, bio: changeEvent.target.value })}
                maxLength={2000}
                aria-describedby="profile-bio-hint"
              />
              <p className="hint" id="profile-bio-hint">
                {draft.bio.length} of 2000 characters.
              </p>
            </div>
            <div className="profile-form-actions profile-form-wide">
              <button type="submit" aria-disabled={busy}>
                {busy ? "Saving…" : "Save profile"}
              </button>
              {profileDirty ? <span className="hint">Unsaved changes</span> : null}
            </div>
            {profileFeedback.node}
          </form>
        </Card>

        <Card
          labelledBy="speaker-uploads-title"
          title="Private uploads"
          hint="Headshots, slides, and handouts."
        >
          <Notice>
            Files stay private to you and the organizers until an organizer explicitly marks them
            publishable.
          </Notice>
          <form className="upload-form" ref={uploadFormRef} onSubmit={upload}>
            <div className="field">
              <label htmlFor="speaker-asset">Speaker asset</label>
              <input
                id="speaker-asset"
                name="asset"
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                required
                aria-describedby="speaker-asset-hint"
              />
              <p className="hint" id="speaker-asset-hint">
                PNG, JPEG, or PDF.
              </p>
            </div>
            <button type="submit" aria-disabled={busy}>
              {busy ? "Uploading…" : "Upload asset"}
            </button>
          </form>
          {uploadFeedback.node}
          {/* The headshot, and one plain sentence about who can see it. The photo used to be
              unreachable from here entirely: the column existed, the public projection read
              it, and nothing in the product could ever write it. */}
          <div className="photo-status">
            {photoAsset ? (
              <>
                <img
                  className="photo-preview"
                  src={`/api/speaker-assets/${photoAsset.id}`}
                  alt={`Your profile photo, ${photoAsset.name}`}
                />
                <p>
                  <strong>{photoAsset.name}</strong> is your profile photo.{" "}
                  {photoVisibility(photoAsset)}
                </p>
              </>
            ) : (
              <p className="hint">
                You have no profile photo. Upload a PNG or JPEG and choose “Use as profile photo”;
                the published programme shows your initials until you do.
              </p>
            )}
          </div>
          {workspace.assets.length ? (
            <ul className="upload-list">
              {workspace.assets.map((asset) => {
                const isPhoto = asset.id === profile.photoAssetId;
                return (
                  <li key={asset.id}>
                    <span className="upload-name">
                      {asset.name}
                      <span className="sub">Uploaded {shortDate(asset.uploadedAt)}</span>
                    </span>
                    <span className="upload-actions">
                      {isPhoto ? <Pill tone="strong">Profile photo</Pill> : null}
                      <Pill tone={asset.visibility === "publishable" ? "ok" : "neutral"}>
                        {asset.visibility === "publishable" ? "Publishable" : "Private"}
                      </Pill>
                      {/* Offered only for images, which is the rule the server enforces:
                          nominating a slide deck is refused, so it is never invited. */}
                      {isImageAsset(asset) ? (
                        <button
                          type="button"
                          className="ghost small"
                          aria-disabled={busy}
                          onClick={() => chooseProfilePhoto(isPhoto ? null : asset)}
                        >
                          {isPhoto ? "Remove profile photo" : "Use as profile photo"}
                          <span className="visually-hidden"> — {asset.name}</span>
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="hint upload-empty">No files stored yet.</p>
          )}
        </Card>
      </div>

      <Card
        labelledBy="speaker-sessions-title"
        title="Your sessions"
        hint="Times are shown in your device's timezone."
        actions={
          // A calendar with no VEVENT is not a calendar: the export answers 404 until at
          // least one session is scheduled, so the link is not offered before then.
          scheduled.length ? (
            <a className="download" href={`/api/events/${eventId}/speaker-calendar.ics`} download>
              <IconCalendar size={15} />
              Download calendar (.ics)
            </a>
          ) : (
            <span className="hint">Downloadable once the published schedule places a session.</span>
          )
        }
        tight
      >
        {workspace.sessions.length ? (
          <ul className="plain-list">
            {workspace.sessions.map((session) => (
              <li key={session.id}>
                <div className="session-line">
                  <span>
                    <strong>{session.title}</strong>
                    <span className="sub">
                      {session.schedule
                        ? `${shortDateTime(session.schedule.startsAt)} · ${session.schedule.location}`
                        : "Not on the published schedule yet — this fills in when organizers publish the agenda"}
                    </span>
                  </span>
                  <span className="session-line-meta">
                    {session.schedule ? null : (
                      <Pill tone="warn">
                        <IconClock size={12} />
                        Unscheduled
                      </Pill>
                    )}
                    <Pill tone={PUBLICATION_TONE[session.publicationState]}>
                      {PUBLICATION_LABEL[session.publicationState]}
                    </Pill>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No sessions linked yet" icon={<IconLink size={20} />}>
            Once a proposal of yours is accepted it will appear here with its schedule.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

/* =============================== container ================================= */
