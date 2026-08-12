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

import type { ContentWorkspaceDto } from "@greenroom/contracts";
import { ContentApiError } from "../api/content";
import "../styles/content.css";
import { IconClock } from "../ui/icons";
import { Pill } from "../ui/primitives";

interface Props {
  eventId: string;
  role: "organizer" | "speaker";
}

type Workspace = ContentWorkspaceDto;
type ContentSession = Workspace["sessions"][number];
type SpeakerProfile = Workspace["speakers"][number];
type SpeakerAsset = Workspace["assets"][number];
type PublicationState = ContentSession["publicationState"];

/**
 * Only an image can be a headshot, which is the same rule the server enforces. Checking it
 * here decides whether the control is offered at all, so a speaker is not invited to nominate
 * their slide deck and then told off for it.
 */
function isImageAsset(asset: SpeakerAsset) {
  return asset.contentType.startsWith("image/");
}

/**
 * The one sentence that says what the public will and will not see.
 *
 * Choosing a headshot and publishing it are two decisions held by two people: the speaker
 * picks the picture, an organizer decides whether the file may leave the workspace. A photo
 * that is still private is shown here as chosen but withheld, so nobody believes a face is on
 * the programme when the programme is drawing their initials.
 */
function photoVisibility(asset: SpeakerAsset) {
  return asset.visibility === "publishable"
    ? "It is visible on the published programme."
    : "It is not public yet: the published programme shows initials until an organizer marks this file publishable.";
}

/**
 * The outcome of a mutation. The failure carries the rejection itself so a form can render the
 * server's field-level detail against the input that caused it, not only announce that it failed.
 */
type RunResult = { ok: true } | { ok: false; error: unknown };
type Run = (action: () => Promise<unknown>) => Promise<RunResult>;

/**
 * A refusal, phrased for the person who has to act on it, with the id it is logged under.
 *
 * The failure of an action is announced beside the control that caused it — this workspace no
 * longer hands anything to a page-level surface — so the correlation id has to travel with the
 * sentence, or the operator has nothing to quote when they ask for help.
 */
function withReference(sentence: string, error: unknown) {
  return error instanceof ContentApiError
    ? `${sentence} Reference: ${error.envelope.error.correlationId}`
    : sentence;
}

/** One paragraph per message, tied to its control through aria-describedby. */
function FieldErrors({ id, messages }: { id: string; messages: readonly string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <p className="error-text" id={id}>
      {messages.join(" ")}
    </p>
  );
}

const PUBLICATION_TONE: Record<PublicationState, "neutral" | "info" | "ok"> = {
  draft: "neutral",
  ready: "info",
  published: "ok",
};

const PUBLICATION_LABEL: Record<PublicationState, string> = {
  draft: "Draft",
  ready: "Ready",
  published: "Published",
};

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function plural(count: number, singular: string, many = `${singular}s`) {
  return count === 1 ? singular : many;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function daysUntil(iso: string, now: number) {
  return Math.round((new Date(iso).getTime() - now) / 86_400_000);
}

function dueLabel(days: number) {
  if (days < 0) return `${Math.abs(days)} ${plural(Math.abs(days), "day")} overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} ${plural(days, "day")}`;
}

function DueStatus({ days }: { days: number }) {
  if (days < 0) return <Pill tone="danger">Overdue</Pill>;
  if (days <= 3)
    return (
      <Pill tone="warn">
        <IconClock size={12} />
        Due soon
      </Pill>
    );
  return <Pill tone="info">Open</Pill>;
}

/* ========================= organizer: session editor ========================= */

type SessionDraft = {
  title: string;
  abstract: string;
  format: string;
  tags: string;
  tracks: string;
  speakerProfileIds: string[];
  publicationState: PublicationState;
};

function sessionDraft(session: ContentSession): SessionDraft {
  return {
    title: session.title,
    abstract: session.abstract,
    format: session.format,
    tags: session.tags.join(", "),
    tracks: session.tracks.join(", "),
    speakerProfileIds: session.speakerProfileIds,
    publicationState: session.publicationState,
  };
}

function commaList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type {
  ContentSession,
  Props,
  PublicationState,
  Run,
  RunResult,
  SessionDraft,
  SpeakerAsset,
  SpeakerProfile,
  Workspace,
};
export {
  commaList,
  DueStatus,
  daysUntil,
  dueLabel,
  FieldErrors,
  isImageAsset,
  PUBLICATION_LABEL,
  PUBLICATION_TONE,
  photoVisibility,
  plural,
  sessionDraft,
  shortDate,
  shortDateTime,
  withReference,
};
