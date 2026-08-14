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

// biome-ignore-all lint/security/noDangerouslySetInnerHtml: the content API returns parser-sanitized markup and hostile-input tests guard this rendering boundary.

import { type FormEvent, useMemo, useRef, useState } from "react";
import {
  addContentComment,
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
  assetVersionGroups,
  SOCIAL_PLATFORMS,
  bytesToBase64,
  type CalendarLinkSession,
  googleCalendarUrl,
  hasCalendarLinks,
  outlookCalendarUrl,
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
  socialLinks: Record<string, string>;
};

/** The session as the add-to-calendar builders read it; unscheduled leaves every field absent. */
function calendarSession(session: Workspace["sessions"][number]): CalendarLinkSession {
  return {
    title: session.title,
    startsAt: session.schedule?.startsAt,
    endsAt: session.schedule?.endsAt,
    location: session.schedule?.location,
  };
}

function profileDraft(profile: SpeakerProfile): ProfileDraft {
  return {
    name: profile.name,
    pronouns: profile.pronouns,
    organization: profile.organization,
    bio: profile.bio,
    // Every platform is a controlled input, so an absent link is "" here and is dropped again
    // on the way out. Leaving them undefined made the boxes uncontrolled on first paint and
    // React then warned on the first keystroke.
    socialLinks: Object.fromEntries(
      SOCIAL_PLATFORMS.map(({ key }) => [key, profile.socialLinks?.[key] ?? ""]),
    ),
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
  /** Per-platform refusals from the server, keyed the way the field errors arrive. */
  const [socialErrors, setSocialErrors] = useState<Record<string, string[]>>({});
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
    setSocialErrors({});
    // Blank means "no link", so an emptied box is sent as an absence rather than as "".
    const socialLinks = Object.fromEntries(
      Object.entries(draft.socialLinks).filter(([, value]) => value.trim()),
    );
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() => updateSpeakerProfile(profile.id, { ...draft, socialLinks })).then((result) => {
      if (!result.ok) {
        // The server names the platform it refused, so the message lands on that box rather
        // than as one sentence over a form with seven inputs in it.
        const fields = contentFieldErrors(result.error);
        setSocialErrors(
          Object.fromEntries(
            SOCIAL_PLATFORMS.flatMap(({ key }) => {
              const messages = fields[`socialLinks.${key}`];
              return messages ? [[key, messages] as const] : [];
            }),
          ),
        );
      }
      profileFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? "Profile saved. Organizers see this version."
          : withReference("Your profile could not be saved.", result.error),
      );
    });
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
    const taskId = String(new FormData(formEvent.currentTarget).get("taskId") ?? "");
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
        ...(taskId ? { taskId } : {}),
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
            {/* Structured rather than a line in the bio: the published programme turns each of
                these into a link with the platform as its accessible name, which it cannot do
                with "@sam on Mastodon" written in prose. */}
            <fieldset className="field profile-form-wide profile-social">
              <legend>Links</legend>
              <p className="hint" id="profile-social-hint">
                Shown on the published programme once an organizer publishes. Leave a box blank to
                remove that link.
              </p>
              {SOCIAL_PLATFORMS.map(({ key, label }) => (
                <div className="field" key={key}>
                  <label htmlFor={`profile-social-${key}`}>{label}</label>
                  <input
                    id={`profile-social-${key}`}
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    value={draft.socialLinks[key] ?? ""}
                    onChange={(changeEvent) =>
                      setDraft({
                        ...draft,
                        socialLinks: { ...draft.socialLinks, [key]: changeEvent.target.value },
                      })
                    }
                    maxLength={300}
                    aria-describedby={
                      socialErrors[key] ? `profile-social-${key}-error` : "profile-social-hint"
                    }
                    aria-invalid={socialErrors[key] ? true : undefined}
                  />
                  {socialErrors[key] ? (
                    <p className="error-text" id={`profile-social-${key}-error`}>
                      {socialErrors[key]?.join(" ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </fieldset>
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
            <label>
              Requested task
              <select name="taskId" defaultValue="">
                <option value="">General upload</option>
                {tasks
                  .filter((task) => task.type === "file-request")
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
              </select>
            </label>
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
              {/* One entry per deliverable rather than per upload. Re-uploading a deck used to
                  render a second row with the same name and the same date, and nothing said
                  which one an organizer would download. */}
              {assetVersionGroups(workspace.assets).map(({ groupId, latest: asset, prior }) => {
                const isPhoto = asset.id === profile.photoAssetId;
                return (
                  <li key={groupId}>
                    <span className="upload-name">
                      {asset.name}
                      <span className="sub">
                        {prior.length
                          ? `Version ${asset.versionNumber ?? 1} · uploaded ${shortDate(asset.uploadedAt)}`
                          : `Uploaded ${shortDate(asset.uploadedAt)}`}
                      </span>
                    </span>
                    <span className="upload-actions">
                      {isPhoto ? <Pill tone="strong">Profile photo</Pill> : null}
                      {prior.length ? <Pill tone="ok">Latest</Pill> : null}
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
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const body = String(new FormData(event.currentTarget).get("body"));
                        // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                        void run(() => addContentComment(asset.id, body));
                      }}
                    >
                      <input
                        name="body"
                        aria-label={`Comment on ${asset.name}`}
                        placeholder="Add a comment"
                        required
                      />
                      <button type="submit" className="ghost small" disabled={busy}>
                        Comment
                      </button>
                    </form>
                    {(workspace.comments ?? [])
                      .filter((comment) => comment.assetId === asset.id)
                      .map((comment) => (
                        <p className="sub" key={comment.id}>
                          <strong>{comment.authorName}</strong> · {shortDateTime(comment.createdAt)}{" "}
                          — {comment.body}
                        </p>
                      ))}
                    {/* Superseded versions stay readable: a speaker who re-uploaded by mistake
                        can still reach what they replaced. */}
                    {prior.length ? (
                      <details className="upload-history">
                        <summary>
                          {prior.length} {plural(prior.length, "earlier version")} of {asset.name}
                        </summary>
                        <ul>
                          {prior.map((old) => (
                            <li key={old.id}>
                              <a href={`/api/speaker-assets/${old.id}`}>
                                Version {old.versionNumber ?? 1}
                              </a>
                              <span className="sub">Uploaded {shortDate(old.uploadedAt)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
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
                    {/*
                     * The brief names three clients, and these are the two that take a URL.
                     * Apple Calendar and everything else use the `.ics` above; an organizer can
                     * also send the invitation, which is the route that reaches a calendar
                     * without the speaker doing anything. Absent for an unscheduled session,
                     * because there is no time to add.
                     */}
                    {hasCalendarLinks(calendarSession(session)) ? (
                      <>
                        <a
                          className="ghost small"
                          href={googleCalendarUrl(calendarSession(session)) ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Google
                          <span className="visually-hidden">
                            {" "}
                            — add {session.title} to Google Calendar
                          </span>
                        </a>
                        <a
                          className="ghost small"
                          href={outlookCalendarUrl(calendarSession(session)) ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Outlook
                          <span className="visually-hidden"> — add {session.title} to Outlook</span>
                        </a>
                      </>
                    ) : null}
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
