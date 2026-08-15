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

import type { UpdateContentSessionInput } from "@greenroom/contracts";
import { type FormEvent, useMemo, useState } from "react";
import "../styles/content.css";

import {
  type ContentSession,
  commaList,
  type PublicationState,
  type SessionDraft,
  type SpeakerProfile,
  sessionDraft,
} from "./shared";
export function SessionEditor({
  session,
  speakers,
  busy,
  onSave,
  onClose,
}: {
  session: ContentSession;
  speakers: SpeakerProfile[];
  busy: boolean;
  onSave: (input: UpdateContentSessionInput) => void;
  onClose: () => void;
}) {
  // Controlled fields, re-seeded whenever the saved session changes. The previous
  // uncontrolled form silently kept stale values after any refetch.
  const saved = useMemo(() => sessionDraft(session), [session]);
  const savedSignature = JSON.stringify(saved);
  const [draft, setDraft] = useState<SessionDraft>(saved);
  const [syncedTo, setSyncedTo] = useState(savedSignature);
  if (syncedTo !== savedSignature) {
    setSyncedTo(savedSignature);
    setDraft(saved);
  }
  const dirty = JSON.stringify(draft) !== savedSignature;
  const field = (name: string) => `session-${session.id}-${name}`;

  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    const next = {
      title: draft.title,
      abstract: draft.abstract,
      format: draft.format,
      speakerProfileIds: draft.speakerProfileIds,
      tags: commaList(draft.tags),
      tracks: commaList(draft.tracks),
      publicationState: draft.publicationState,
    };
    const savedPayload = {
      ...saved,
      tags: commaList(saved.tags),
      tracks: commaList(saved.tracks),
    };
    const changes = Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(savedPayload[key as keyof typeof savedPayload]),
      ),
    ) as UpdateContentSessionInput;
    if (Object.keys(changes).length) onSave(changes);
  }

  return (
    <form className="session-editor" onSubmit={submit}>
      <div className="field">
        <label htmlFor={field("title")}>Session title</label>
        <input
          id={field("title")}
          value={draft.title}
          onChange={(changeEvent) => setDraft({ ...draft, title: changeEvent.target.value })}
          required
          maxLength={160}
        />
      </div>
      <div className="field session-editor-wide">
        <label htmlFor={field("abstract")}>Abstract</label>
        <textarea
          id={field("abstract")}
          value={draft.abstract}
          onChange={(changeEvent) => setDraft({ ...draft, abstract: changeEvent.target.value })}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={field("format")}>Format</label>
        <input
          id={field("format")}
          value={draft.format}
          onChange={(changeEvent) => setDraft({ ...draft, format: changeEvent.target.value })}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={field("publication")}>Publication readiness</label>
        <select
          id={field("publication")}
          value={draft.publicationState}
          onChange={(changeEvent) =>
            setDraft({
              ...draft,
              publicationState: changeEvent.target.value as PublicationState,
            })
          }
        >
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="published">Published</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={field("tags")}>Tags</label>
        <input
          id={field("tags")}
          value={draft.tags}
          onChange={(changeEvent) => setDraft({ ...draft, tags: changeEvent.target.value })}
          aria-describedby={field("tags-hint")}
        />
        <p className="hint" id={field("tags-hint")}>
          Comma separated.
        </p>
      </div>
      <div className="field">
        <label htmlFor={field("tracks")}>Tracks</label>
        <input
          id={field("tracks")}
          value={draft.tracks}
          onChange={(changeEvent) => setDraft({ ...draft, tracks: changeEvent.target.value })}
          aria-describedby={field("tracks-hint")}
        />
        <p className="hint" id={field("tracks-hint")}>
          Comma separated.
        </p>
      </div>
      <fieldset className="session-editor-wide speaker-checks">
        <legend>Speakers on this session</legend>
        {speakers.length ? (
          speakers.map((speaker) => (
            <label className="check-label" key={speaker.id}>
              <input
                type="checkbox"
                checked={draft.speakerProfileIds.includes(speaker.id)}
                onChange={(changeEvent) =>
                  setDraft({
                    ...draft,
                    speakerProfileIds: changeEvent.target.checked
                      ? [...draft.speakerProfileIds, speaker.id]
                      : draft.speakerProfileIds.filter((id) => id !== speaker.id),
                  })
                }
              />
              <span>
                {speaker.name}
                {speaker.organization ? <small>{speaker.organization}</small> : null}
              </span>
            </label>
          ))
        ) : (
          <p className="hint">No speaker profiles exist for this event yet.</p>
        )}
      </fieldset>
      <div className="session-editor-actions session-editor-wide">
        <button type="submit" aria-disabled={busy}>
          {busy ? "Saving…" : "Save session"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close editor
        </button>
        {dirty ? <span className="hint">Unsaved changes</span> : null}
      </div>
    </form>
  );
}

/* ============================== organizer view ============================== */
