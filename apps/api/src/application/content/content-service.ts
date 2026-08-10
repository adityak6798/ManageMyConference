import type {
  AssetVisibility,
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerProfile,
  SpeakerTask,
} from "../../domain/content/content";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";
import {
  type AssetStoragePort,
  ContentConflictError,
  type ContentRepository,
} from "./content-repository";

export interface AcceptContentCommand {
  eventId: string;
  proposalId: string;
  title: string;
  abstract: string;
  format: string;
  tags: string[];
  tracks: string[];
  speakers: { userId: string; sourcePersonId: string; name: string; email: string }[];
}

export interface ContentServiceDependencies {
  repository: ContentRepository;
  assetStorage: AssetStoragePort;
  newId: () => string;
  now: () => Date;
}

function eventRole(actor: Actor, eventId: string) {
  return actor.eventAccess.find((access) => access.eventId === eventId)?.role;
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export class ContentService {
  constructor(private readonly dependencies: ContentServiceDependencies) {}

  async accept(
    actor: Actor | null,
    command: AcceptContentCommand,
    conflictRetries = 2,
  ): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:manage");
    if (eventRole(authorized, command.eventId) !== "organizer")
      throw new CapabilityDeniedError("Organizer event access required");
    const existing = await this.dependencies.repository.findSessionByProposal(
      command.eventId,
      command.proposalId,
    );
    if (!existing) {
      const resolved = await Promise.all(
        command.speakers.map(async (speaker) => {
          const existingProfile = await this.dependencies.repository.findProfileBySource(
            command.eventId,
            speaker.sourcePersonId,
          );
          return {
            isNew: !existingProfile,
            profile: existingProfile ?? {
              id: this.dependencies.newId(),
              eventId: command.eventId,
              userId: speaker.userId,
              sourcePersonId: speaker.sourcePersonId,
              name: speaker.name,
              email: speaker.email,
              bio: "",
              pronouns: "",
              organization: "",
            },
          };
        }),
      );
      const speakers = resolved.map(({ profile }) => profile);
      const session: ContentSession = {
        id: this.dependencies.newId(),
        eventId: command.eventId,
        proposalId: command.proposalId,
        title: command.title,
        abstract: command.abstract,
        format: command.format,
        speakerProfileIds: speakers.map(({ id }) => id),
        tags: command.tags,
        tracks: command.tracks,
        publicationState: "draft",
      };
      const tasks = resolved
        .filter(({ isNew }) => isNew)
        .flatMap<SpeakerTask>(({ profile: speaker }) => [
          {
            id: this.dependencies.newId(),
            eventId: command.eventId,
            speakerProfileId: speaker.id,
            title: "Complete your speaker profile",
            dueAt: this.dependencies.now().toISOString(),
            status: "open",
          },
          {
            id: this.dependencies.newId(),
            eventId: command.eventId,
            speakerProfileId: speaker.id,
            title: "Upload a headshot",
            dueAt: this.dependencies.now().toISOString(),
            status: "open",
          },
        ]);
      try {
        await this.dependencies.repository.accept({
          session,
          speakers: resolved.filter(({ isNew }) => isNew).map(({ profile }) => profile),
          tasks,
          messages: [],
        });
      } catch (error) {
        if (error instanceof ContentConflictError && conflictRetries > 0)
          return this.accept(actor, command, conflictRetries - 1);
        throw error;
      }
    }
    return this.dependencies.repository.workspace(command.eventId);
  }

  async workspace(actor: Actor | null, eventId: string): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:read");
    const role = eventRole(authorized, eventId);
    if (role !== "organizer" && role !== "speaker")
      throw new CapabilityDeniedError("Content workspace access denied");
    return this.dependencies.repository.workspace(
      eventId,
      role === "speaker" ? authorized.id : undefined,
    );
  }

  async updateMyProfile(
    actor: Actor | null,
    profileId: string,
    input: Pick<SpeakerProfile, "name" | "bio" | "pronouns" | "organization">,
  ): Promise<SpeakerProfile> {
    const authorized = requireCapability(actor, "content:read");
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (
      !profile ||
      eventRole(authorized, profile.eventId) !== "speaker" ||
      profile.userId !== authorized.id
    )
      throw new CapabilityDeniedError("Speaker profile access denied");
    const updated = { ...profile, ...input };
    await this.dependencies.repository.updateProfile(updated);
    return updated;
  }

  async completeTask(
    actor: Actor | null,
    taskId: string,
    eventId: string,
  ): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:read");
    if (eventRole(authorized, eventId) !== "speaker")
      throw new CapabilityDeniedError("Speaker task access denied");
    const workspace = await this.dependencies.repository.workspace(eventId, authorized.id);
    const task = workspace.tasks.find(({ id }) => id === taskId);
    if (!task) throw new CapabilityDeniedError("Speaker task access denied");
    await this.dependencies.repository.updateTask({
      ...task,
      status: "complete",
      completedAt: this.dependencies.now().toISOString(),
    });
    return this.workspace(actor, eventId);
  }

  async requestTask(
    actor: Actor | null,
    input: { profileId: string; title: string; dueAt: string },
  ) {
    const authorized = requireCapability(actor, "content:manage");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile || eventRole(authorized, profile.eventId) !== "organizer")
      throw new CapabilityDeniedError("Organizer speaker access denied");
    const task: SpeakerTask = {
      id: this.dependencies.newId(),
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      title: input.title,
      dueAt: input.dueAt,
      status: "open",
    };
    await this.dependencies.repository.addTask(task);
    return task;
  }

  async recordMessage(actor: Actor | null, input: { profileId: string; subject: string }) {
    const authorized = requireCapability(actor, "content:manage");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile || eventRole(authorized, profile.eventId) !== "organizer")
      throw new CapabilityDeniedError("Organizer speaker access denied");
    const message = {
      id: this.dependencies.newId(),
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      subject: input.subject,
      sentAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.addMessage(message);
    return message;
  }

  async upload(
    actor: Actor | null,
    input: {
      profileId: string;
      name: string;
      contentType: string;
      bytes: Uint8Array;
      visibility: AssetVisibility;
    },
  ): Promise<SpeakerAsset> {
    const authorized = requireCapability(actor, "content:read");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (
      !profile ||
      eventRole(authorized, profile.eventId) !== "speaker" ||
      profile.userId !== authorized.id
    )
      throw new CapabilityDeniedError("Speaker asset access denied");
    const id = this.dependencies.newId();
    const key = `${profile.eventId}/${profile.id}/${id}`;
    const stored = await this.dependencies.assetStorage.put({
      key,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    const asset: SpeakerAsset = {
      id,
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      name: input.name,
      contentType: input.contentType,
      storageKey: stored.key,
      visibility: input.visibility,
      uploadedAt: this.dependencies.now().toISOString(),
    };
    try {
      await this.dependencies.repository.addAsset(asset);
    } catch (metadataError) {
      try {
        await this.dependencies.assetStorage.delete(stored.key);
      } catch (cleanupError) {
        throw new AggregateError(
          [metadataError, cleanupError],
          "Asset metadata and R2 cleanup both failed",
        );
      }
      throw metadataError;
    }
    return asset;
  }

  async calendar(actor: Actor | null, eventId: string): Promise<string> {
    const workspace = await this.workspace(actor, eventId);
    const escapeCalendarText = (value: string) =>
      value
        .replaceAll("\\", "\\\\")
        .replaceAll(",", "\\,")
        .replaceAll(";", "\\;")
        .replaceAll("\n", "\\n");
    const date = (value: string) => value.replaceAll(/[-:]/g, "").replace(".000", "");
    const events = workspace.sessions
      .filter((session) => session.schedule)
      .sort((a, b) => a.id.localeCompare(b.id));
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Project Greenroom//Speaker Portal//EN",
      ...events.flatMap((session) => [
        "BEGIN:VEVENT",
        `UID:${session.id}@greenroom`,
        `DTSTART:${date(session.schedule?.startsAt ?? "")}`,
        `DTEND:${date(session.schedule?.endsAt ?? "")}`,
        `SUMMARY:${escapeCalendarText(session.title)}`,
        `LOCATION:${escapeCalendarText(session.schedule?.location ?? "")}`,
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  }
}
